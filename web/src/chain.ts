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
  resolveMaxEpoch,
  resourceAddressLiteral,
  sendTransaction,
} from "@tari-project/ootle";
import type { IndexerProvider } from "@tari-project/ootle-indexer";
import { CONFIG } from "./config";
import { fromHex, lit, toHex } from "./cbor";
import type { ClaimProof } from "./bsky";

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
    deposits: deposits.map((d) => ({ sender: bytesHex(d[0]), amount: BigInt(d[1] as number), refundEpoch: Number(d[2]), window: Number(d[3]) })),
    pending: pend ? { claimant: bytesHex(pend[0]), len: Number(pend[2]), start: Number(pend[3]) } : null,
  };
}

/** What is payable right now to a claim that started at `start`. */
export function payableNow(e: Escrow, start: number): { amount: bigint; waitingAmount: bigint; nextEpoch: number | null } {
  let amount = 0n;
  let waitingAmount = 0n;
  let next: number | null = null;
  for (const d of e.deposits) {
    const ready = start + d.window;
    if (e.epoch >= ready) amount += d.amount;
    else {
      waitingAmount += d.amount;
      next = next === null ? ready : Math.min(next, ready);
    }
  }
  return { amount, waitingAmount, nextEpoch: next };
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
    [/window is still open/i, "The safety window hasn't passed yet."],
    [/not enough|insufficient/i, "This wallet doesn't have enough tTARI to cover the amount plus network fees."],
    [/already claimed/i, "This wallet already used the faucet."],
    [/deposit below the minimum/i, `The smallest amount you can send is ${Number(CONFIG.minDeposit) / Number(CONFIG.unit)} ${CONFIG.symbol}.`],
    [/challenge window above the maximum/i, "That safety level isn't available."],
    [/Timed out/i, "The network is slow right now. Please try again."],
  ];
  for (const [re, text] of rules) if (re.test(m)) return text;
  return m.length > 220 ? `${m.slice(0, 220)}…` : m;
}

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

async function run(account: OotleAccount, instructions: unknown[], maxFee: bigint, onStage?: (s: string) => void): Promise<TxOutcome> {
  onStage?.("Checking it works…");
  const dry = await account.execute(instructions as Instr, { dryRun: true, maxFee });
  assertAccepted(dry);
  onStage?.("Sending to the network…");
  const res = (await account.execute(instructions as Instr, { maxFee })) as { transaction_id?: unknown; transactionId?: unknown };
  assertAccepted(res);
  return { transactionId: String(res.transaction_id ?? res.transactionId ?? "") };
}

export async function sendTip(
  account: OotleAccount,
  p: { did: string; amount: bigint; window: number },
  epoch: number,
  onStage?: (s: string) => void,
): Promise<TxOutcome> {
  const owner = await account.getComponentAddress();
  const pk = await account.getPublicKey();
  const instructions = [
    call(owner, "withdraw", [resourceAddressLiteral(TARI_RESOURCE_ADDRESS), amountLiteral(p.amount)]),
    toWorkspace,
    call(CONFIG.component, "deposit", [lit(p.did), lit(pk), lit(epoch + CONFIG.refundAfterEpochs), lit(p.window), workspace0]),
  ];
  return run(account, instructions, 30_000n, onStage);
}

export async function startClaim(account: OotleAccount, proof: ClaimProof, onStage?: (s: string) => void): Promise<TxOutcome> {
  const pk = await account.getPublicKey();
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
  return run(account, instructions, 120_000n, onStage);
}

export async function finalizeClaim(account: OotleAccount, did: string, onStage?: (s: string) => void): Promise<TxOutcome> {
  const owner = await account.getComponentAddress();
  const instructions = [call(CONFIG.component, "finalize_claim", [lit(did)]), toWorkspace, call(owner, "deposit", [workspace0])];
  return run(account, instructions, 30_000n, onStage);
}

// ---- sponsored transactions: the escrow's fee vault pays, so the claimant needs no funds ----------------

/** Fee ceiling offered per sponsored call (µT). The contract caps it too, and refunds what isn't used. */
export const SPONSOR_FEE = 60_000n;

type Raw = { addFeeInstruction(i: unknown): unknown; addInstruction(i: unknown): unknown };

async function sendSponsored(
  account: OotleAccount,
  fill: (b: Raw) => void,
  onStage?: (s: string) => void,
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
      const dry = await dryRun(provider, build(), []);
      assertAccepted(dry);
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

export async function startClaimSponsored(account: OotleAccount, proof: ClaimProof, onStage?: (s: string) => void): Promise<TxOutcome> {
  const pk = await account.getPublicKey();
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
export async function finalizeClaimSponsored(account: OotleAccount, did: string, onStage?: (s: string) => void): Promise<TxOutcome> {
  const pk = await account.getPublicKey();
  return sendSponsored(
    account,
    (b) => {
      b.addFeeInstruction(call(CONFIG.component, "sponsor_finalize", [lit(did), amountLiteral(SPONSOR_FEE)]));
      b.addInstruction(call(CONFIG.component, "finalize_claim", [lit(did)]));
      b.addInstruction(toWorkspace);
      b.addInstruction({ CreateAccount: { owner_public_key: toHex(pk), owner_rule: null, access_rules: null, bucket_workspace_id: { id: 0, offset: null } } });
    },
    onStage,
  );
}

export async function useFaucet(account: OotleAccount): Promise<void> {
  await account.claimTestnetXtr(100_000n);
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
