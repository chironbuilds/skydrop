import {
  OotleAccount,
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
import { CONFIG } from "./config";
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

// ---- reading the escrow -----------------------------------------------------------------------------------

export interface Deposit {
  sender: string;
  amount: bigint;
  refundEpoch: number;
  window: number;
  /** A phrase the claim post must contain for this deposit to pay out. Empty if none. */
  challenge: string;
}

export interface Pending {
  claimant: string;
  len: number;
  start: number;
}

export interface Escrow {
  epoch: number;
  deposits: Deposit[];
  pending: Pending | null;
  maxWindow: number;
  /** The text of the post the pending claim was proven with. */
  claimText: string;
  /** The Ootle account this Bluesky account has linked, if one is in effect now. Funds that need no window or phrase go straight to it. */
  binding: string | null;
}

type Cbor = unknown;
const bytesHex = (v: Cbor): string => (v as { hex: string }).hex;

export async function readEscrow(provider: IndexerProvider, did: string): Promise<Escrow> {
  const [epoch, sub] = await Promise.all([provider.getCurrentEpoch(), provider.getSubstate(CONFIG.component)]);
  const comp = (sub.substate as { Component?: { body: { state: Cbor[] } } }).Component;
  if (!comp) throw new Error("The escrow contract could not be read");
  const state = comp.body.state;
  // state: [vault, min_deposit, max_window, deposits, pending, known_len]
  const deposits = (state[3] as Record<string, Cbor[][]>)[did] ?? [];
  const pend = (state[4] as Record<string, Cbor[]>)[did];
  return {
    epoch,
    maxWindow: Number(state[2]),
    deposits: deposits.map((d) => ({ sender: bytesHex(d[0]), amount: BigInt(d[1] as number), refundEpoch: Number(d[2]), window: Number(d[3]), challenge: String(d[4] ?? "") })),
    pending: pend ? { claimant: bytesHex(pend[0]), len: Number(pend[2]), start: Number(pend[3]) } : null,
    claimText: String((state[11] as Record<string, string> | undefined)?.[did] ?? ""),
    binding: bindingOf(state[12], did, epoch),
  };
}

/** A component address as the state stores it, written the way the wallet writes it. */
const addressText = (v: Cbor): string => (typeof v === "string" ? v : `component_${bytesHex(v)}`);

/** Component state index 12: DID -> [account, epoch it takes effect, the account it replaces or null]. */
function bindingOf(map: Cbor, did: string, epoch: number): string | null {
  const b = (map as Record<string, Cbor[]> | undefined)?.[did];
  if (!b) return null;
  if (epoch >= Number(b[1])) return addressText(b[0]);
  return b[2] ? addressText(b[2]) : null;
}

/** The account `did` has linked, if any. */
export async function readBinding(provider: IndexerProvider, did: string): Promise<string | null> {
  const [epoch, sub] = await Promise.all([provider.getCurrentEpoch(), provider.getSubstate(CONFIG.component)]);
  const comp = (sub.substate as { Component?: { body: { state: Cbor[] } } }).Component;
  return bindingOf(comp?.body.state[12], did, epoch);
}

/** Links the Bluesky account in `proof` to `address`: the proof is a post that carries the bind code for that address. */
export async function bindAccount(wallet: Wallet, proof: ClaimProof, address: string, onStage?: (s: string) => void): Promise<TxOutcome> {
  const instructions = [
    call(CONFIG.component, "bind", [lit(proof.did), componentAddressLiteral(address as never), lit(proof.ops), lit(proof.commit), lit(proof.nodes), lit(proof.record), lit(proof.rkey)]),
  ];
  return run(wallet, instructions, 120_000n, onStage);
}

/** What is payable right now to a claim that started at `start`. */
export function payableNow(e: Escrow, start: number): { amount: bigint; waitingAmount: bigint; nextEpoch: number | null; missing: string[] } {
  let amount = 0n;
  let waitingAmount = 0n;
  let next: number | null = null;
  const missing = new Set<string>();
  for (const d of e.deposits) {
    const ready = start + d.window;
    if (d.challenge && !e.claimText.includes(d.challenge)) {
      // pays only once the claim post says it; the claimant has to post again
      missing.add(d.challenge);
    } else if (e.epoch >= ready) amount += d.amount;
    else {
      waitingAmount += d.amount;
      next = next === null ? ready : Math.min(next, ready);
    }
  }
  return { amount, waitingAmount, nextEpoch: next, missing: [...missing] };
}

/** TARI left in the vault that pays claimants' network fees. */
export async function readSponsorBalance(provider: IndexerProvider): Promise<bigint> {
  try {
    const sub = await provider.getSubstate(CONFIG.component);
    const state = (sub.substate as { Component: { body: { state: { value?: { hex: string } }[] } } }).Component.body.state;
    const vaultId = state[6]?.value?.hex;
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
    [/does not contain the claim code/i, "Your post doesn't contain the claim code. Post the exact text shown, then try again."],
    [/invalid repo proof/i, "The signed copy of your post didn't verify. Wait a few seconds after posting and try again."],
    [/invalid operation chain/i, "Your account's identity history didn't verify."],
    [/stale operation chain/i, "A newer version of this account's identity history exists. Refresh and try again."],
    [/nothing deposited/i, "Nothing is waiting for this account."],
    [/window is still open/i, "The network hasn't caught up to your claim yet. Wait a minute and press Collect again."],
    [/not enough|insufficient/i, "This wallet doesn't have enough tTARI to cover the amount plus network fees."],
    [/already claimed/i, "This wallet already used the faucet."],
    [/deposit below the minimum/i, `The smallest amount you can send is ${Number(CONFIG.minDeposit) / Number(CONFIG.unit)} ${CONFIG.symbol}.`],
    [/challenge window above the maximum/i, "That safety level isn't available."],
    [/Timed out/i, "The network is slow right now. Please try again."],
  ];
  for (const [re, text] of rules) if (re.test(m)) return text;
  return m.length > 220 ? `${m.slice(0, 220)}…` : m;
}

/** The contract refused a payout because, as far as the checking node knows, the safety window is still open. */
export const isWindowOpen = (e: unknown): boolean => /window is still open/i.test(e instanceof Error ? e.message : String(e));

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

type Instr = Parameters<OotleAccount["execute"]>[0];

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

export async function sendTip(
  wallet: Wallet,
  p: { did: string; amount: bigint; window: number; challenge?: string },
  epoch: number,
  onStage?: (s: string) => void,
): Promise<TxOutcome> {
  const owner = wallet.componentAddress;
  const pk = wallet.publicKey;
  const instructions = [
    call(owner, "withdraw", [resourceAddressLiteral(TARI_RESOURCE_ADDRESS), amountLiteral(p.amount)]),
    toWorkspace,
    call(CONFIG.component, "deposit", [lit(p.did), lit(pk), lit(epoch + CONFIG.refundAfterEpochs), lit(p.window), lit(p.challenge ?? ""), workspace0]),
  ];
  return run(wallet, instructions, 30_000n, onStage);
}

export async function startClaim(wallet: Wallet, proof: ClaimProof, onStage?: (s: string) => void): Promise<TxOutcome> {
  const pk = wallet.publicKey;
  const instructions = [
    call(CONFIG.component, "start_claim", [
      lit(proof.did),
      lit(pk),
      lit(proof.ops),
      lit(proof.commit),
      lit(proof.nodes),
      lit(proof.record),
      lit(proof.rkey),
    ]),
  ];
  return run(wallet, instructions, 120_000n, onStage);
}

export async function finalizeClaim(wallet: Wallet, did: string, onStage?: (s: string) => void, payableByEpoch = false): Promise<TxOutcome> {
  const owner = wallet.componentAddress;
  const instructions = [call(CONFIG.component, "finalize_claim", [lit(did)]), toWorkspace, call(owner, "deposit", [workspace0])];
  return run(wallet, instructions, 30_000n, onStage, payableByEpoch);
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
}

/** Every deposit whose sender is `keyHex`, found by scanning component state index 3. */
export async function readSentBy(provider: IndexerProvider, keyHex: string): Promise<{ epoch: number; items: SentDeposit[] }> {
  const [epoch, sub] = await Promise.all([provider.getCurrentEpoch(), provider.getSubstate(CONFIG.component)]);
  const comp = (sub.substate as { Component?: { body: { state: Cbor[] } } }).Component;
  if (!comp) throw new Error("The escrow contract could not be read");
  const all = comp.body.state[3] as Record<string, Cbor[][]>;
  const items: SentDeposit[] = [];
  for (const [did, list] of Object.entries(all)) {
    for (const d of list) {
      if (bytesHex(d[0]) === keyHex) items.push({ did, amount: BigInt(d[1] as number), refundEpoch: Number(d[2]), window: Number(d[3]), challenge: String(d[4] ?? "") });
    }
  }
  return { epoch, items };
}

/** Takes a deposit back. The contract wants its position in the recipient's list, so find it fresh each time. */
export async function refundDeposit(wallet: Wallet, provider: IndexerProvider, d: SentDeposit, onStage?: (s: string) => void): Promise<TxOutcome> {
  const esc = await readEscrow(provider, d.did);
  const mine = toHex(wallet.publicKey);
  const index = esc.deposits.findIndex((x) => x.sender === mine && x.amount === d.amount && x.refundEpoch === d.refundEpoch && x.window === d.window && x.challenge === d.challenge);
  if (index < 0) throw new ChainError("That deposit was already collected or taken back.");
  if (esc.epoch < d.refundEpoch) throw new ChainError("It can't be taken back yet.");
  const instructions = [call(CONFIG.component, "refund", [lit(d.did), lit(index)]), toWorkspace, call(wallet.componentAddress, "deposit", [workspace0])];
  return run(wallet, instructions, 30_000n, onStage);
}

// ---- tip budgets ------------------------------------------------------------------------------------------

export interface Budget {
  balance: bigint;
  window: number;
  refundAfter: number;
  maxTip: bigint;
}

/** The budget this wallet key funded for `did`, if any. Component state index 8: "did:ownerKeyHex" -> tuple. */
export async function readBudget(provider: IndexerProvider, did: string, ownerKeyHex: string): Promise<Budget | null> {
  const sub = await provider.getSubstate(CONFIG.component);
  const comp = (sub.substate as { Component?: { body: { state: Cbor[] } } }).Component;
  const map = comp?.body.state[8] as Record<string, Cbor[]> | undefined;
  const b = map?.[`${did}:${ownerKeyHex}`];
  if (!b) return null;
  return { balance: BigInt(b[0] as number), window: Number(b[1]), refundAfter: Number(b[2]), maxTip: BigInt(b[3] as number) };
}

export async function openBudget(
  wallet: Wallet,
  p: { did: string; amount: bigint; window: number; refundAfter: number; maxTip: bigint },
  onStage?: (s: string) => void,
): Promise<TxOutcome> {
  const instructions = [
    call(wallet.componentAddress, "withdraw", [resourceAddressLiteral(TARI_RESOURCE_ADDRESS), amountLiteral(p.amount)]),
    toWorkspace,
    call(CONFIG.component, "open_budget", [lit(p.did), lit(wallet.publicKey), lit(p.window), lit(p.refundAfter), amountLiteral(p.maxTip), workspace0]),
  ];
  return run(wallet, instructions, 40_000n, onStage);
}

export async function closeBudget(wallet: Wallet, did: string, amount: bigint, onStage?: (s: string) => void): Promise<TxOutcome> {
  const instructions = [
    call(CONFIG.component, "close_budget", [lit(did), lit(wallet.publicKey), amountLiteral(amount)]),
    toWorkspace,
    call(wallet.componentAddress, "deposit", [workspace0]),
  ];
  return run(wallet, instructions, 30_000n, onStage);
}

// ---- sponsored transactions: the escrow's fee vault pays, so the claimant needs no funds ----------------

/** Fee ceiling offered per sponsored call (µT). The contract caps it too, and refunds what isn't used. */
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
  const provider = await account.getProvider();
  const network = toOotleNetwork(CONFIG.network);
  const signer = (account as unknown as { signer: Parameters<typeof sendTransaction>[1] }).signer;
  const dryRun = (account as unknown as {
    submitDryRun(p: IndexerProvider, tx: unknown, extra: unknown[]): Promise<unknown>;
  }).submitDryRun.bind(account);
  const maxEpoch = await resolveMaxEpoch(provider);
  let inputs = await resolveInputsWithRetry(provider, [{ substate_id: CONFIG.component, version: null }]);
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

export async function startClaimSponsored(wallet: Wallet, proof: ClaimProof, onStage?: (s: string) => void): Promise<TxOutcome> {
  const account = builtinOnly(wallet);
  const pk = wallet.publicKey;
  return sendSponsored(
    account,
    (b) =>
      b.addFeeInstruction(
        call(CONFIG.component, "start_claim_sponsored", [
          lit(proof.did),
          lit(pk),
          lit(proof.ops),
          lit(proof.commit),
          lit(proof.nodes),
          lit(proof.record),
          lit(proof.rkey),
          amountLiteral(SPONSOR_FEE),
        ]),
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
      b.addFeeInstruction(call(CONFIG.component, "sponsor_finalize", [lit(did), amountLiteral(SPONSOR_FEE)]));
      b.addInstruction(call(CONFIG.component, "finalize_claim", [lit(did)]));
      b.addInstruction(toWorkspace);
      b.addInstruction({ CreateAccount: { owner_public_key: toHex(pk), owner_rule: null, access_rules: null, bucket_workspace_id: { id: 0, offset: null } } });
    },
    onStage,
    payableByEpoch,
  );
}

/**
 * Relays someone's tip post to the contract. Anyone can do this: the post's signature is the authority. The
 * network fee comes from the escrow's fee vault and is charged back to the tipper's budget.
 */
export async function relayTipSponsored(wallet: Wallet, proof: ClaimProof, ownerKey: Uint8Array, onStage?: (s: string) => void): Promise<TxOutcome> {
  const account = builtinOnly(wallet);
  return sendSponsored(
    account,
    (b) =>
      b.addFeeInstruction(
        call(CONFIG.component, "tip_sponsored", [
          lit(proof.did),
          lit(ownerKey),
          lit(proof.ops),
          lit(proof.commit),
          lit(proof.nodes),
          lit(proof.record),
          lit(proof.rkey),
          amountLiteral(SPONSOR_FEE),
        ]),
      ),
    onStage,
  );
}

/** Every budget funded for `did`, by any owner: [ownerKeyHex, budget]. Component state index 8. */
export async function readBudgetsFor(provider: IndexerProvider, did: string): Promise<[string, Budget][]> {
  const sub = await provider.getSubstate(CONFIG.component);
  const comp = (sub.substate as { Component?: { body: { state: Cbor[] } } }).Component;
  const map = (comp?.body.state[8] ?? {}) as Record<string, Cbor[]>;
  return Object.entries(map)
    .filter(([k]) => k.startsWith(`${did}:`))
    .map(([k, b]) => [k.slice(did.length + 1), { balance: BigInt(b[0] as number), window: Number(b[1]), refundAfter: Number(b[2]), maxTip: BigInt(b[3] as number) }]);
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
