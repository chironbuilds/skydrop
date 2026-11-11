import {
  OotleAccount,
  componentAddressFromWalletAddress,
  configureOotleStorage,
  extractMissingSubstateAddress,
  forgetKnownVersions,
  inMemoryAdapter,
  localStorageAdapter,
  resolveInputsWithRetry,
  toOotleNetwork,
  type NetworkName,
} from "@chironbuilder/ootle-sdk";
import {
  Network,
  TARI_RESOURCE_ADDRESS,
  TransactionBuilder,
  amountLiteral,
  componentAddressLiteral,
  resolveMaxEpoch,
  resourceAddressLiteral,
  sendTransaction,
} from "@tari-project/ootle";
import type { IndexerProvider } from "@tari-project/ootle-indexer";
import { CONFIG, deployed } from "./config";
import { parseOotleAddress } from "@tari-project/ootle-wasm";
import { fromHex, lit, toHex } from "./cbor";
import { decodeB64, Tagged } from "../../web-atproto/src/lib/chain";
import type { ClaimProof } from "./bsky";
import { plcLog } from "./bsky";
import { BOOK_MAX_ADVANCE, opHashHex, signerHints } from "./chainbook";
import * as dagCbor from "@ipld/dag-cbor";
import { pinInput, refusedStale, staleInput, type Wallet } from "./wallet";

const SEED_KEY = "skydrop.seed.v1";

/** Maps config network string to Ootle Network enum, supporting mainnet. */
function configNetwork(): Network {
  if (CONFIG.network === "mainnet") return Network.MainNet;
  return toOotleNetwork(CONFIG.network as NetworkName);
}
/** Maps config network string to SDK NetworkName, supporting mainnet as "esmeralda" fallback for OotleAccount. */
function sdkNetworkName(): NetworkName | "mainnet" {
  return CONFIG.network as NetworkName | "mainnet";
}

/** Browser: persist in localStorage. Anything else (tests): memory. */
export function initStorage(): void {
  configureOotleStorage(typeof localStorage !== "undefined" ? localStorageAdapter("skydrop.sdk.") : inMemoryAdapter());
}

// ---- account (a seed kept in this browser; fine for testnet, export it to keep it) -----------------------

export function savedSeed(): string | null {
  try {
    return localStorage.getItem(SEED_KEY);
  } catch {
    return null;
  }
}

export function createSeed(): string {
  const seed = toHex(crypto.getRandomValues(new Uint8Array(16)));
  saveSeed(seed);
  return seed;
}

export function saveSeed(seedHex: string): void {
  if (!/^[0-9a-f]{32}$/i.test(seedHex)) throw new Error("A recovery key is 32 hexadecimal characters");
  localStorage.setItem(SEED_KEY, seedHex.toLowerCase());
}

export function forgetSeed(): void {
  localStorage.removeItem(SEED_KEY);
}

export function openAccount(seedHex: string): OotleAccount {
  return OotleAccount.fromSeed(fromHex(seedHex), 0, sdkNetworkName() as NetworkName);
}

/**
 * Finds this account's private TARI outputs on-chain and returns their unspent total. Private fees can only spend
 * outputs the SDK has recorded, and a process with in-memory storage starts with none.
 */
export async function scanPrivateTari(account: OotleAccount): Promise<bigint> {
  const full = !scannedOnce.has(account.ledgerId);
  await account.scanForOwnedUtxos(TARI_RESOURCE_ADDRESS, CONFIG.indexer, full ? { maxPages: 200 } : { mode: "delta" });
  scannedOnce.add(account.ledgerId);
  return (await account.listUnspentShieldedOutputs(TARI_RESOURCE_ADDRESS)).reduce((n, o) => n + BigInt(o.amount), 0n);
}
const scannedOnce = new Set<string>();

/** Public plus private TARI: what the built-in wallet can spend. */
export async function totalTari(account: OotleAccount): Promise<bigint> {
  const [pub, priv] = await Promise.all([tariBalance(account), scanPrivateTari(account).catch(() => 0n)]);
  return pub + priv;
}

export async function tariBalance(account: OotleAccount): Promise<bigint> {
  try {
    const all = await account.getBalances();
    return all.find((b) => b.resourceAddress === TARI_RESOURCE_ADDRESS)?.amount ?? 0n;
  } catch {
    return 0n; // an account that has never received funds doesn't exist on-chain yet
  }
}

// ---- reading the contract stack ------------------------------------------------------------------------
//
// Component state arrives as the struct's fields in declaration order. These indexes mirror the templates:
//   Escrow       [vault, badge_vault, policy_badge, min_deposit, admin, policies, next_badge, fee_vault, ledgers,
//                 ledger_badge, ledger_vault, count, size, full_vaults, accounts]
//   ClaimPolicy  [escrow, badge_vault, link_registry, records, record_badge, record_vault, count, size, full_vaults, accounts]
//   LinkRegistry [bind_delay, records, record_badge, record_vault, count, size, full_vaults, accounts]
//   TipPolicy    [escrow, claim_policy, badge_vault, budget_vault, bot_did, budgets, last_tip, link_registry]
//   ClaimPolicyV2 [escrow, badge_vault, link_registry, chain_book, records, record_badge, record_vault, count, size,
//                  full_vaults, accounts]
//   TipPolicyV2  [escrow, claim_policy, badge_vault, budget_vault, bot_did, budgets, last_tip, link_registry, chain_book]
//   ChainBook    [records, record_badge, record_vault, count, size, full_vaults, accounts]
// Each account's data is its own NFT (id sha256 of the DID) in the component's records resource, with the DID as its
// immutable data. Mutable data:
//   Escrow ledger  (deposits, owed); a deposit is (sender, amount, refund epoch, governing policy, metadata, epoch made).
//                  A deposit returned to its sender is governed by the escrow itself.
//   ClaimPolicy    (pending, known_len, claim_text, held, sponsored, delivered)
//   ClaimPolicyV2  (pending, claim_text, held, sponsored, delivered)
//   ChainBook      (hashes 32B each, digests 32B each, signers 1B each, repo key 34B or empty, epochs 8B each)
//   LinkRegistry   (binding, bind proof, last bind rkey, pin = (chain length, tip))
// A record that doesn't exist fails any call that reads it, so a transaction opens missing ones first.

const ESCROW = { feeVault: 7, records: 8, recordBadge: 9, recordVault: 10, fullVaults: 13 } as const;
const CLAIM = { records: 3, recordBadge: 4, recordVault: 5, fullVaults: 8 } as const;
const CLAIM2 = { records: 4, recordBadge: 5, recordVault: 6, fullVaults: 9 } as const;
const BOOK = { records: 0, recordBadge: 1, recordVault: 2, fullVaults: 5 } as const;
const LINK = { records: 1, recordVault: 3, fullVaults: 6 } as const;
const TIP = { budgets: 5 } as const;
type Books = { records: number; recordVault: number; fullVaults: number };

type Cbor = unknown;
const bytesHex = (v: Cbor): string => (v as { hex: string }).hex;

/** A component address as the state stores it, written the way the wallet writes it. */
const addressText = (v: Cbor): string => {
  if (typeof v === "string") return v;
  const tagged = v as { value?: { hex?: string } };
  return `component_${tagged.value?.hex ?? bytesHex(v)}`;
};

function requireDeployed(): void {
  if (!deployed()) throw new ChainError("Skydrop isn't deployed on this network yet.");
}

/** The indexer serves substates as CBOR; the readers below were written against its old JSON shape, so convert to that. */
function legacy(v: unknown): Cbor {
  if (v instanceof Uint8Array) return { hex: toHex(v) };
  if (v instanceof Tagged) return { tag: v.tag, value: legacy(v.value) };
  if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [k instanceof Uint8Array ? toHex(k) : String(k), legacy(x)]));
  if (Array.isArray(v)) return v.map(legacy);
  return v;
}

/** A substate's decoded value, or null if it doesn't exist. */
async function fetchValue(id: string): Promise<unknown[] | null> {
  const r = await fetch(`${CONFIG.indexer}/substates/${id}`, { signal: AbortSignal.timeout(20_000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`The network answered ${r.status}`);
  const up = (await r.json())?.state?.up?.substate;
  return typeof up === "string" ? (decodeB64(up) as unknown[]) : null;
}

/** The inner value of a component, vault or NFT substate. */
const inner = (v: unknown[]): unknown[] => (v[1] as unknown[])[0] as unknown[];

/** The hex of a reference field (resource or vault). */
const refHex = (v: Cbor): string => bytesHex((v as { value: Cbor }).value);

async function stateOf(component: string): Promise<Cbor[]> {
  const v = await fetchValue(component);
  const state = v ? (inner(v)[1] as unknown[] | undefined)?.[0] : undefined;
  if (!Array.isArray(state)) throw new Error("A Skydrop contract could not be read");
  return legacy(state) as Cbor[];
}

const sha256Hex = async (s: string): Promise<string> => toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
const recordAddress = async (resourceHex: string, did: string): Promise<string> => `nft_${resourceHex}_uuid_${await sha256Hex(did)}`;

/** The record resources never change once the components exist. */
type Resources = { escrow: string; claim: string; link: string; claim2: string; chain: string };
let resourcesOnce: Promise<Resources> | null = null;
function recordResources(): Promise<Resources> {
  resourcesOnce ??= Promise.all([stateOf(CONFIG.escrow), stateOf(CONFIG.claim), stateOf(CONFIG.link), stateOf(CONFIG.claim2), stateOf(CONFIG.chainBook)])
    .then(([e, c, l, c2, b]) => ({
      escrow: refHex(e[ESCROW.records]),
      claim: refHex(c[CLAIM.records]),
      link: refHex(l[LINK.records]),
      claim2: refHex(c2[CLAIM2.records]),
      chain: refHex(b[BOOK.records]),
    }))
    .catch((e) => {
      resourcesOnce = null;
      throw e;
    });
  return resourcesOnce;
}

type Book = "escrow" | "claim" | "link" | "claim2" | "chain";

// ---- which ClaimPolicy an account's claim goes through --------------------------------------------------------
//
// Gifts made before v2 stay governed by ClaimPolicy v1, and only v1 can pay them. An account with any of those (or a
// claim in progress under v1) finishes them through v1 first; everything else goes through v2. `readEscrow` decides
// and remembers it here, and every claim-side call below follows it.
const claimVersion = new Map<string, 1 | 2>();
/** The ClaimPolicy component `did`'s claim goes through (v2 unless `readEscrow` found v1 work to finish). */
export const claimComponentFor = (did: string): string => ((claimVersion.get(did) ?? 2) === 1 ? CONFIG.claim : CONFIG.claim2);
const isV2 = (did: string): boolean => (claimVersion.get(did) ?? 2) === 2;
const claimBook = (did: string): Book => (isV2(did) ? "claim2" : "claim");

/** One account's record in `book`, as its mutable fields, or null if it was never opened. */
async function readRecord(book: Book, did: string): Promise<Cbor[] | null> {
  const v = await fetchValue(await recordAddress((await recordResources())[book], did));
  return v ? (legacy(inner(v)[1]) as Cbor[]) : null;
}

/** The NFT ids (hex) a records vault holds. */
async function vaultIds(vaultHex: string): Promise<string[]> {
  const v = await fetchValue(`vault_${vaultHex}`);
  if (!v) return [];
  const ids = ((inner(v)[0] as unknown[])[1] as unknown[])[1] as unknown[] | undefined;
  return (ids ?? []).map((x) => toHex(((x as unknown[])[1] as unknown[])[0] as Uint8Array));
}

/** Every record of a component, by DID. For the relay bot; a page reads one account's records. */
async function allRecords(state: Cbor[], books: Books): Promise<Record<string, Cbor[]>> {
  const resource = refHex(state[books.records]);
  const vaults = [refHex(state[books.recordVault]), ...((state[books.fullVaults] ?? []) as Cbor[]).map(refHex)];
  const ids = (await Promise.all(vaults.map(vaultIds))).flat();
  const out: Record<string, Cbor[]> = {};
  for (let i = 0; i < ids.length; i += 16) {
    await Promise.all(
      ids.slice(i, i + 16).map(async (id) => {
        const v = await fetchValue(`nft_${resource}_uuid_${id}`);
        if (!v) return;
        const [did, data] = inner(v);
        if (typeof did === "string") out[did] = legacy(data) as Cbor[];
      }),
    );
  }
  return out;
}

/** `open_account` calls for whichever of `books` `did` has no record in yet. */
async function openMissing(did: string, books: Book[]): Promise<unknown[]> {
  const component = { escrow: CONFIG.escrow, claim: CONFIG.claim, link: CONFIG.link, claim2: CONFIG.claim2, chain: CONFIG.chainBook };
  const missing = await Promise.all(books.map(async (b) => ((await readRecord(b, did)) ? null : b)));
  return missing.filter((b): b is Book => !!b).map((b) => call(component[b], "open_account", [lit(did)]));
}

/** ClaimPolicy deposit metadata: window (8 BE) ++ hold (8 BE) ++ envelope flag ++ envelope (32, if flagged) ++ phrase. */
export function encodeMetadata(p: { window: number; hold?: number; envelope?: string; challenge?: string }): Uint8Array {
  const u64 = (n: number) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(n));
    return b;
  };
  const envelope = p.envelope ? fromHex(p.envelope) : null;
  if (envelope && envelope.length !== 32) throw new ChainError("An envelope commitment is 32 bytes.");
  const phrase = new TextEncoder().encode(p.challenge ?? "");
  const parts = [u64(p.window), u64(p.hold ?? 0), Uint8Array.of(envelope ? 1 : 0), envelope ?? new Uint8Array(), phrase];
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let at = 0;
  for (const x of parts) {
    out.set(x, at);
    at += x.length;
  }
  return out;
}

export function decodeMetadata(hex: string): { window: number; hold: number; envelope: string; challenge: string } {
  const b = fromHex(hex);
  const u64 = (off: number) => (b.length >= off + 8 ? Number(new DataView(b.buffer, b.byteOffset).getBigUint64(off)) : 0);
  const flag = b[16];
  const start = flag === undefined ? b.length : flag === 1 ? 49 : 17;
  return {
    window: u64(0),
    hold: u64(8),
    envelope: flag === 1 ? toHex(b.slice(17, 49)) : "",
    challenge: new TextDecoder().decode(b.slice(Math.min(start, b.length))),
  };
}

export interface Deposit {
  sender: string;
  amount: bigint;
  refundEpoch: number;
  window: number;
  /** A phrase the claim post must contain for this deposit to pay out. Empty if none. */
  challenge: string;
  /** Epochs the claim post must stay up after the claim starts (0 for none). */
  hold: number;
  /** The epoch the gift was made (recorded by the escrow). A phrase gift nobody answers can be swept back after a while. */
  created: number;
  /** Hash (hex) of the envelope the sender committed to, or empty. */
  envelope: string;
  /** Position in the escrow's list for this account (all policies), which `refund` takes. */
  index: number;
}

/** After this many epochs an unanswered phrase gift can be returned to its sender by anyone. */
export const SWEEP_AFTER_EPOCHS = 72;

export interface Pending {
  claimant: string;
  len: number;
  start: number;
}

export interface Escrow {
  epoch: number;
  /** v1 gifts this account can never collect: v1 verifies at most 16 identity operations and it has more. Their senders
   *  can take them back after the refund date and send them again (they then go through v2). */
  stuckV1: Deposit[];
  /** Which ClaimPolicy this account's claim goes through now (1 until its v1 gifts are done). */
  version: 1 | 2;
  /** Gifts waiting under the other version, after this one's are done (shown, not claimable yet). */
  laterDeposits: Deposit[];
  /** The ClaimPolicy deposits waiting for this account. */
  deposits: Deposit[];
  pending: Pending | null;
  maxWindow: number;
  /** The text of the post the pending claim was proven with. */
  claimText: string;
  /** The Ootle account this Bluesky account has linked, if one is in effect now. Plain gifts go straight to it. */
  binding: string | null;
  /** The claim post's rkey, the epoch it was last proven, and the repo snapshot times (µs) at the start and at the last proof. */
  held: { rkey: string; epoch: number; startRev: number; rev: number } | null;
  /** The owner key (hex) of the linked wallet: the key that signs a decline. */
  bindingOwner: string | null;
  /** A link that has been submitted but has not taken effect yet. */
  bindingPending: { address: string; epoch: number } | null;
}

/** An epoch as real time for hold times: the contract wants the repo snapshots this far apart for each epoch of hold. */
export const EPOCH_MICROS = 3_600_000_000;

function depositOf(d: Cbor[], index: number): Deposit {
  const meta = decodeMetadata(bytesHex(d[4]));
  return {
    sender: bytesHex(d[0]),
    amount: BigInt(d[1] as number),
    refundEpoch: Number(d[2]),
    window: meta.window,
    challenge: meta.challenge,
    hold: meta.hold,
    created: Number(d[5] ?? 0),
    envelope: meta.envelope,
    index,
  };
}

/** The deposits in an escrow ledger governed by `policy` (ClaimPolicy v1 or v2), with their positions in the ledger. */
function claimDeposits(ledger: Cbor[] | null, policy: string): Deposit[] {
  const rows = (ledger?.[0] ?? []) as Cbor[][];
  return rows.map((d, i) => ({ d, i })).filter(({ d }) => addressText(d[3]) === policy).map(({ d, i }) => depositOf(d, i));
}

/** Every deposit waiting under either ClaimPolicy version. */
const allClaimDeposits = (ledger: Cbor[] | null): Deposit[] => [...claimDeposits(ledger, CONFIG.claim), ...claimDeposits(ledger, CONFIG.claim2)];

/** A ClaimPolicy record's fields by version: v1 stores (pending, known_len, text, held, ...), v2 drops known_len. */
const claimFields = (r: Cbor[] | null | undefined, v: 1 | 2) => {
  const o = v === 1 ? 1 : 0;
  return { pending: r?.[0] as Cbor[] | null | undefined, text: r?.[1 + o], held: r?.[2 + o], delivered: (r?.[4 + o] ?? []) as Cbor[][] };
};

/** The most identity operations ClaimPolicy v1 verifies (its MAX_OPS). */
const V1_MAX_OPS = 16;
const opCounts = new Map<string, { n: number; at: number }>();
/** How many operations `did`'s identity history has (cached for ten minutes; it rarely changes). */
async function opCount(did: string): Promise<number> {
  const hit = opCounts.get(did);
  if (hit && Date.now() - hit.at < 600_000) return hit.n;
  const n = (await plcLog(did)).length;
  opCounts.set(did, { n, at: Date.now() });
  return n;
}

export async function readEscrow(provider: IndexerProvider, did: string): Promise<Escrow> {
  requireDeployed();
  const [epoch, ledger, claim1, claim2, link] = await Promise.all([
    provider.getCurrentEpoch(),
    readRecord("escrow", did),
    readRecord("claim", did),
    readRecord("claim2", did),
    readRecord("link", did),
  ]);
  const v1 = claimDeposits(ledger, CONFIG.claim);
  const v2 = claimDeposits(ledger, CONFIG.claim2);
  // Finish v1 work first: its gifts can only be paid through v1, and its claim record holds any claim in progress. An
  // account v1 can't verify (more than 16 identity operations) can never do that, so it goes straight to v2.
  const v1Work = !!(v1.length || claimFields(claim1, 1).pending);
  // If the directory can't be read just now, assume v1 can verify it: the page still works, as it did before v2.
  const v1Blind = v1Work && !claimFields(claim1, 1).pending && (await opCount(did).catch(() => 0)) > V1_MAX_OPS;
  const version: 1 | 2 = v1Work && !v1Blind ? 1 : 2;
  claimVersion.set(did, version);
  const f = version === 1 ? claimFields(claim1, 1) : claimFields(claim2, 2);
  const pend = f.pending;
  const binding = (link?.[0] ?? null) as Cbor[] | null;
  return {
    epoch,
    version,
    stuckV1: v1Blind ? v1 : [],
    laterDeposits: version === 1 ? v2 : [],
    maxWindow: CONFIG.maxWindow,
    deposits: version === 1 ? v1 : v2,
    pending: pend ? { claimant: bytesHex(pend[0]), start: Number(pend[1]), len: Number(pend[3]) } : null,
    claimText: String(f.text ?? ""),
    binding: bindingOf(binding, epoch),
    bindingOwner: bindingOwnerOf(binding, epoch),
    bindingPending: pendingBindingOf(binding, epoch),
    held: heldOf(f.held),
  };
}

/** ClaimPolicy held: [rkey of the claim post, epoch it was last proven, snapshot µs at the start, latest snapshot µs]. */
function heldOf(h: Cbor): { rkey: string; epoch: number; startRev: number; rev: number } | null {
  const t = h as Cbor[] | null | undefined;
  return t ? { rkey: String(t[0]), epoch: Number(t[1]), startRev: Number(t[2]), rev: Number(t[3]) } : null;
}

// LinkRegistry binding: [account, epoch it takes effect, the account it replaces (the registry itself for a first
// link), owner key of the new binding, owner key of the one it replaces].

function bindingOf(b: Cbor[] | null, epoch: number): string | null {
  if (!b) return null;
  if (epoch >= Number(b[1])) return addressText(b[0]);
  // before it takes effect, a replaced binding still applies; a first one (which "replaces" the registry) means nothing yet
  const old = addressText(b[2]);
  return old === CONFIG.link ? null : old;
}

function bindingOwnerOf(b: Cbor[] | null, epoch: number): string | null {
  if (!b) return null;
  if (epoch >= Number(b[1])) return bytesHex(b[3]);
  return addressText(b[2]) === CONFIG.link ? null : bytesHex(b[4]);
}

function pendingBindingOf(b: Cbor[] | null, epoch: number): { address: string; epoch: number } | null {
  return b && epoch < Number(b[1]) ? { address: addressText(b[0]), epoch: Number(b[1]) } : null;
}

/** Everything the relay bot watches, read in one pass. */
export interface StackSnapshot {
  epoch: number;
  /** ClaimPolicy deposits waiting, per account. */
  deposits: Record<string, Deposit[]>;
  /** Claims in progress: who claims, the epoch it started, and the operation chain (tip hash, length) it relied on. */
  pending: Record<string, { claimant: string; start: number; tipHex: string; len: number }>;
  /** Gifts delivered straight to linked wallets. */
  delivered: Record<string, { sender: string; amount: bigint; epoch: number }[]>;
  /** Links: the epoch each takes effect, and the operation chain it relied on. */
  bindings: Record<string, { effective: number; tipHex: string | null; len: number }>;
  /** The longest operation chain the registry has seen per account (every policy's floor). */
  chainFloor: Record<string, number>;
  /** Accounts with a tip budget. */
  budgetDids: string[];
}

export async function readStack(provider: IndexerProvider): Promise<StackSnapshot> {
  requireDeployed();
  const [epoch, escrowState, claimState, claim2State, linkState, tip, tip2] = await Promise.all([
    provider.getCurrentEpoch(),
    stateOf(CONFIG.escrow),
    stateOf(CONFIG.claim),
    stateOf(CONFIG.claim2),
    stateOf(CONFIG.link),
    stateOf(CONFIG.tip),
    stateOf(CONFIG.tip2),
  ]);
  const [ledgers, claims, claims2, links] = await Promise.all([
    allRecords(escrowState, ESCROW),
    allRecords(claimState, CLAIM),
    allRecords(claim2State, CLAIM2),
    allRecords(linkState, LINK),
  ]);
  const deposits: StackSnapshot["deposits"] = {};
  for (const [did, ledger] of Object.entries(ledgers)) {
    const list = allClaimDeposits(ledger);
    if (list.length) deposits[did] = list;
  }
  const pending: StackSnapshot["pending"] = {};
  const delivered: StackSnapshot["delivered"] = {};
  for (const [v, records] of [[1, claims], [2, claims2]] as const) {
    for (const [did, r] of Object.entries(records)) {
      const f = claimFields(r, v);
      const p = f.pending;
      if (p) pending[did] = { claimant: bytesHex(p[0]), start: Number(p[1]), tipHex: bytesHex(p[2]), len: Number(p[3]) };
      if (f.delivered.length) delivered[did] = [...(delivered[did] ?? []), ...f.delivered.map((d) => ({ sender: bytesHex(d[0]), amount: BigInt(d[1] as number), epoch: Number(d[2]) }))];
    }
  }
  const bindings: StackSnapshot["bindings"] = {};
  const chainFloor: StackSnapshot["chainFloor"] = {};
  for (const [did, r] of Object.entries(links)) {
    const b = r[0] as Cbor[] | null;
    const pr = r[1] as Cbor[] | null;
    if (b) bindings[did] = { effective: Number(b[1]), tipHex: pr ? bytesHex(pr[0]) : null, len: pr ? Number(pr[1]) : 0 };
    const pin = r[3] as Cbor[] | undefined;
    if (pin && Number(pin[0])) chainFloor[did] = Number(pin[0]);
  }
  const budgetKeys = [...Object.keys((tip[TIP.budgets] ?? {}) as Record<string, unknown>), ...Object.keys((tip2[TIP.budgets] ?? {}) as Record<string, unknown>)];
  const budgetDids = [...new Set(budgetKeys.map((k) => k.slice(0, k.lastIndexOf(":"))))];
  return { epoch, deposits, pending, delivered, bindings, chainFloor, budgetDids };
}

/** The account `did` has linked, if any. */
export async function readBinding(provider: IndexerProvider, did: string): Promise<string | null> {
  requireDeployed();
  const [epoch, link] = await Promise.all([provider.getCurrentEpoch(), readRecord("link", did)]);
  return bindingOf((link?.[0] ?? null) as Cbor[] | null, epoch);
}

/** The most identity operations the LinkRegistry verifies (it predates the ChainBook and keeps v1's limit). */
const LINK_MAX_OPS = 16;
const LINK_TOO_LONG = "Linking a wallet isn't available yet for accounts with more than 16 identity operations (the link registry's limit). You can still collect gifts and rewards with a claim post.";

/** Links the Bluesky account in `proof` to `address`: the proof is a post that carries the bind code for that address. */
export async function bindAccount(wallet: Wallet, proof: ClaimProof, address: string, owner: Uint8Array, onStage?: (s: string) => void): Promise<TxOutcome> {
  if (proof.ops.length > LINK_MAX_OPS) throw new ChainError(LINK_TOO_LONG);
  const instructions = [
    ...(await openMissing(proof.did, ["link"])),
    call(CONFIG.link, "bind", [lit(proof.did), componentAddressLiteral(address as never), lit(owner), lit(proof.ops), lit(proof.commit), lit(proof.nodes), lit(proof.record), lit(proof.rkey)]),
  ];
  return run(wallet, instructions, 120_000n, onStage, false, await linkRelated(proof.did, [address]));
}

/** What is payable right now to a claim that started at `start` (mirrors ClaimPolicy's `payable`). */
export function payableNow(e: Escrow, start: number): { amount: bigint; waitingAmount: bigint; nextEpoch: number | null; missing: string[]; holding: bigint; confirmAt: number | null; needLink: bigint } {
  let amount = 0n;
  let waitingAmount = 0n;
  let next: number | null = null;
  let holding = 0n;
  let confirmAt: number | null = null;
  const seen = e.held?.epoch ?? start;
  const missing = new Set<string>();
  for (const d of e.deposits) {
    const ready = start + d.window;
    if (!metadataInRange(d)) continue; // never pays; anyone can sweep it back to its sender
    if (d.challenge && !e.claimText.includes(d.challenge)) {
      // pays only once the claim post says it; the claimant has to post again
      missing.add(d.challenge);
    } else if (d.hold && (seen < start + d.hold || (e.held ? e.held.rev - e.held.startRev : 0) < d.hold * EPOCH_MICROS)) {
      // the post has to be proven to still be up once the hold time has passed
      holding += d.amount;
      confirmAt = confirmAt === null ? start + d.hold : Math.min(confirmAt, start + d.hold);
    } else if (e.epoch >= ready) amount += d.amount;
    else {
      waitingAmount += d.amount;
      next = next === null ? ready : Math.min(next, ready);
    }
  }
  return { amount, waitingAmount, nextEpoch: next, missing: [...missing], holding, confirmAt, needLink: 0n };
}

const metadataInRange = (d: Deposit): boolean =>
  d.window <= CONFIG.maxWindow && d.hold <= CONFIG.maxHold && new TextEncoder().encode(d.challenge).length <= CONFIG.maxChallenge;

/** TARI left in the escrow's vault that pays claimants' network fees. */
export async function readSponsorBalance(provider: IndexerProvider): Promise<bigint> {
  try {
    const state = await stateOf(CONFIG.escrow);
    const v = await fetchValue(`vault_${refHex(state[ESCROW.feeVault])}`);
    if (!v) return 0n;
    const container = inner(v)[0] as unknown[];
    return BigInt((container[1] as unknown[])[1] as number | bigint);
  } catch {
    return 0n;
  }
}

export const total = (ds: Deposit[]): bigint => ds.reduce((n, d) => n + d.amount, 0n);

// ---- transactions -------------------------------------------------------------------------------------------

export class ChainError extends Error {}

/** A fee-only rejection prints `[stateDiff, reason]`; the diff is huge and hides the reason, so keep only the reason. */
function rejectReason(m: string): string {
  const i = m.indexOf("rejected the rest: ");
  if (i < 0) return m;
  const head = m.slice(0, i) + "rejected the rest: ";
  try {
    const parts = JSON.parse(m.slice(i + 19)) as unknown[];
    const r = parts[parts.length - 1];
    return head + (typeof r === "string" ? r : JSON.stringify(r));
  } catch {
    // truncated or not JSON: the reason is usually the tail
    return head + m.slice(-300);
  }
}

/** Turns the engine's raw rejection text into something a person can act on. */
export function friendly(e: unknown): string {
  const m = rejectReason(e instanceof Error ? e.message : String(e));
  const rules: [RegExp, string][] = [
    [/isn't deployed on this network/i, "Skydrop isn't running on this network yet. Check back soon."],
    [/does not contain the claim code/i, "Your post doesn't contain the claim code. Post the exact text shown, then try again."],
    [/invalid repo proof/i, "The signed copy of your post didn't verify. Wait a few seconds after posting and try again."],
    [/invalid operation chain/i, "Your account's identity history didn't verify."],
    [/stale operation chain/i, "A newer version of this account's identity history exists. Refresh and try again."],
    [/no deposits for this account under this policy|no pending claim/i, "Nothing is waiting for this account."],
    [/window is still open|nothing payable yet|nothing is payable yet/i, "The network hasn't caught up to your claim yet. Wait a minute and press Collect again."],
    [/not enough|insufficient/i, `This wallet doesn't have enough ${CONFIG.symbol} to cover the amount plus network fees.`],
    [/already claimed/i, "This wallet already used the faucet."],
    [/deposit below the minimum/i, `The smallest amount you can send is ${Number(CONFIG.minDeposit) / Number(CONFIG.unit)} ${CONFIG.symbol}.`],
    [/required phrase was not posted/i, "The challenge phrase wasn't in your claim post. Post it together with the claim code and try again."],
    [/not the post the claim was made with/i, "That isn't the post you claimed with. Keep the original post up and try again."],
    [/too many deposits/i, "This account has too many gifts waiting right now. Try again later."],
    [/link your wallet first, then you can decline/i, "Link your wallet first, then you can decline gifts."],
    [/account is not linked/i, "This account hasn't linked a wallet."],
    [/only a standard Tari account can be linked/i, "That address isn't an ordinary Tari wallet account, so it can't be linked."],
    [/nothing has expired/i, "Nothing has expired yet. Unanswered phrase gifts can be returned after about three days."],
    [/a claim for this account is in progress/i, "A claim for this account is in progress, so nothing can be returned right now."],
    [/nothing has been returned to you/i, "Nothing has been returned to you."],
    [/older than one already proven/i, "Bluesky gave an older snapshot of your account than one already proven. Wait a moment and try again."],
    [/escrow is too small to cover more sponsored fees/i, `This gift is too small to cover more free network fees. Your wallet needs a little ${CONFIG.symbol} for the fee.`],
    [/already used to bind/i, "That link post was already used. Make a new post to link again."],
    [/no such deposit/i, "That gift is no longer there. It may already have been collected, declined or returned."],
    [/no deposits for this account/i, "Nothing is waiting for this account any more."],
    [/not refundable yet/i, "This gift can't be taken back yet. Check Your sends for when."],
    [/already in effect/i, "That link is already in effect."],
    [/has used its sponsored/i, `The free network fees for this account have been used. Your wallet needs a little ${CONFIG.symbol} for the fee.`],
    [/identity chain isn't recorded yet/i, "This account's identity history isn't on-chain yet. Try again: it's recorded as part of the claim."],
    [/newer identity chain has been seen/i, "This account changed its identity (a key or handle) since it was recorded on-chain. Try again: the change is recorded first."],
    [/has no repo key/i, "This account has been deleted or has no signing key, so its posts can't be verified."],
    [/differs from the directory's/i, "This account's identity history on-chain differs from Bluesky's directory (an undone change). It needs the account's recovery key to fix."],
    [/isn't the recorded operation|nothing is recorded before genesis/i, "Someone else updated this account's on-chain history at the same moment. Try again."],
    [/that is the chain the claim already relies on/i, "Nothing has changed in this account's identity, so the claim can't be challenged."],
    [/needs recording first/i, "This account's identity history has to be recorded on-chain first."],
    [/too many blocks/i, "This account's identity history is too long for the contract these gifts were sent with."],
    [/Timed out/i, "The network is slow right now. Please try again."],
  ];
  for (const [re, text] of rules) if (re.test(m)) return text;
  return m.length > 400 ? `${m.slice(0, 400)}…` : m;
}

/** The contract refused a payout because, as far as the checking node knows, the safety window is still open. */
export const isWindowOpen = (e: unknown): boolean => /window is still open|nothing payable yet|nothing is payable yet/i.test(e instanceof Error ? e.message : String(e));

function assertAccepted(dry: unknown): void {
  const result = (dry as { result?: { finalize?: { result?: unknown } } })?.result?.finalize?.result;
  const text = JSON.stringify(result ?? dry);
  if (/Reject/.test(text)) {
    const reason = text.match(/"Reject":(\{.*?\}|"[^"]*")/)?.[0] ?? text;
    throw new ChainError(reason.slice(0, 400));
  }
}

const call = (component: string, method: string, args: unknown[]) => ({
  CallMethod: { call: { Address: component }, method, args },
});
const toWorkspace = { PutLastInstructionOutputOnWorkspace: { key: 0 } };
const workspace0 = { Workspace: { id: 0, offset: null } };

export interface TxOutcome {
  transactionId: string;
}

/** The version the indexer reports for a substate now, or null if it can't say. */
async function latestVersion(id: string): Promise<number | null> {
  try {
    const r = await fetch(`${CONFIG.indexer}/substates/${id}`, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return null;
    const v = (await r.json())?.version;
    return typeof v === "number" ? v : null;
  } catch {
    return null;
  }
}

/**
 * Pins every input to the version the indexer reports now. Left unpinned, the SDK fills a version in from its own cache
 * of what this browser's past transactions saw, which goes stale as soon as anyone else's transaction moves a shared
 * substate on (a registry's records resource changes whenever any account opens a record): the send is then refused
 * with "Input substate X (vN) is down", every time. The SDK only uses its cache over a pinned version that's older.
 */
async function pinLatest(ids: string[]): Promise<string[]> {
  return Promise.all(ids.map(async (s) => {
    if (s.includes("@")) return s;
    const v = await latestVersion(s);
    return v === null ? s : `${s}@${v}`;
  }));
}

/** After "X (vN) is down": forget the SDK's cached version of X and pin the newest the indexer knows (at least N+1). */
async function repin(inputs: string[], stale: { id: string; next: number }): Promise<string[]> {
  await forgetKnownVersions([stale.id], configNetwork()).catch(() => undefined);
  return pinInput(inputs, stale.id, Math.max(stale.next, (await latestVersion(stale.id)) ?? 0));
}

async function run(
  wallet: Wallet,
  instructions: unknown[],
  maxFee: bigint,
  onStage?: (s: string) => void,
  tolerateEpochLag = false,
  related: string[] = [],
): Promise<TxOutcome> {
  requireDeployed();
  onStage?.("Checking it works…");
  // A failed real transaction still pays its whole fee, so every input it needs is found by dry runs first and the
  // real send carries exactly that list.
  let inputs = await pinLatest([...new Set(related)]);
  for (let i = 0; ; i++) {
    try {
      assertAccepted(await wallet.execute(instructions, { dryRun: true, maxFee, inputs }));
      break;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Another transaction spent an input since we read it: ask for the next version, not the indexer's lagging one.
      const stale = staleInput(msg);
      if (stale && i < 16) {
        inputs = await repin(inputs, stale);
        continue;
      }
      const missing = extractMissingSubstateAddress(msg);
      if (missing && !inputs.includes(missing) && i < 16) {
        inputs.push(missing);
        continue;
      }
      // The pre-check runs against the previous epoch, so it can call a payout "too early" that the real
      // transaction (executed in the current epoch) accepts. Only for payouts the caller already knows are due.
      if (!tolerateEpochLag || !isWindowOpen(e)) throw e;
      onStage?.("The pre-check is one epoch behind. Sending anyway…");
      break;
    }
  }
  onStage?.("Sending to the network…");
  // Another transaction can update an input between the check and the send (a record or resource changing): the
  // indexer refuses the send before broadcasting it, nothing is charged, and it's sent again with the newer version.
  let res: { transaction_id?: unknown; transactionId?: unknown };
  for (let i = 0; ; i++) {
    try {
      res = (await wallet.execute(instructions, { maxFee, inputs })) as typeof res;
      break;
    } catch (e) {
      const stale = refusedStale(e);
      if (!stale || i >= 4) throw e;
      inputs = await repin(inputs, stale);
      onStage?.("Something changed on the network a moment ago. Sending again…");
    }
  }
  assertAccepted(res);
  return { transactionId: String(res.transaction_id ?? res.transactionId ?? "") };
}

/** Submits someone else's ready-made instructions (a campaign's linked claim), the relay wallet paying the fee. */
export async function relayInstructions(wallet: Wallet, instructions: unknown[], inputs: string[], maxFee: bigint, onStage?: (s: string) => void): Promise<TxOutcome> {
  return run(wallet, instructions, maxFee, onStage, false, inputs);
}

/**
 * Sends a gift. To an account that has linked a wallet, a plain gift (no window, phrase, hold or envelope) is
 * delivered straight to that wallet; anything else is escrowed under ClaimPolicy until the owner claims it.
 */
export async function sendTip(
  wallet: Wallet,
  p: { did: string; amount: bigint; window: number; challenge?: string; hold?: number; envelope?: string },
  epoch: number,
  linked: boolean,
  onStage?: (s: string) => void,
): Promise<TxOutcome> {
  const pk = wallet.publicKey;
  const plain = !p.window && !p.challenge && !p.hold && !p.envelope;
  const direct = linked && plain;
  const open = await openMissing(p.did, direct ? ["claim2"] : ["escrow"]);
  const give =
    direct
      ? call(CONFIG.claim2, "pay_linked", [lit(p.did), lit(pk), fundsBucket])
      : call(CONFIG.escrow, "deposit", [
          lit(p.did),
          lit(pk),
          lit(epoch + CONFIG.refundAfterEpochs),
          componentAddressLiteral(CONFIG.claim2 as never),
          lit(encodeMetadata({ window: p.window, hold: p.hold, envelope: p.envelope, challenge: p.challenge })),
          fundsBucket,
        ]);
  const related = direct ? await directRelated(p.did, epoch) : await depositRelated(p.did);
  return runFunded(wallet, p.amount, [...open, give], related, 30_000n, onStage);
}

/** Where a funded call finds the TARI it was given: the wallet's funded-call path leaves it at workspace id 1. */
const fundsBucket = { Workspace: { id: 1, offset: null } };

/** The resource a vault holds (badge resources are only named in their vaults). */
async function vaultResource(vaultHex: string): Promise<string> {
  const v = await fetchValue(`vault_${vaultHex}`);
  if (!v) throw new Error("A Skydrop vault could not be read");
  const r = ((inner(v)[0] as unknown[])[1] as unknown[])[0];
  return `resource_${toHex((r instanceof Tagged ? r.value : r) as Uint8Array)}`;
}

/** Everything an escrow deposit for `did` touches besides the escrow's own vaults. */
async function depositRelated(did: string): Promise<string[]> {
  const [res, escrow] = await Promise.all([recordResources(), stateOf(CONFIG.escrow)]);
  const ledger = await recordAddress(res.escrow, did);
  const [badge, exists] = await Promise.all([vaultResource(refHex(escrow[ESCROW.recordBadge])), fetchValue(ledger)]);
  return [CONFIG.escrow, CONFIG.claim2, `resource_${res.escrow}`, badge, ...(exists ? [ledger] : [])];
}

/** ClaimPolicy's badge_vault (its PolicyBadge, shown to the escrow) and LinkRegistry's record_badge field indexes. */
const CLAIM_POLICY_BADGE = 1;
const LINK_RECORD_BADGE = 2;
/** The escrow's main vault, holding every gift. */
const ESCROW_VAULT = 0;

/**
 * Everything a claim-side call for `did` can touch across ClaimPolicy, the escrow and the registry: the three
 * components, their record resources, the badges they present to each other, and `did`'s existing records.
 * Resources and NFTs aren't found by the engine on its own, so a cross-template call without them fails NotFound.
 */
export async function claimRelated(did: string): Promise<string[]> {
  const v2 = isV2(did);
  const claimC = v2 ? CONFIG.claim2 : CONFIG.claim;
  const [res, escrow, claim, link, book] = await Promise.all([recordResources(), stateOf(CONFIG.escrow), stateOf(claimC), stateOf(CONFIG.link), v2 ? stateOf(CONFIG.chainBook) : Promise.resolve(null)]);
  const C = v2 ? CLAIM2 : CLAIM;
  const badgeVaults = [claim[CLAIM_POLICY_BADGE], claim[C.recordBadge], escrow[ESCROW.recordBadge], link[LINK_RECORD_BADGE], ...(book ? [book[BOOK.recordBadge]] : [])];
  const books = (v2 ? ["escrow", "claim2", "link", "chain"] : ["escrow", "claim", "link"]) as Book[];
  const [badges, records] = await Promise.all([
    Promise.all(badgeVaults.map((v) => vaultResource(refHex(v)))),
    Promise.all(books.map(async (b) => {
      const a = await recordAddress(res[b], did);
      return (await fetchValue(a)) ? a : null;
    })),
  ]);
  // Vaults aren't found on their own either: the badge vaults, the escrow's gift and fee vaults, and the vault a new
  // record is minted into, only where `did` has no record yet. Every claim that lists a vault locks it, so a vault
  // nothing writes stays out: listing them all made unrelated claims (and the bot) collide on stale versions.
  const mintVault: Partial<Record<Book, Cbor>> = { escrow: escrow[ESCROW.recordVault], [v2 ? "claim2" : "claim"]: claim[C.recordVault], link: link[LINK.recordVault], ...(book ? { chain: book[BOOK.recordVault] } : {}) };
  const vaults = [
    ...badgeVaults.map(refHex),
    refHex(escrow[ESCROW_VAULT]), refHex(escrow[ESCROW.feeVault]),
    ...books.filter((_, i) => !records[i]).map((b) => refHex(mintVault[b]!)),
  ].map((h) => `vault_${h}`);
  // One list with no duplicates: a duplicate input makes the transaction unparseable.
  return [...new Set([
    CONFIG.escrow, claimC, CONFIG.link, ...(v2 ? [CONFIG.chainBook] : []),
    `resource_${res.escrow}`, `resource_${v2 ? res.claim2 : res.claim}`, `resource_${res.link}`, ...(v2 ? [`resource_${res.chain}`] : []),
    ...new Set([...badges, ...vaults]),
    ...records.filter((a): a is string => !!a),
  ])];
}

/**
 * What linking (or showing the registry a newer chain) touches: the registry, its record resource, the badge it updates
 * records with, and `did`'s record (or the vault a new one is minted into). Nothing else: listing a substate other
 * transactions keep changing (the escrow's fee vault, say) only gets a link refused for a version it never needed.
 */
async function linkRelated(did: string, extra: string[] = []): Promise<string[]> {
  const [res, link] = await Promise.all([recordResources(), stateOf(CONFIG.link)]);
  const badgeVault = refHex(link[LINK_RECORD_BADGE]);
  const record = await recordAddress(res.link, did);
  const exists = await fetchValue(record);
  return [...new Set([CONFIG.link, `resource_${res.link}`, `vault_${badgeVault}`, await vaultResource(badgeVault), exists ? record : `vault_${refHex(link[LINK.recordVault])}`, ...extra])];
}

/** What recording into the ChainBook touches: the book, its record resource and badge, and `did`'s record (or mint vault). */
async function bookRelated(did: string): Promise<string[]> {
  const [res, book] = await Promise.all([recordResources(), stateOf(CONFIG.chainBook)]);
  const badgeVault = refHex(book[BOOK.recordBadge]);
  const record = await recordAddress(res.chain, did);
  const exists = await fetchValue(record);
  return [...new Set([CONFIG.chainBook, `resource_${res.chain}`, `vault_${badgeVault}`, await vaultResource(badgeVault), exists ? record : `vault_${refHex(book[BOOK.recordVault])}`])];
}

/** Everything a direct delivery to `did`'s linked wallet touches. */
async function directRelated(did: string, epoch: number): Promise<string[]> {
  const [res, claim] = await Promise.all([recordResources(), stateOf(CONFIG.claim2)]);
  const [claimRecord, linkRecord] = await Promise.all([recordAddress(res.claim2, did), recordAddress(res.link, did)]);
  const [badge, claimExists, link] = await Promise.all([vaultResource(refHex(claim[CLAIM2.recordBadge])), fetchValue(claimRecord), readRecord("link", did)]);
  const to = bindingOf((link?.[0] ?? null) as Cbor[] | null, epoch);
  return [CONFIG.claim2, CONFIG.link, `resource_${res.claim2}`, badge, linkRecord, ...(claimExists ? [claimRecord] : []), ...(to ? [to] : [])];
}

// ---- recording identity chains in the ChainBook (v2) -----------------------------------------------------------

/** The operations of `did`'s identity history the ChainBook hasn't recorded yet, and the calls that record them. */
export async function bookSteps(did: string): Promise<{ missing: number; instructions: unknown[] }> {
  const [log, rec] = await Promise.all([plcLog(did), readRecord("chain", did)]);
  const n = rec ? (bytesHex(rec[2]) ?? "").length / 2 : 0;
  if (n > log.length) throw new ChainError("The identity history recorded on-chain is longer than the one the directory shows. Try again later.");
  if (n > 0) {
    // The book must hold the directory's history so far; a different branch can't be extended (only replaced by PLC's rules).
    const recorded = bytesHex(rec![0]).slice(64 * (n - 1), 64 * n);
    if ((await opHashHex(log[n - 1]!)) !== recorded) throw new ChainError("This account's identity history recorded on-chain differs from the directory's. It can't be extended until that's resolved.");
  }
  const open = rec ? [] : [call(CONFIG.chainBook, "open_account", [lit(did)])];
  if (n >= log.length) return { missing: 0, instructions: open };
  const hints = signerHints(log);
  const enc = log.map((o) => dagCbor.encode(o));
  const steps: unknown[] = [...open];
  for (let at = n; at < log.length; at += BOOK_MAX_ADVANCE) {
    const end = Math.min(log.length, at + BOOK_MAX_ADVANCE);
    steps.push(call(CONFIG.chainBook, "advance", [lit(did), lit(at === 0 ? null : enc[at - 1]!), lit(enc.slice(at, end)), lit(Uint8Array.from(hints.slice(at, end)))]));
  }
  return { missing: log.length - n, instructions: steps };
}

/**
 * Operations a sponsored (fee-phase) claim can record itself. The fee phase has 32M points of compute credit; one
 * operation is ~8M and the claim ~10-15M, so two would leave too little room. More must be recorded beforehand.
 */
export const FEE_PHASE_BOOK_OPS = 1;
/** Operations a paid claim records in its own transaction; more are recorded first, in transactions of their own. */
export const INLINE_BOOK_OPS = 12;
/** What recording one operation can cost in fees (uT): ~8M points is ~0.008 TARI, with room to spare. */
const FEE_PER_BOOK_OP = 9_000n;

/**
 * Records the rest of `did`'s identity history in the ChainBook, paid by `wallet`: up to 24 operations a transaction
 * (one transaction may use at most 250M points; 24 operations measured 171M), each sent once the last has landed.
 */
export async function recordChain(wallet: Wallet, did: string, onStage?: (s: string) => void): Promise<TxOutcome | null> {
  let last: TxOutcome | null = null;
  for (let round = 0; round < 50; round++) {
    const { missing, instructions } = await bookSteps(did);
    if (!instructions.length) return last;
    // An open (if needed) and the first `advance`: the next chunk names this one's last operation, so it waits.
    const first = instructions.slice(0, (instructions[0] as { CallMethod: { method: string } }).CallMethod.method === "open_account" ? 2 : 1);
    const ops = Math.min(missing, BOOK_MAX_ADVANCE);
    onStage?.(`Recording your account's identity history on-chain (${ops} of ${missing} operations)`);
    last = await run(wallet, first, 20_000n + FEE_PER_BOOK_OP * BigInt(ops), onStage, false, await bookRelated(did));
    // Wait for the indexer to show it before working out the next chunk from it.
    for (let i = 0; i < 15 && (await bookSteps(did)).missing === missing; i++) await new Promise((r) => setTimeout(r, 2_000));
  }
  return last;
}

/**
 * The calls that bring the book up to date before a v2 call for `did` (none for v1), and what they add to the fee. A
 * long history is recorded first in transactions of its own (paid by `wallet`), so the call itself stays small.
 */
async function bookFirst(wallet: Wallet, did: string, onStage?: (s: string) => void): Promise<{ steps: unknown[]; fee: bigint }> {
  if (!isV2(did)) return { steps: [], fee: 0n };
  const { missing, instructions } = await bookSteps(did);
  if (missing > INLINE_BOOK_OPS) {
    await recordChain(wallet, did, onStage);
    return { steps: [], fee: 0n };
  }
  return { steps: instructions, fee: FEE_PER_BOOK_OP * BigInt(missing) };
}

/** v1 calls carry the identity chain; v2 calls read it from the ChainBook instead. */
const chainArg = (did: string, ops: Uint8Array[]): unknown[] => (isV2(did) ? [] : [lit(ops)]);

/** Like `run`, for a transaction that spends `amount` of the wallet's TARI. */
async function runFunded(wallet: Wallet, amount: bigint, followUp: unknown[], related: string[], maxFee: bigint, onStage?: (s: string) => void): Promise<TxOutcome> {
  requireDeployed();
  onStage?.("Checking it works…");
  assertAccepted(await wallet.executeFunded(amount, followUp, related, { maxFee, dryRun: true }));
  onStage?.("Sending to the network…");
  const res = (await wallet.executeFunded(amount, followUp, related, { maxFee })) as { transaction_id?: unknown; transactionId?: unknown };
  assertAccepted(res);
  return { transactionId: String(res.transactionId ?? res.transaction_id ?? "") };
}

export async function startClaim(wallet: Wallet, proof: ClaimProof, onStage?: (s: string) => void): Promise<TxOutcome> {
  const pk = wallet.publicKey;
  const did = proof.did;
  const book = await bookFirst(wallet, did, onStage);
  const instructions = [
    ...(await openMissing(did, [claimBook(did), "link"])),
    ...book.steps,
    call(claimComponentFor(did), "start_claim", [lit(did), lit(pk), ...chainArg(did, proof.ops), lit(proof.commit), lit(proof.nodes), lit(proof.record), lit(proof.rkey)]),
  ];
  return run(wallet, instructions, 120_000n + book.fee, onStage, false, await claimRelated(did));
}

/**
 * Starts a claim for an account that has linked a wallet: the post needs no claim code (any new post — e.g. one
 * that just says the sender's phrase), because the payout can only go to the linked wallet. Anyone may submit it.
 */
export async function startLinkedClaim(wallet: Wallet, proof: ClaimProof, onStage?: (s: string) => void): Promise<TxOutcome> {
  const did = proof.did;
  const book = await bookFirst(wallet, did, onStage);
  const instructions = [
    ...(await openMissing(did, [claimBook(did)])),
    ...book.steps,
    call(claimComponentFor(did), "start_linked_claim", [lit(did), ...chainArg(did, proof.ops), lit(proof.commit), lit(proof.nodes), lit(proof.record), lit(proof.rkey)]),
  ];
  return run(wallet, instructions, 120_000n + book.fee, onStage, false, await claimRelated(proof.did));
}

/** Pays a linked account's payable gifts into its linked wallet. Anyone may call it: the destination is fixed. */
export async function finalizeToLinked(wallet: Wallet, did: string, onStage?: (s: string) => void, payableByEpoch = false): Promise<TxOutcome> {
  return run(wallet, [call(claimComponentFor(did), "finalize_to_linked", [lit(did)])], 60_000n, onStage, payableByEpoch, await claimRelated(did));
}

export async function finalizeClaim(wallet: Wallet, did: string, onStage?: (s: string) => void, payableByEpoch = false): Promise<TxOutcome> {
  const owner = wallet.componentAddress;
  const instructions = [call(claimComponentFor(did), "finalize_claim", [lit(did)]), toWorkspace, call(owner, "deposit", [workspace0])];
  return run(wallet, instructions, 30_000n, onStage, payableByEpoch, await claimRelated(did));
}

/** The owner key inside a wallet address (otl_…). */
export const ownerOf = (walletAddress: string): Uint8Array => new Uint8Array(parseOotleAddress(walletAddress).owner_key);

/** Every escrow ledger, by DID. */
async function allLedgers(): Promise<Record<string, Cbor[]>> {
  return allRecords(await stateOf(CONFIG.escrow), ESCROW);
}

/** Gifts returned to `keyHex` (declined or swept): [did, position in its ledger, amount]. The escrow governs them now. */
async function returnedTo(keyHex: string): Promise<[string, number, bigint][]> {
  const out: [string, number, bigint][] = [];
  for (const [did, ledger] of Object.entries(await allLedgers())) {
    ((ledger[0] ?? []) as Cbor[][]).forEach((d, i) => {
      if (addressText(d[3]) === CONFIG.escrow && bytesHex(d[0]) === keyHex) out.push([did, i, BigInt(d[1] as number)]);
    });
  }
  return out;
}

/** Gifts returned to `keyHex` (declined or swept) and waiting to be taken back. */
export async function readReturnedFor(_provider: IndexerProvider, keyHex: string): Promise<bigint> {
  requireDeployed();
  return (await returnedTo(keyHex)).reduce((n, [, , a]) => n + a, 0n);
}

/** Takes back everything that was returned to this wallet: a `refund` of each, refundable at once. */
export async function takeReturned(wallet: Wallet, onStage?: (s: string) => void): Promise<TxOutcome> {
  requireDeployed();
  // Highest position first within a ledger, so earlier removals don't shift the later ones.
  const items = (await returnedTo(toHex(wallet.publicKey))).sort((a, b) => (a[0] === b[0] ? b[1] - a[1] : a[0] < b[0] ? -1 : 1)).slice(0, 8);
  if (!items.length) throw new ChainError("nothing has been returned to you");
  const instructions = items.flatMap(([did, index]) => [call(CONFIG.escrow, "refund", [lit(did), lit(index)]), toWorkspace, call(wallet.componentAddress, "deposit", [workspace0])]);
  return run(wallet, instructions, 40_000n * BigInt(items.length), onStage, false, [...new Set((await Promise.all(items.map(([did]) => claimRelated(did)))).flat())]);
}

/** Declines a waiting gift (from the linked wallet). It goes back to its sender. */
export async function declineDeposit(wallet: Wallet, did: string, d: Deposit, onStage?: (s: string) => void): Promise<TxOutcome> {
  const args = [lit(did), lit(fromHex(d.sender)), amountLiteral(d.amount), lit(d.refundEpoch)];
  return run(wallet, [call(claimComponentFor(did), "decline", args)], 60_000n, onStage, false, await claimRelated(did));
}

export async function declineDepositSponsored(wallet: Wallet, did: string, d: Deposit, onStage?: (s: string) => void): Promise<TxOutcome> {
  const account = builtinOnly(wallet);
  return sendSponsored(
    account,
    (b) => b.addFeeInstruction(call(claimComponentFor(did), "decline_sponsored", [lit(did), lit(fromHex(d.sender)), amountLiteral(d.amount), lit(d.refundEpoch), amountLiteral(SPONSOR_FEE)])),
    onStage,
    false,
    did,
  );
}

/** Sends gifts that can no longer pay (phrase gifts nobody answered for about three days) back to their senders. Anyone may do it. */
export async function sweepDeposits(wallet: Wallet, did: string, onStage?: (s: string) => void): Promise<TxOutcome> {
  return run(wallet, [call(claimComponentFor(did), "sweep", [lit(did)])], 60_000n, onStage, false, await claimRelated(did));
}

/** The account component behind a wallet address (otl_…). */
export const accountOf = (walletAddress: string): string => componentAddressFromWalletAddress(walletAddress);

/** Proves again that the claim post is still up, once a deposit's hold time has passed. */
export async function confirmClaim(wallet: Wallet, proof: ClaimProof, onStage?: (s: string) => void): Promise<TxOutcome> {
  const did = proof.did;
  const book = await bookFirst(wallet, did, onStage);
  const instructions = [...book.steps, call(claimComponentFor(did), "confirm_claim", [lit(did), ...chainArg(did, proof.ops), lit(proof.commit), lit(proof.nodes), lit(proof.record), lit(proof.rkey)])];
  return run(wallet, instructions, 120_000n + book.fee, onStage, false, await claimRelated(proof.did));
}

/** Shows the registry an account's current operation chain, so proofs made with an older one are refused from then on. */
export async function observeChain(wallet: Wallet, did: string, ops: Uint8Array[], onStage?: (s: string) => void): Promise<TxOutcome> {
  if (ops.length > LINK_MAX_OPS) throw new ChainError("The link registry keeps at most 16 identity operations.");
  return run(wallet, [...(await openMissing(did, ["link"])), call(CONFIG.link, "observe_chain", [lit(did), lit(ops)])], 120_000n, onStage, false, await linkRelated(did));
}

/** Cancels a pending claim by presenting the account's newer operation chain (during its challenge window). Under v2 the
 *  newer chain is recorded in the ChainBook first, and the challenge reads it from there. */
export async function challengeClaim(wallet: Wallet, did: string, ops: Uint8Array[], onStage?: (s: string) => void): Promise<TxOutcome> {
  const book = await bookFirst(wallet, did, onStage);
  const instructions = [...book.steps, call(claimComponentFor(did), "challenge", [lit(did), ...chainArg(did, ops)])];
  return run(wallet, instructions, 120_000n + book.fee, onStage, false, await claimRelated(did));
}

/** Cancels a link that hasn't taken effect yet by presenting the account's newer operation chain. */
export async function challengeBind(wallet: Wallet, did: string, ops: Uint8Array[], onStage?: (s: string) => void): Promise<TxOutcome> {
  return run(wallet, [call(CONFIG.link, "challenge_bind", [lit(did), lit(ops)])], 120_000n, onStage, false, await linkRelated(did));
}

/** Why `address` can't be paid from `own` (a wallet address on the same network), or null when it can. */
export function addressProblem(address: string, own: string): string | null {
  if (!address) return "Paste the address you want to send to.";
  try {
    parseOotleAddress(address);
  } catch {
    return "That doesn't look like a Tari address. It should start with otl_.";
  }
  // The network is everything before the last "_": "otl" on mainnet (otl_1…), "otl_esm" on Esmeralda (otl_esm_1…).
  const net = (a: string) => a.slice(0, a.lastIndexOf("_"));
  if (net(address) !== net(own)) return "That address is for a different Tari network.";
  if (address === own) return "That's this wallet's own address.";
  return null;
}

/** Sends tTARI from the built-in wallet to any Tari address. A recipient with no account yet gets one. */
export async function withdrawTo(wallet: Wallet, address: string, amount: bigint, onStage?: (s: string) => void): Promise<TxOutcome> {
  const account = builtinOnly(wallet);
  onStage?.("Sending to the network…");
  const res = (await account.send(address, TARI_RESOURCE_ADDRESS, amount, 30_000n)) as { transaction_id?: unknown; transactionId?: unknown };
  assertAccepted(res);
  return { transactionId: String(res.transaction_id ?? res.transactionId ?? "") };
}

/** A deposit this wallet made, anywhere in the escrow. */
export interface SentDeposit {
  did: string;
  amount: bigint;
  refundEpoch: number;
  window: number;
  challenge: string;
  hold: number;
  /** Hash (hex) of the envelope the sender committed to, or empty. */
  envelope: string;
  created: number;
}

/** Every ClaimPolicy deposit whose sender is `keyHex`, across all accounts. */
export async function readSentBy(provider: IndexerProvider, keyHex: string): Promise<{ epoch: number; items: SentDeposit[] }> {
  requireDeployed();
  const [epoch, ledgers] = await Promise.all([provider.getCurrentEpoch(), allLedgers()]);
  const items: SentDeposit[] = [];
  for (const [did, ledger] of Object.entries(ledgers)) {
    for (const d of allClaimDeposits(ledger)) {
      if (d.sender === keyHex) items.push({ did, amount: d.amount, refundEpoch: d.refundEpoch, window: d.window, challenge: d.challenge, hold: d.hold, envelope: d.envelope, created: d.created });
    }
  }
  return { epoch, items };
}

export interface Delivered {
  did: string;
  amount: bigint;
  epoch: number;
}

/** Gifts this wallet sent that went straight to a linked wallet, newest first (ClaimPolicy's delivery log). */
export async function readDeliveredBy(_provider: IndexerProvider, keyHex: string): Promise<Delivered[]> {
  requireDeployed();
  const [r1, r2] = await Promise.all([allRecords(await stateOf(CONFIG.claim), CLAIM), allRecords(await stateOf(CONFIG.claim2), CLAIM2)]);
  const out: Delivered[] = [];
  for (const [v, records] of [[1, r1], [2, r2]] as const) {
    for (const [did, r] of Object.entries(records)) {
      for (const d of claimFields(r, v).delivered) if (bytesHex(d[0]) === keyHex) out.push({ did, amount: BigInt(d[1] as number), epoch: Number(d[2]) });
    }
  }
  return out.sort((a, b) => b.epoch - a.epoch);
}

/** Takes a deposit back. The escrow wants its position in the recipient's list, so find it fresh each time. */
export async function refundDeposit(wallet: Wallet, provider: IndexerProvider, d: SentDeposit, onStage?: (s: string) => void): Promise<TxOutcome> {
  const esc = await readEscrow(provider, d.did);
  const mine = toHex(wallet.publicKey);
  const found = [...esc.deposits, ...esc.laterDeposits].find((x) => x.sender === mine && x.amount === d.amount && x.refundEpoch === d.refundEpoch && x.created === d.created && x.challenge === d.challenge);
  if (!found) throw new ChainError("That deposit was already collected or taken back.");
  if (esc.epoch < d.refundEpoch) throw new ChainError("It can't be taken back yet.");
  const instructions = [call(CONFIG.escrow, "refund", [lit(d.did), lit(found.index)]), toWorkspace, call(wallet.componentAddress, "deposit", [workspace0])];
  return run(wallet, instructions, 30_000n, onStage, false, await claimRelated(d.did));
}

// ---- tip budgets (TipPolicy) ----------------------------------------------------------------------------

export interface Budget {
  balance: bigint;
  window: number;
  refundAfter: number;
  maxTip: bigint;
}

const budgetOf = (b: Cbor[]): Budget => ({ balance: BigInt(b[0] as number), window: Number(b[1]), refundAfter: Number(b[2]), maxTip: BigInt(b[3] as number) });

/** The budget this wallet key funded for `did`, if any. TipPolicy budgets: "did:ownerKeyHex" -> tuple. */
/** Which TipPolicy holds (did, owner)'s budget: v2 if it has one there, else v1 if it has one there, else null. */
async function budgetHome(did: string, ownerKeyHex: string): Promise<{ tip: string; budget: Budget } | null> {
  for (const tip of [CONFIG.tip2, CONFIG.tip]) {
    const b = ((await stateOf(tip))[TIP.budgets] as Record<string, Cbor[]> | undefined)?.[`${did}:${ownerKeyHex}`];
    if (b) return { tip, budget: budgetOf(b) };
  }
  return null;
}

export async function readBudget(_provider: IndexerProvider, did: string, ownerKeyHex: string): Promise<Budget | null> {
  requireDeployed();
  return (await budgetHome(did, ownerKeyHex))?.budget ?? null;
}

export async function openBudget(
  wallet: Wallet,
  p: { did: string; amount: bigint; window: number; refundAfter: number; maxTip: bigint },
  onStage?: (s: string) => void,
): Promise<TxOutcome> {
  // An existing v1 budget is topped up where it is; anything new is a v2 budget.
  const tip = (await budgetHome(p.did, toHex(wallet.publicKey)))?.tip ?? CONFIG.tip2;
  const instructions = [call(tip, "open_budget", [lit(p.did), lit(wallet.publicKey), lit(p.window), lit(p.refundAfter), amountLiteral(p.maxTip), fundsBucket])];
  return runFunded(wallet, p.amount, instructions, [tip], 40_000n, onStage);
}

/**
 * Sends `amount` TARI from the relay wallet into the account of the wallet at `address`, as public TARI it can pay
 * fees with, creating that account if it doesn't exist yet (anyone may create an account for a key).
 */
export async function floatFee(wallet: Wallet, address: string, amount: bigint, onStage?: (s: string) => void): Promise<TxOutcome> {
  const account = accountOf(address);
  const exists = (await fetchValue(account)) !== null;
  const follow = exists
    ? [call(account, "deposit", [fundsBucket])]
    : [{ CreateAccount: { owner_public_key: toHex(ownerOf(address)), owner_rule: null, access_rules: null, bucket_workspace_id: { id: 1, offset: null } } }];
  return runFunded(wallet, amount, follow, exists ? [account] : [], 40_000n, onStage);
}

/** Whether a sponsored call failed only because its proof check is too big for the fee phase's compute allowance. */
export const isFeePhaseTooBig = (e: unknown): boolean => /fee intent exceeded|compute credit/i.test(e instanceof Error ? e.message : String(e));

/** Tops up the escrow's fee vault, which pays network fees for claimers who hold no TARI. The escrow books each
 *  sponsored fee against the claimer's own gifts and takes it back out of what they're paid. Anyone may fund it. */
export async function fundSponsor(wallet: Wallet, amount: bigint, onStage?: (s: string) => void): Promise<TxOutcome> {
  const instructions = [call(CONFIG.escrow, "fund", [fundsBucket])];
  // The funded call adds every vault of each component it's given, so naming the fee vault too would list it twice,
  // and a transaction with a duplicate input doesn't even parse.
  return runFunded(wallet, amount, instructions, [CONFIG.escrow], 30_000n, onStage);
}

export async function closeBudget(wallet: Wallet, did: string, amount: bigint, onStage?: (s: string) => void): Promise<TxOutcome> {
  const tip = (await budgetHome(did, toHex(wallet.publicKey)))?.tip;
  if (!tip) throw new ChainError("no such budget");
  const instructions = [
    call(tip, "close_budget", [lit(did), lit(wallet.publicKey), amountLiteral(amount)]),
    toWorkspace,
    call(wallet.componentAddress, "deposit", [workspace0]),
  ];
  return run(wallet, instructions, 30_000n, onStage);
}

/** Relays someone's tip post to TipPolicy. Anyone can do this: the post's signature is the authority; the relayer pays the fee. */
export async function relayTip(wallet: Wallet, proof: ClaimProof, ownerKey: Uint8Array, recipientDid: string, onStage?: (s: string) => void): Promise<TxOutcome> {
  const home = await budgetHome(proof.did, toHex(ownerKey));
  if (!home) throw new ChainError("no such budget");
  const v2 = home.tip === CONFIG.tip2;
  // v2 reads the tipper's key from the ChainBook (brought up to date here); v1 takes the chain in the call.
  let bookFee = 0n;
  let book: unknown[] = [];
  if (v2) {
    const st = await bookSteps(proof.did);
    if (st.missing > INLINE_BOOK_OPS) await recordChain(wallet, proof.did, onStage);
    else [book, bookFee] = [st.instructions, FEE_PER_BOOK_OP * BigInt(st.missing)];
  }
  const [tipper, recipient] = await Promise.all([openMissing(proof.did, ["link"]), openMissing(recipientDid, ["escrow"])]);
  const chain = v2 ? [] : [lit(proof.ops)];
  const instructions = [...tipper, ...recipient, ...book, call(home.tip, "tip", [lit(proof.did), lit(ownerKey), ...chain, lit(proof.commit), lit(proof.nodes), lit(proof.record), lit(proof.rkey)])];
  // The tip lands under the tip policy's own ClaimPolicy, so the recipient's side is looked up as that version.
  const was = claimVersion.get(recipientDid);
  claimVersion.set(recipientDid, v2 ? 2 : 1);
  try {
    const related = [...new Set([...(await claimRelated(proof.did)), ...(await claimRelated(recipientDid)), home.tip, ...(v2 ? [CONFIG.chainBook] : [])])];
    return await run(wallet, instructions, 120_000n + bookFee, onStage, false, related);
  } finally {
    if (was) claimVersion.set(recipientDid, was);
    else claimVersion.delete(recipientDid);
  }
}

/** Every budget funded for `did`, by any owner: [ownerKeyHex, budget]. */
export async function readBudgetsFor(_provider: IndexerProvider, did: string): Promise<[string, Budget][]> {
  requireDeployed();
  const [t1, t2] = await Promise.all([stateOf(CONFIG.tip), stateOf(CONFIG.tip2)]);
  const map = { ...((t1[TIP.budgets] ?? {}) as Record<string, Cbor[]>), ...((t2[TIP.budgets] ?? {}) as Record<string, Cbor[]>) };
  return Object.entries(map)
    .filter(([k]) => k.startsWith(`${did}:`))
    .map(([k, b]) => [k.slice(did.length + 1), budgetOf(b)]);
}

// ---- sponsored transactions: the escrow's fee vault pays, so the claimant needs no funds ----------------

/** Fee ceiling offered per sponsored call (µT). The escrow caps it too, and refunds what isn't used. */
export const SPONSOR_FEE = 60_000n;

/** The ChainBook calls a sponsored v2 call can carry in its fee phase. More operations than that would overrun the fee
 *  phase's compute allowance, so they must be recorded first (`recordChain`, or the bot for wallets with no TARI). */
async function sponsoredBookSteps(did: string): Promise<unknown[]> {
  if (!isV2(did)) return [];
  const { missing, instructions } = await bookSteps(did);
  if (missing > FEE_PHASE_BOOK_OPS) throw new ChainError(`needs recording first: ${missing} identity operations`);
  return instructions;
}

/** A sponsored call was refused because the account's identity history has to be recorded in the ChainBook first. */
export const needsRecording = (e: unknown): boolean => /needs recording first/.test(e instanceof Error ? e.message : String(e));

/** Sponsored (fee-phase) transactions need the signing key, which only the built-in wallet exposes to us. */
function builtinOnly(w: Wallet): OotleAccount {
  if (!w.account) throw new ChainError("Sponsored fees need the built-in wallet. Your wallet will pay the small fee instead.");
  return w.account;
}

type Raw = { addFeeInstruction(i: unknown): unknown; addInstruction(i: unknown): unknown };

async function sendSponsored(
  account: OotleAccount,
  fill: (b: Raw) => void,
  onStage?: (s: string) => void,
  tolerateEpochLag = false,
  did?: string,
  only?: string[],
): Promise<TxOutcome> {
  if (!only) requireDeployed();
  const provider = await account.getProvider();
  const network = configNetwork();
  // A Set: claimRelated already names the fee vault, and a duplicate input makes the transaction unparseable.
  const related = only
    ? [...new Set(only)]
    : [...new Set([...(did ? await claimRelated(did) : [CONFIG.claim2, CONFIG.escrow]), `vault_${refHex((await stateOf(CONFIG.escrow))[ESCROW.feeVault])}`])];
  const signer = (account as unknown as { signer: Parameters<typeof sendTransaction>[1] }).signer;
  const dryRun = (account as unknown as {
    submitDryRun(p: IndexerProvider, tx: unknown, extra: unknown[]): Promise<unknown>;
  }).submitDryRun.bind(account);
  const maxEpoch = await resolveMaxEpoch(provider);
  let inputs = await resolveInputsWithRetry(provider, related.map((substate_id) => ({ substate_id, version: null })));
  const seen = new Set<string>();
  const build = () => {
    const b = TransactionBuilder.new(network, maxEpoch);
    fill(b as unknown as Raw);
    b.withInputs(inputs);
    return b.buildUnsignedTransaction();
  };
  for (let attempt = 0; ; attempt++) {
    try {
      onStage?.("Checking it works…");
      try {
        const dry = await dryRun(provider, build(), []);
        assertAccepted(dry);
      } catch (e) {
        if (!tolerateEpochLag || !isWindowOpen(e)) throw e;
        onStage?.("The pre-check is one epoch behind. Sending anyway…");
      }
      break;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const stale = staleInput(msg);
      if (stale && attempt < 14) {
        await forgetKnownVersions([stale.id], network).catch(() => undefined);
        const v = Math.max(stale.next, (await latestVersion(stale.id)) ?? 0);
        inputs = [...inputs.filter((x) => x.substate_id !== stale.id), { substate_id: stale.id, version: v }] as typeof inputs;
        continue;
      }
      const missing = extractMissingSubstateAddress(msg);
      if (!missing || seen.has(missing) || attempt >= 14) throw e;
      seen.add(missing);
      const [resolved] = await resolveInputsWithRetry(provider, [{ substate_id: missing, version: null }]);
      inputs = [...inputs, resolved!];
    }
  }
  // Sent once, with exactly the inputs the pre-check settled on: a failed real send has already paid its fee, so
  // it is never retried here.
  onStage?.("Sending to the network…");
  let res: { transaction_id?: unknown } | undefined;
  for (let i = 0; ; i++) {
    try {
      res = (await sendTransaction(provider, signer, build())) as unknown as { transaction_id?: unknown };
      break;
    } catch (e) {
      // Refused before broadcast because an input moved on since the check: nothing charged, send with the newer one.
      const stale = refusedStale(e);
      if (!stale || i >= 4) throw e;
      await forgetKnownVersions([stale.id], network).catch(() => undefined);
      const v = Math.max(stale.next, (await latestVersion(stale.id)) ?? 0);
      inputs = [...inputs.filter((x) => x.substate_id !== stale.id), { substate_id: stale.id, version: v }] as typeof inputs;
      onStage?.("Something changed on the network a moment ago. Sending again…");
    }
  }
  assertAccepted(res);
  return { transactionId: String(res.transaction_id ?? "") };
}

/**
 * Sends `instructions` entirely in the fee phase, signed by the built-in wallet, for a contract that pays the fee
 * itself (a sponsored campaign claim). `inputs` are the substates it touches; the pre-check finds any it missed.
 */
export async function sendFeePhase(wallet: Wallet, instructions: unknown[], inputs: string[], onStage?: (s: string) => void): Promise<TxOutcome> {
  const account = builtinOnly(wallet);
  return sendSponsored(account, (b) => { for (const i of instructions) b.addFeeInstruction(i); }, onStage, false, undefined, inputs);
}

export async function confirmClaimSponsored(wallet: Wallet, proof: ClaimProof, onStage?: (s: string) => void): Promise<TxOutcome> {
  const account = builtinOnly(wallet);
  const did = proof.did;
  const book = await sponsoredBookSteps(did);
  return sendSponsored(
    account,
    (b) => {
      for (const i of book) b.addFeeInstruction(i);
      b.addFeeInstruction(
        call(claimComponentFor(did), "confirm_claim_sponsored", [lit(did), ...chainArg(did, proof.ops), lit(proof.commit), lit(proof.nodes), lit(proof.record), lit(proof.rkey), amountLiteral(SPONSOR_FEE)]),
      );
    },
    onStage,
    false,
    proof.did,
  );
}

export async function startClaimSponsored(wallet: Wallet, proof: ClaimProof, onStage?: (s: string) => void): Promise<TxOutcome> {
  const account = builtinOnly(wallet);
  const pk = wallet.publicKey;
  // The sponsored call reads the records in the fee phase, so missing ones are opened (and the ChainBook brought up to
  // date) there first.
  const did = proof.did;
  const open = [...(await openMissing(did, [claimBook(did), "link"])), ...(await sponsoredBookSteps(did))];
  return sendSponsored(
    account,
    (b) => {
      for (const i of open) b.addFeeInstruction(i);
      b.addFeeInstruction(
        call(claimComponentFor(did), "start_claim_sponsored", [lit(did), lit(pk), ...chainArg(did, proof.ops), lit(proof.commit), lit(proof.nodes), lit(proof.record), lit(proof.rkey), amountLiteral(SPONSOR_FEE)]),
      );
    },
    onStage,
    false,
    proof.did,
  );
}

/** Pays out into the claimant's account, creating it in the same transaction if it doesn't exist yet. */
export async function finalizeClaimSponsored(wallet: Wallet, did: string, onStage?: (s: string) => void, payableByEpoch = false): Promise<TxOutcome> {
  const account = builtinOnly(wallet);
  const pk = wallet.publicKey;
  return sendSponsored(
    account,
    (b) => {
      b.addFeeInstruction(call(claimComponentFor(did), "sponsor_finalize", [lit(did), amountLiteral(SPONSOR_FEE)]));
      b.addInstruction(call(claimComponentFor(did), "finalize_claim", [lit(did)]));
      b.addInstruction(toWorkspace);
      b.addInstruction({ CreateAccount: { owner_public_key: toHex(pk), owner_rule: null, access_rules: null, bucket_workspace_id: { id: 0, offset: null } } });
    },
    onStage,
    payableByEpoch,
    did,
  );
}

export async function useFaucet(wallet: Wallet): Promise<void> {
  await builtinOnly(wallet).claimTestnetXtr(100_000n);
}

// ---- formatting -------------------------------------------------------------------------------------------------

export function formatTari(micro: bigint, maxDecimals = 4): string {
  const whole = micro / CONFIG.unit;
  const frac = (micro % CONFIG.unit).toString().padStart(6, "0").slice(0, maxDecimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export function parseTari(text: string): bigint | null {
  const m = text.trim().match(/^(\d+)(?:\.(\d{1,6}))?$/);
  if (!m) return null;
  return BigInt(m[1]!) * CONFIG.unit + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
}
