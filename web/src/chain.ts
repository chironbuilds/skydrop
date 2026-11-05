import {
  OotleAccount,
  componentAddressFromWalletAddress,
  configureOotleStorage,
  extractMissingSubstateAddress,
  inMemoryAdapter,
  localStorageAdapter,
  resolveInputsWithRetry,
  toOotleNetwork,
} from "@chironbuilder/ootle-sdk";
import {
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
import type { ClaimProof } from "./bsky";
import type { Wallet } from "./wallet";

const SEED_KEY = "skydrop.seed.v1";

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
  return OotleAccount.fromSeed(fromHex(seedHex), 0, CONFIG.network);
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
//   Escrow       [vault, badge_vault, policy_badge, min_deposit, admin, policies, next_badge, deposits, fee_vault, owed, returned]
//   ClaimPolicy  [escrow, badge_vault, pending, known_len, claim_text, held, link_registry, sponsored, delivered]
//   LinkRegistry [bindings, bind_proof, last_bind, known_len, bind_delay]
//   TipPolicy    [escrow, claim_policy, badge_vault, budget_vault, bot_did, budgets, last_tip]
// An escrow deposit is (sender, amount, refund epoch, governing policy, metadata, epoch it was made).

const ESCROW = { deposits: 7, feeVault: 8, returned: 10 } as const;
const CLAIM = { pending: 2, claimText: 4, held: 5, delivered: 8 } as const;
const LINK = { bindings: 0, bindProof: 1, knownLen: 3 } as const;
const TIP = { budgets: 5 } as const;

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

async function stateOf(provider: IndexerProvider, component: string): Promise<Cbor[]> {
  const sub = await provider.getSubstate(component);
  const comp = (sub.substate as { Component?: { body: { state: Cbor[] } } }).Component;
  if (!comp) throw new Error("A Skydrop contract could not be read");
  return comp.body.state;
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

/** Every ClaimPolicy deposit escrowed for `did`, with its position in the escrow's list. */
function claimDeposits(escrowState: Cbor[], did: string): Deposit[] {
  const rows = (escrowState[ESCROW.deposits] as Record<string, Cbor[][]> | undefined)?.[did] ?? [];
  return rows.map((d, i) => ({ d, i })).filter(({ d }) => addressText(d[3]) === CONFIG.claim).map(({ d, i }) => depositOf(d, i));
}

export async function readEscrow(provider: IndexerProvider, did: string): Promise<Escrow> {
  requireDeployed();
  const [epoch, escrow, claim, link] = await Promise.all([
    provider.getCurrentEpoch(),
    stateOf(provider, CONFIG.escrow),
    stateOf(provider, CONFIG.claim),
    stateOf(provider, CONFIG.link),
  ]);
  const pend = (claim[CLAIM.pending] as Record<string, Cbor[]> | undefined)?.[did];
  return {
    epoch,
    maxWindow: CONFIG.maxWindow,
    deposits: claimDeposits(escrow, did),
    pending: pend ? { claimant: bytesHex(pend[0]), start: Number(pend[1]), len: Number(pend[3]) } : null,
    claimText: String((claim[CLAIM.claimText] as Record<string, string> | undefined)?.[did] ?? ""),
    binding: bindingOf(link[LINK.bindings], did, epoch),
    bindingOwner: bindingOwnerOf(link[LINK.bindings], did, epoch),
    bindingPending: pendingBindingOf(link[LINK.bindings], did, epoch),
    held: heldOf(claim[CLAIM.held], did),
  };
}

/** ClaimPolicy held: DID -> [rkey of the claim post, epoch it was last proven, snapshot µs at the start, latest snapshot µs]. */
function heldOf(map: Cbor, did: string): { rkey: string; epoch: number; startRev: number; rev: number } | null {
  const h = (map as Record<string, Cbor[]> | undefined)?.[did];
  return h ? { rkey: String(h[0]), epoch: Number(h[1]), startRev: Number(h[2]), rev: Number(h[3]) } : null;
}

// LinkRegistry bindings: DID -> [account, epoch it takes effect, the account it replaces (the registry itself for a
// first link), owner key of the new binding, owner key of the one it replaces].

function bindingOf(map: Cbor, did: string, epoch: number): string | null {
  const b = (map as Record<string, Cbor[]> | undefined)?.[did];
  if (!b) return null;
  if (epoch >= Number(b[1])) return addressText(b[0]);
  // before it takes effect, a replaced binding still applies; a first one (which "replaces" the registry) means nothing yet
  const old = addressText(b[2]);
  return old === CONFIG.link ? null : old;
}

function bindingOwnerOf(map: Cbor, did: string, epoch: number): string | null {
  const b = (map as Record<string, Cbor[]> | undefined)?.[did];
  if (!b) return null;
  if (epoch >= Number(b[1])) return bytesHex(b[3]);
  return addressText(b[2]) === CONFIG.link ? null : bytesHex(b[4]);
}

function pendingBindingOf(map: Cbor, did: string, epoch: number): { address: string; epoch: number } | null {
  const b = (map as Record<string, Cbor[]> | undefined)?.[did];
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
  const [epoch, escrow, claim, link, tip] = await Promise.all([
    provider.getCurrentEpoch(),
    stateOf(provider, CONFIG.escrow),
    stateOf(provider, CONFIG.claim),
    stateOf(provider, CONFIG.link),
    stateOf(provider, CONFIG.tip),
  ]);
  const deposits: StackSnapshot["deposits"] = {};
  for (const did of Object.keys((escrow[ESCROW.deposits] ?? {}) as Record<string, unknown>)) {
    const list = claimDeposits(escrow, did);
    if (list.length) deposits[did] = list;
  }
  const pending: StackSnapshot["pending"] = {};
  for (const [did, p] of Object.entries((claim[CLAIM.pending] ?? {}) as Record<string, Cbor[]>)) {
    pending[did] = { claimant: bytesHex(p[0]), start: Number(p[1]), tipHex: bytesHex(p[2]), len: Number(p[3]) };
  }
  const delivered: StackSnapshot["delivered"] = {};
  for (const [did, list] of Object.entries((claim[CLAIM.delivered] ?? {}) as Record<string, Cbor[][]>)) {
    delivered[did] = list.map((d) => ({ sender: bytesHex(d[0]), amount: BigInt(d[1] as number), epoch: Number(d[2]) }));
  }
  const proofs = (link[LINK.bindProof] ?? {}) as Record<string, Cbor[]>;
  const bindings: StackSnapshot["bindings"] = {};
  for (const [did, b] of Object.entries((link[LINK.bindings] ?? {}) as Record<string, Cbor[]>)) {
    const pr = proofs[did];
    bindings[did] = { effective: Number(b[1]), tipHex: pr ? bytesHex(pr[0]) : null, len: pr ? Number(pr[1]) : 0 };
  }
  const chainFloor = Object.fromEntries(Object.entries((link[LINK.knownLen] ?? {}) as Record<string, number>).map(([d, n]) => [d, Number(n)]));
  const budgetDids = [...new Set(Object.keys((tip[TIP.budgets] ?? {}) as Record<string, unknown>).map((k) => k.slice(0, k.lastIndexOf(":"))))];
  return { epoch, deposits, pending, delivered, bindings, chainFloor, budgetDids };
}

/** The account `did` has linked, if any. */
export async function readBinding(provider: IndexerProvider, did: string): Promise<string | null> {
  requireDeployed();
  const [epoch, link] = await Promise.all([provider.getCurrentEpoch(), stateOf(provider, CONFIG.link)]);
  return bindingOf(link[LINK.bindings], did, epoch);
}

/** Links the Bluesky account in `proof` to `address`: the proof is a post that carries the bind code for that address. */
export async function bindAccount(wallet: Wallet, proof: ClaimProof, address: string, owner: Uint8Array, onStage?: (s: string) => void): Promise<TxOutcome> {
  const instructions = [
    call(CONFIG.link, "bind", [lit(proof.did), componentAddressLiteral(address as never), lit(owner), lit(proof.ops), lit(proof.commit), lit(proof.nodes), lit(proof.record), lit(proof.rkey)]),
  ];
  return run(wallet, instructions, 120_000n, onStage);
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
    const state = (await stateOf(provider, CONFIG.escrow)) as { value?: { hex: string } }[];
    const vaultId = state[ESCROW.feeVault]?.value?.hex;
    if (!vaultId) return 0n;
    const v = await provider.getSubstate(`vault_${vaultId}`);
    const rc = (v.substate as { Vault: { resource_container: Record<string, { revealed_amount?: string; amount?: string }> } }).Vault.resource_container;
    const inner = Object.values(rc)[0];
    return BigInt(inner?.revealed_amount ?? inner?.amount ?? 0);
  } catch {
    return 0n;
  }
}

export const total = (ds: Deposit[]): bigint => ds.reduce((n, d) => n + d.amount, 0n);

// ---- transactions -------------------------------------------------------------------------------------------

export class ChainError extends Error {}

/** Turns the engine's raw rejection text into something a person can act on. */
export function friendly(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  const rules: [RegExp, string][] = [
    [/isn't deployed on this network/i, "Skydrop isn't running on this network yet. Check back soon."],
    [/does not contain the claim code/i, "Your post doesn't contain the claim code. Post the exact text shown, then try again."],
    [/invalid repo proof/i, "The signed copy of your post didn't verify. Wait a few seconds after posting and try again."],
    [/invalid operation chain/i, "Your account's identity history didn't verify."],
    [/stale operation chain/i, "A newer version of this account's identity history exists. Refresh and try again."],
    [/no deposits for this account under this policy|no pending claim/i, "Nothing is waiting for this account."],
    [/window is still open|nothing payable yet|nothing is payable yet/i, "The network hasn't caught up to your claim yet. Wait a minute and press Collect again."],
    [/not enough|insufficient/i, "This wallet doesn't have enough tTARI to cover the amount plus network fees."],
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
    [/escrow is too small to cover more sponsored fees/i, "This gift is too small to cover more free network fees. Your wallet needs a little tTARI for the fee."],
    [/already used to bind/i, "That link post was already used. Make a new post to link again."],
    [/no such deposit/i, "That gift is no longer there. It may already have been collected, declined or returned."],
    [/no deposits for this account/i, "Nothing is waiting for this account any more."],
    [/not refundable yet/i, "This gift can't be taken back yet. Check Your sends for when."],
    [/already in effect/i, "That link is already in effect."],
    [/has used its sponsored/i, "The free network fees for this account have been used. Your wallet needs a little tTARI for the fee."],
    [/Timed out/i, "The network is slow right now. Please try again."],
  ];
  for (const [re, text] of rules) if (re.test(m)) return text;
  return m.length > 220 ? `${m.slice(0, 220)}…` : m;
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

async function run(
  wallet: Wallet,
  instructions: unknown[],
  maxFee: bigint,
  onStage?: (s: string) => void,
  tolerateEpochLag = false,
): Promise<TxOutcome> {
  requireDeployed();
  onStage?.("Checking it works…");
  try {
    const dry = await wallet.execute(instructions, { dryRun: true, maxFee });
    assertAccepted(dry);
  } catch (e) {
    // The pre-check runs against the previous epoch, so it can call a payout "too early" that the real
    // transaction (executed in the current epoch) accepts. Only for payouts the caller already knows are due.
    if (!tolerateEpochLag || !isWindowOpen(e)) throw e;
    onStage?.("The pre-check is one epoch behind. Sending anyway…");
  }
  onStage?.("Sending to the network…");
  const res = (await wallet.execute(instructions, { maxFee })) as { transaction_id?: unknown; transactionId?: unknown };
  assertAccepted(res);
  return { transactionId: String(res.transaction_id ?? res.transactionId ?? "") };
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
  const owner = wallet.componentAddress;
  const pk = wallet.publicKey;
  const withdraw = call(owner, "withdraw", [resourceAddressLiteral(TARI_RESOURCE_ADDRESS), amountLiteral(p.amount)]);
  const plain = !p.window && !p.challenge && !p.hold && !p.envelope;
  const give =
    linked && plain
      ? call(CONFIG.claim, "pay_linked", [lit(p.did), lit(pk), workspace0])
      : call(CONFIG.escrow, "deposit", [
          lit(p.did),
          lit(pk),
          lit(epoch + CONFIG.refundAfterEpochs),
          componentAddressLiteral(CONFIG.claim as never),
          lit(encodeMetadata({ window: p.window, hold: p.hold, envelope: p.envelope, challenge: p.challenge })),
          workspace0,
        ]);
  return run(wallet, [withdraw, toWorkspace, give], 30_000n, onStage);
}

export async function startClaim(wallet: Wallet, proof: ClaimProof, onStage?: (s: string) => void): Promise<TxOutcome> {
  const pk = wallet.publicKey;
  const instructions = [
    call(CONFIG.claim, "start_claim", [lit(proof.did), lit(pk), lit(proof.ops), lit(proof.commit), lit(proof.nodes), lit(proof.record), lit(proof.rkey)]),
  ];
  return run(wallet, instructions, 120_000n, onStage);
}

/**
 * Starts a claim for an account that has linked a wallet: the post needs no claim code (any new post — e.g. one
 * that just says the sender's phrase), because the payout can only go to the linked wallet. Anyone may submit it.
 */
export async function startLinkedClaim(wallet: Wallet, proof: ClaimProof, onStage?: (s: string) => void): Promise<TxOutcome> {
  const instructions = [
    call(CONFIG.claim, "start_linked_claim", [lit(proof.did), lit(proof.ops), lit(proof.commit), lit(proof.nodes), lit(proof.record), lit(proof.rkey)]),
  ];
  return run(wallet, instructions, 120_000n, onStage);
}

/** Pays a linked account's payable gifts into its linked wallet. Anyone may call it: the destination is fixed. */
export async function finalizeToLinked(wallet: Wallet, did: string, onStage?: (s: string) => void, payableByEpoch = false): Promise<TxOutcome> {
  return run(wallet, [call(CONFIG.claim, "finalize_to_linked", [lit(did)])], 60_000n, onStage, payableByEpoch);
}

export async function finalizeClaim(wallet: Wallet, did: string, onStage?: (s: string) => void, payableByEpoch = false): Promise<TxOutcome> {
  const owner = wallet.componentAddress;
  const instructions = [call(CONFIG.claim, "finalize_claim", [lit(did)]), toWorkspace, call(owner, "deposit", [workspace0])];
  return run(wallet, instructions, 30_000n, onStage, payableByEpoch);
}

/** The owner key inside a wallet address (otl_…). */
export const ownerOf = (walletAddress: string): Uint8Array => new Uint8Array(parseOotleAddress(walletAddress).owner_key);

/** Gifts returned to `keyHex` (declined or swept) and waiting to be taken back. */
export async function readReturnedFor(provider: IndexerProvider, keyHex: string): Promise<bigint> {
  requireDeployed();
  const state = await stateOf(provider, CONFIG.escrow);
  const map = (state[ESCROW.returned] ?? {}) as Record<string, number>;
  return BigInt(map[keyHex] ?? 0);
}

/** Takes back everything that was returned to this wallet. */
export async function takeReturned(wallet: Wallet, onStage?: (s: string) => void): Promise<TxOutcome> {
  const instructions = [call(CONFIG.escrow, "take_returned", [lit(wallet.publicKey)]), toWorkspace, call(wallet.componentAddress, "deposit", [workspace0])];
  return run(wallet, instructions, 40_000n, onStage);
}

/** Declines a waiting gift (from the linked wallet). It goes back to its sender. */
export async function declineDeposit(wallet: Wallet, did: string, d: Deposit, onStage?: (s: string) => void): Promise<TxOutcome> {
  const args = [lit(did), lit(fromHex(d.sender)), amountLiteral(d.amount), lit(d.refundEpoch)];
  return run(wallet, [call(CONFIG.claim, "decline", args)], 60_000n, onStage);
}

export async function declineDepositSponsored(wallet: Wallet, did: string, d: Deposit, onStage?: (s: string) => void): Promise<TxOutcome> {
  const account = builtinOnly(wallet);
  return sendSponsored(
    account,
    (b) => b.addFeeInstruction(call(CONFIG.claim, "decline_sponsored", [lit(did), lit(fromHex(d.sender)), amountLiteral(d.amount), lit(d.refundEpoch), amountLiteral(SPONSOR_FEE)])),
    onStage,
  );
}

/** Sends gifts that can no longer pay (phrase gifts nobody answered for about three days) back to their senders. Anyone may do it. */
export async function sweepDeposits(wallet: Wallet, did: string, onStage?: (s: string) => void): Promise<TxOutcome> {
  return run(wallet, [call(CONFIG.claim, "sweep", [lit(did)])], 60_000n, onStage);
}

/** The account component behind a wallet address (otl_…). */
export const accountOf = (walletAddress: string): string => componentAddressFromWalletAddress(walletAddress);

/** Proves again that the claim post is still up, once a deposit's hold time has passed. */
export async function confirmClaim(wallet: Wallet, proof: ClaimProof, onStage?: (s: string) => void): Promise<TxOutcome> {
  const instructions = [call(CONFIG.claim, "confirm_claim", [lit(proof.did), lit(proof.ops), lit(proof.commit), lit(proof.nodes), lit(proof.record), lit(proof.rkey)])];
  return run(wallet, instructions, 120_000n, onStage);
}

/** Shows the registry an account's current operation chain, so proofs made with an older one are refused from then on. */
export async function observeChain(wallet: Wallet, did: string, ops: Uint8Array[], onStage?: (s: string) => void): Promise<TxOutcome> {
  return run(wallet, [call(CONFIG.link, "observe_chain", [lit(did), lit(ops)])], 120_000n, onStage);
}

/** Cancels a pending claim by presenting the account's newer operation chain (during its challenge window). */
export async function challengeClaim(wallet: Wallet, did: string, ops: Uint8Array[], onStage?: (s: string) => void): Promise<TxOutcome> {
  return run(wallet, [call(CONFIG.claim, "challenge", [lit(did), lit(ops)])], 120_000n, onStage);
}

/** Cancels a link that hasn't taken effect yet by presenting the account's newer operation chain. */
export async function challengeBind(wallet: Wallet, did: string, ops: Uint8Array[], onStage?: (s: string) => void): Promise<TxOutcome> {
  return run(wallet, [call(CONFIG.link, "challenge_bind", [lit(did), lit(ops)])], 120_000n, onStage);
}

/** Why `address` can't be paid from `own` (a wallet address on the same network), or null when it can. */
export function addressProblem(address: string, own: string): string | null {
  if (!address) return "Paste the address you want to send to.";
  try {
    parseOotleAddress(address);
  } catch {
    return "That doesn't look like a Tari address. It should start with otl_.";
  }
  const net = (a: string) => a.split("_").slice(0, 2).join("_");
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
  const [epoch, escrow] = await Promise.all([provider.getCurrentEpoch(), stateOf(provider, CONFIG.escrow)]);
  const all = (escrow[ESCROW.deposits] ?? {}) as Record<string, Cbor[][]>;
  const items: SentDeposit[] = [];
  for (const did of Object.keys(all)) {
    for (const d of claimDeposits(escrow, did)) {
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
export async function readDeliveredBy(provider: IndexerProvider, keyHex: string): Promise<Delivered[]> {
  requireDeployed();
  const claim = await stateOf(provider, CONFIG.claim);
  const all = (claim[CLAIM.delivered] ?? {}) as Record<string, Cbor[][]>;
  const out: Delivered[] = [];
  for (const [did, list] of Object.entries(all)) {
    for (const d of list) if (bytesHex(d[0]) === keyHex) out.push({ did, amount: BigInt(d[1] as number), epoch: Number(d[2]) });
  }
  return out.sort((a, b) => b.epoch - a.epoch);
}

/** Takes a deposit back. The escrow wants its position in the recipient's list, so find it fresh each time. */
export async function refundDeposit(wallet: Wallet, provider: IndexerProvider, d: SentDeposit, onStage?: (s: string) => void): Promise<TxOutcome> {
  const esc = await readEscrow(provider, d.did);
  const mine = toHex(wallet.publicKey);
  const found = esc.deposits.find((x) => x.sender === mine && x.amount === d.amount && x.refundEpoch === d.refundEpoch && x.created === d.created && x.challenge === d.challenge);
  if (!found) throw new ChainError("That deposit was already collected or taken back.");
  if (esc.epoch < d.refundEpoch) throw new ChainError("It can't be taken back yet.");
  const instructions = [call(CONFIG.escrow, "refund", [lit(d.did), lit(found.index)]), toWorkspace, call(wallet.componentAddress, "deposit", [workspace0])];
  return run(wallet, instructions, 30_000n, onStage);
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
export async function readBudget(provider: IndexerProvider, did: string, ownerKeyHex: string): Promise<Budget | null> {
  requireDeployed();
  const tip = await stateOf(provider, CONFIG.tip);
  const b = (tip[TIP.budgets] as Record<string, Cbor[]> | undefined)?.[`${did}:${ownerKeyHex}`];
  return b ? budgetOf(b) : null;
}

export async function openBudget(
  wallet: Wallet,
  p: { did: string; amount: bigint; window: number; refundAfter: number; maxTip: bigint },
  onStage?: (s: string) => void,
): Promise<TxOutcome> {
  const instructions = [
    call(wallet.componentAddress, "withdraw", [resourceAddressLiteral(TARI_RESOURCE_ADDRESS), amountLiteral(p.amount)]),
    toWorkspace,
    call(CONFIG.tip, "open_budget", [lit(p.did), lit(wallet.publicKey), lit(p.window), lit(p.refundAfter), amountLiteral(p.maxTip), workspace0]),
  ];
  return run(wallet, instructions, 40_000n, onStage);
}

export async function closeBudget(wallet: Wallet, did: string, amount: bigint, onStage?: (s: string) => void): Promise<TxOutcome> {
  const instructions = [
    call(CONFIG.tip, "close_budget", [lit(did), lit(wallet.publicKey), amountLiteral(amount)]),
    toWorkspace,
    call(wallet.componentAddress, "deposit", [workspace0]),
  ];
  return run(wallet, instructions, 30_000n, onStage);
}

/** Relays someone's tip post to TipPolicy. Anyone can do this: the post's signature is the authority; the relayer pays the fee. */
export async function relayTip(wallet: Wallet, proof: ClaimProof, ownerKey: Uint8Array, onStage?: (s: string) => void): Promise<TxOutcome> {
  const instructions = [call(CONFIG.tip, "tip", [lit(proof.did), lit(ownerKey), lit(proof.ops), lit(proof.commit), lit(proof.nodes), lit(proof.record), lit(proof.rkey)])];
  return run(wallet, instructions, 120_000n, onStage);
}

/** Every budget funded for `did`, by any owner: [ownerKeyHex, budget]. */
export async function readBudgetsFor(provider: IndexerProvider, did: string): Promise<[string, Budget][]> {
  requireDeployed();
  const tip = await stateOf(provider, CONFIG.tip);
  const map = (tip[TIP.budgets] ?? {}) as Record<string, Cbor[]>;
  return Object.entries(map)
    .filter(([k]) => k.startsWith(`${did}:`))
    .map(([k, b]) => [k.slice(did.length + 1), budgetOf(b)]);
}

// ---- sponsored transactions: the escrow's fee vault pays, so the claimant needs no funds ----------------

/** Fee ceiling offered per sponsored call (µT). The escrow caps it too, and refunds what isn't used. */
export const SPONSOR_FEE = 60_000n;

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
): Promise<TxOutcome> {
  requireDeployed();
  const provider = await account.getProvider();
  const network = toOotleNetwork(CONFIG.network);
  const signer = (account as unknown as { signer: Parameters<typeof sendTransaction>[1] }).signer;
  const dryRun = (account as unknown as {
    submitDryRun(p: IndexerProvider, tx: unknown, extra: unknown[]): Promise<unknown>;
  }).submitDryRun.bind(account);
  const maxEpoch = await resolveMaxEpoch(provider);
  let inputs = await resolveInputsWithRetry(provider, [
    { substate_id: CONFIG.claim, version: null },
    { substate_id: CONFIG.escrow, version: null },
  ]);
  const seen = new Set<string>();
  for (let attempt = 0; ; attempt++) {
    const build = () => {
      const b = TransactionBuilder.new(network, maxEpoch);
      fill(b as unknown as Raw);
      b.withInputs(inputs);
      return b.buildUnsignedTransaction();
    };
    try {
      onStage?.("Checking it works…");
      try {
        const dry = await dryRun(provider, build(), []);
        assertAccepted(dry);
      } catch (e) {
        if (!tolerateEpochLag || !isWindowOpen(e)) throw e;
        onStage?.("The pre-check is one epoch behind. Sending anyway…");
      }
      onStage?.("Sending to the network…");
      const res = (await sendTransaction(provider, signer, build())) as unknown as { transaction_id?: unknown };
      assertAccepted(res);
      return { transactionId: String(res.transaction_id ?? "") };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const missing = extractMissingSubstateAddress(msg);
      if (!missing || seen.has(missing) || attempt >= 14) throw e;
      seen.add(missing);
      const [resolved] = await resolveInputsWithRetry(provider, [{ substate_id: missing, version: null }]);
      inputs = [...inputs, resolved!];
    }
  }
}

export async function confirmClaimSponsored(wallet: Wallet, proof: ClaimProof, onStage?: (s: string) => void): Promise<TxOutcome> {
  const account = builtinOnly(wallet);
  return sendSponsored(
    account,
    (b) =>
      b.addFeeInstruction(
        call(CONFIG.claim, "confirm_claim_sponsored", [lit(proof.did), lit(proof.ops), lit(proof.commit), lit(proof.nodes), lit(proof.record), lit(proof.rkey), amountLiteral(SPONSOR_FEE)]),
      ),
    onStage,
  );
}

export async function startClaimSponsored(wallet: Wallet, proof: ClaimProof, onStage?: (s: string) => void): Promise<TxOutcome> {
  const account = builtinOnly(wallet);
  const pk = wallet.publicKey;
  return sendSponsored(
    account,
    (b) =>
      b.addFeeInstruction(
        call(CONFIG.claim, "start_claim_sponsored", [lit(proof.did), lit(pk), lit(proof.ops), lit(proof.commit), lit(proof.nodes), lit(proof.record), lit(proof.rkey), amountLiteral(SPONSOR_FEE)]),
      ),
    onStage,
  );
}

/** Pays out into the claimant's account, creating it in the same transaction if it doesn't exist yet. */
export async function finalizeClaimSponsored(wallet: Wallet, did: string, onStage?: (s: string) => void, payableByEpoch = false): Promise<TxOutcome> {
  const account = builtinOnly(wallet);
  const pk = wallet.publicKey;
  return sendSponsored(
    account,
    (b) => {
      b.addFeeInstruction(call(CONFIG.claim, "sponsor_finalize", [lit(did), amountLiteral(SPONSOR_FEE)]));
      b.addInstruction(call(CONFIG.claim, "finalize_claim", [lit(did)]));
      b.addInstruction(toWorkspace);
      b.addInstruction({ CreateAccount: { owner_public_key: toHex(pk), owner_rule: null, access_rules: null, bucket_workspace_id: { id: 0, offset: null } } });
    },
    onStage,
    payableByEpoch,
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
