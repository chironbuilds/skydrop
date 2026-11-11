/**
 * The wallet Skydrop signs with. Two kinds:
 *  - "builtin": a recovery key kept in this browser. Supports sponsored (walletless) claims because Skydrop
 *    holds the signing key and can build the fee phase itself.
 *  - "sapient": the Sapient browser extension (`window.tari`). Keys never leave the extension and every
 *    transaction is approved in its own popup.
 */
import { extractMissingSubstateAddress, forgetKnownVersions, markShieldedOutputSpent, type OotleAccount } from "@chironbuilder/ootle-sdk";
import { Network, TARI_RESOURCE_ADDRESS } from "@tari-project/ootle";
import { parseOotleAddress } from "@tari-project/ootle-wasm";
import { CONFIG } from "./config";

/** Substate ids as transaction inputs: `id` at its latest version, or `id@N` pinned to version N. */
const requirements = (ids: string[]) => {
  // One entry per substate (a pinned version wins): a duplicate input makes the whole transaction unparseable.
  const byId = new Map<string, number | null>();
  for (const s of ids) {
    const [id, v] = s.split("@");
    const version = v === undefined ? null : Number(v);
    if (!byId.has(id!) || version !== null) byId.set(id!, version);
  }
  return [...byId].map(([substate_id, version]) => ({ substate_id, version }));
};

/**
 * An input the network says was already spent at the version we sent: "Input substate X (vN) is down" (indexer) or
 * "Substate X:N is DOWN" (lock failure). The next try must ask for N+1; the latest the indexer reports can lag.
 */
export function staleInput(message: string): { id: string; next: number } | null {
  // Ids can have more than one part: an NFT is "nft_<resource>_uuid_<id>" (or _u64_, _str_, ...).
  const id = "([a-z]+_[0-9a-f]{16,}(?:_[a-z0-9]+_[0-9a-zA-Z]+)?)";
  const m = new RegExp(`substate ${id} \\(v(\\d+)\\) is down`, "i").exec(message) ?? new RegExp(`Substate ${id}:(\\d+) is (?:not found or )?DOWN`, "i").exec(message);
  return m ? { id: m[1]!, next: Number(m[2]) + 1 } : null;
}

/**
 * A send refused before it went anywhere because an input changed since it was looked up: the indexer answers HTTP 400
 * "Input substate X (vN) is down" and the transaction is never broadcast, so nothing was charged and it can be sent again
 * with the newer version. (A rejection after execution says something else, and is never retried: its fee is spent.)
 */
export const refusedStale = (e: unknown): { id: string; next: number } | null => {
  const m = e instanceof Error ? e.message : String(e);
  return /HTTP 400/.test(m) ? staleInput(m) : null;
};

/** The SDK's network value, which keys its cache of substate versions. */
const sdkNet = () => (CONFIG.network === "mainnet" ? Network.MainNet : Network.Esmeralda);

/** `inputs` with `id` pinned to version `v`, added if it wasn't there. */
export const pinInput = (inputs: string[], id: string, v: number): string[] => [...inputs.filter((s) => s.split("@")[0] !== id), `${id}@${v}`];

export interface ExecOptions {
  maxFee: bigint;
  dryRun?: boolean;
  /** Substates the transaction touches that the engine can't find by itself (resources, NFT records). */
  inputs?: string[];
}

export interface Wallet {
  kind: "builtin" | "sapient";
  /** Public key that signs transactions and that claim codes and deposits are bound to. */
  publicKey: Uint8Array;
  /** The account component that holds this wallet's tokens. */
  componentAddress: string;
  /** bech32m address others pay to. */
  walletAddress: string;
  balance(): Promise<bigint>;
  execute(instructions: unknown[], opts: ExecOptions): Promise<unknown>;
  /**
   * Moves `amount` TARI out of the wallet into `followUp` in one transaction: the funds are a bucket at workspace
   * id 1. TARI is a stealth resource, so a plain `withdraw` call can't do this. `related` lists the other substates
   * the follow-up touches.
   */
  executeFunded(amount: bigint, followUp: unknown[], related: string[], opts: ExecOptions): Promise<unknown>;
  /** The built-in account, when Skydrop can build fee-phase transactions with its key. */
  account: OotleAccount | null;
}

// ---- Sapient ------------------------------------------------------------------------------------------------

interface TariProvider {
  isTariWallet?: boolean;
  request(args: { method: string; params?: unknown }): Promise<any>;
}

declare global {
  interface Window {
    tari?: TariProvider;
  }
}

const jsonSafe = <T>(v: T): T => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));

/** Resolves the injected provider, waiting briefly because the extension injects after page load. */
export function waitForSapient(timeoutMs = 1500): Promise<TariProvider | null> {
  if (window.tari) return Promise.resolve(window.tari);
  return new Promise((resolve) => {
    const done = () => {
      removeEventListener("tari#initialized", done);
      resolve(window.tari ?? null);
    };
    addEventListener("tari#initialized", done, { once: true });
    setTimeout(done, timeoutMs);
  });
}

const SAPIENT_NETWORK: Record<string, string> = { esmeralda: "esmeralda", mainnet: "mainnet" };

/**
 * Connects to Sapient. `prompt: false` only reuses an existing connection (no popup) and returns null if there
 * isn't one, which is what a page reload wants.
 */
export async function connectSapient(prompt: boolean): Promise<Wallet | null> {
  const tari = await waitForSapient();
  if (!tari) return null;
  let accounts: string[] = await tari.request({ method: "tari_getAccounts" }).catch(() => []);
  if (!accounts.length) {
    if (!prompt) return null;
    accounts = await tari.request({ method: "tari_requestAccounts" });
  }
  const componentAddress = accounts[0];
  if (!componentAddress) throw new Error("Sapient didn't return an account.");
  const network: string = await tari.request({ method: "tari_getNetwork" });
  if (network !== SAPIENT_NETWORK[CONFIG.network]) {
    throw new Error(`Sapient is on ${network}. Switch it to ${CONFIG.network} and try again.`);
  }
  const walletAddress: string = await tari.request({ method: "tari_getWalletAddress" });
  const publicKey = new Uint8Array(parseOotleAddress(walletAddress).owner_key);

  const wallet: Wallet = {
    kind: "sapient",
    publicKey,
    componentAddress,
    walletAddress,
    account: null,
    async balance() {
      try {
        const all: { resourceAddress: string; amount: string }[] = await tari.request({ method: "tari_getBalances" });
        const t = all.find((b) => b.resourceAddress === TARI_RESOURCE_ADDRESS);
        return t ? BigInt(t.amount) : 0n;
      } catch {
        return 0n;
      }
    },
    async execute(instructions, { maxFee, dryRun, inputs }) {
      const params = { kind: "instructions", instructions: jsonSafe(instructions), maxFee: maxFee.toString(), ...(inputs?.length ? { inputs: requirements(inputs) } : {}) };
      if (dryRun) {
        return tari.request({ method: "tari_signAndSubmitTransaction", params: { ...params, dryRun: true } });
      }
      const { requestId } = await tari.request({ method: "tari_createTransactionRequest", params });
      for (;;) {
        await new Promise((r) => setTimeout(r, 700));
        const rec = await tari.request({ method: "tari_getTransactionRequest", params: { requestId } });
        if (rec.status === "pending") continue;
        if (rec.status !== "approved") throw new Error(rec.error ?? "You declined the transaction in Sapient.");
        break;
      }
      return tari.request({ method: "tari_submitTransactionRequest", params: { requestId } });
    },
    async executeFunded(amount, followUp, related, { maxFee, dryRun }) {
      // Sapient checks a funded transaction itself before showing it for approval.
      if (dryRun) return {};
      const params = {
        kind: "withdrawStealthAndExecute",
        resourceAddress: TARI_RESOURCE_ADDRESS,
        amount: amount.toString(),
        workspaceVarName: "funds",
        followUpInstructions: jsonSafe(followUp),
        relatedComponents: related,
        maxFee: maxFee.toString(),
      };
      const { requestId } = await tari.request({ method: "tari_createTransactionRequest", params });
      for (;;) {
        await new Promise((r) => setTimeout(r, 700));
        const rec = await tari.request({ method: "tari_getTransactionRequest", params: { requestId } });
        if (rec.status === "pending") continue;
        if (rec.status === "rejected") throw new Error("You declined the transaction in Sapient.");
        if (rec.status === "failed") throw new Error(rec.error ?? "Sapient couldn't send the transaction.");
        if (rec.status === "submitted") return rec.result;
        break;
      }
      return tari.request({ method: "tari_submitTransactionRequest", params: { requestId } });
    },
  };
  return wallet;
}

export function onSapientAccountChange(fn: () => void): void {
  addEventListener("tari#accountsChanged", fn);
}

export async function disconnectSapient(): Promise<void> {
  try {
    await window.tari?.request({ method: "tari_disconnect" });
  } catch {
    /* already disconnected */
  }
}

// ---- built-in ------------------------------------------------------------------------------------------------

const PRIVATE_FEE = { kind: "private", feeResourceAddress: TARI_RESOURCE_ADDRESS } as const;
/** Fee ceiling for moving a private output into the account. */
const MOVE_FEE = 100_000n;

type Output = { commitment: string; amount: string };

async function publicTari(account: OotleAccount): Promise<bigint> {
  try {
    return (await account.getBalances()).find((b) => b.resourceAddress === TARI_RESOURCE_ADDRESS)?.amount ?? 0n;
  } catch {
    return 0n; // no account on-chain yet
  }
}

const privateOutputs = async (account: OotleAccount): Promise<Output[]> =>
  (await account.listUnspentShieldedOutputs(TARI_RESOURCE_ADDRESS)).sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1));

/** The smallest private output that alone covers `fee`: what the SDK picks for a private fee. */
function feeOutput(outs: Output[], fee: bigint): Output | undefined {
  return outs.filter((o) => BigInt(o.amount) >= fee).sort((a, b) => (BigInt(a.amount) > BigInt(b.amount) ? 1 : -1))[0];
}

/** Public balance pays the fee when it can; otherwise one private output does. */
async function feeTypeFor(account: OotleAccount, fee: bigint): Promise<typeof PRIVATE_FEE | undefined> {
  if ((await publicTari(account)) >= fee) return undefined;
  return feeOutput(await privateOutputs(account), fee) ? PRIVATE_FEE : undefined;
}

/**
 * Moves private outputs, largest first, into the account's public balance until it holds `target`. Each move reveals
 * one whole output into the account (creating the account the first time). Its fee comes from the public balance or
 * from a different private output: an output can't pay for its own move.
 */
async function movePrivateToPublic(account: OotleAccount, target: bigint): Promise<void> {
  const accountAddress = await account.getComponentAddress();
  const ownerKey = Array.from(await account.getPublicKey(), (b) => b.toString(16).padStart(2, "0")).join("");
  let pub = await publicTari(account);
  if (pub >= target) return;
  const exists = await account
    .getProvider()
    .then((p) => p.getSubstate(accountAddress))
    .then(() => true, () => false);
  if (!exists) {
    // Redeeming an output looks the account up first, so a wallet funded only by payments to its address needs its
    // account created on its own, paid privately.
    if (!feeOutput(await privateOutputs(account), MOVE_FEE)) throw new Error("not enough TARI in this wallet");
    const create = [{ CreateAccount: { owner_public_key: ownerKey, owner_rule: null, access_rules: null, bucket_workspace_id: null } }];
    await account.execute(create as Parameters<OotleAccount["execute"]>[0], { maxFee: MOVE_FEE, feeType: PRIVATE_FEE });
  }
  const into = [{ CallMethod: { call: { Address: accountAddress }, method: "deposit", args: [{ Workspace: { id: 0, offset: null } }] } }];
  for (const o of await privateOutputs(account)) {
    if (pub >= target) return;
    let feeType: typeof PRIVATE_FEE | undefined;
    if (pub < MOVE_FEE) {
      const payer = feeOutput((await privateOutputs(account)).filter((x) => x.commitment !== o.commitment), MOVE_FEE);
      if (!payer) throw new Error("This wallet's TARI is in a single private payment, which can't pay its own fee. Send it a second small amount (0.2 TARI is enough), then try again.");
      feeType = PRIVATE_FEE;
    }
    await account.redeemStealthOutputAndExecute(TARI_RESOURCE_ADDRESS, o.commitment, BigInt(o.amount), into as never, [], MOVE_FEE, feeType);
    await markShieldedOutputSpent(account.ledgerId, o.commitment);
    pub = await publicTari(account);
  }
  if (pub < target) throw new Error("not enough TARI in this wallet");
}

const failure = (r: unknown): string | null => {
  const text = JSON.stringify(r ?? null, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
  return /Reject/.test(text) ? text.slice(0, 600) : null;
};

export async function builtinWallet(account: OotleAccount, balance: () => Promise<bigint>): Promise<Wallet> {
  return {
    kind: "builtin",
    publicKey: await account.getPublicKey(),
    componentAddress: await account.getComponentAddress(),
    walletAddress: await account.getWalletAddress(),
    account,
    balance,
    execute: async (instructions, { maxFee, dryRun, inputs }) =>
      account.execute(instructions as Parameters<OotleAccount["execute"]>[0], {
        maxFee,
        dryRun,
        inputs: inputs && requirements(inputs),
        feeType: await feeTypeFor(account, maxFee),
        // A dry run must report a missing substate, not quietly add it: the real send has to carry the same inputs,
        // or it fails after the fee is taken. The caller collects what's missing and sends with exactly that list.
        ...(dryRun ? { maxRetries: 0 } : {}),
      } as never),
    async executeFunded(amount, followUp, related, { maxFee, dryRun }) {
      if ((await publicTari(account)) < amount + maxFee) {
        if (dryRun) return {}; // moving private funds spends fees, so only the real send does it
        await movePrivateToPublic(account, amount + maxFee);
      }
      // The SDK's funded call doesn't add missing inputs by itself: find them with dry runs first.
      const inputs = [...related];
      const follow = followUp as Parameters<OotleAccount["withdrawStealthAndExecute"]>[3];
      for (let i = 0; ; i++) {
        let why: string | null;
        try {
          why = failure(await account.dryRunWithdrawStealthAndExecute(TARI_RESOURCE_ADDRESS, amount, "funds", follow, inputs, maxFee));
        } catch (e) {
          why = e instanceof Error ? e.message : String(e);
        }
        if (!why) break;
        // This call asks for the latest version; a stale one needs the indexer to catch up, or the SDK to stop
        // preferring its own (older) cached version of it.
        const st = staleInput(why);
        if (st && i < 12) {
          await forgetKnownVersions([st.id], sdkNet()).catch(() => undefined);
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        const missing = extractMissingSubstateAddress(why);
        if (!missing || inputs.includes(missing) || i >= 12) throw new Error(why);
        inputs.push(missing);
      }
      if (dryRun) return {};
      // Another transaction can update an input between the check and the send (a record being created, say): the
      // indexer then refuses the send before it goes anywhere, and it's sent again once that input has moved on.
      for (let i = 0; ; i++) {
        try {
          return await account.withdrawStealthAndExecute(TARI_RESOURCE_ADDRESS, amount, "funds", follow, inputs, maxFee);
        } catch (e) {
          const st = refusedStale(e);
          if (!st || i >= 4) throw e;
          await forgetKnownVersions([st.id], sdkNet()).catch(() => undefined);
          await new Promise((r) => setTimeout(r, 2_000));
        }
      }
    },
  };
}

// ---- remembering the choice -------------------------------------------------------------------------------

const KIND_KEY = "skydrop.wallet.kind";

export const savedKind = (): "builtin" | "sapient" => {
  try {
    return localStorage.getItem(KIND_KEY) === "sapient" ? "sapient" : "builtin";
  } catch {
    return "builtin";
  }
};

export const saveKind = (k: "builtin" | "sapient"): void => {
  try {
    localStorage.setItem(KIND_KEY, k);
  } catch {
    /* choice just isn't remembered */
  }
};
