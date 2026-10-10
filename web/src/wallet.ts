/**
 * The wallet Skydrop signs with. Two kinds:
 *  - "builtin": a recovery key kept in this browser. Supports sponsored (walletless) claims because Skydrop
 *    holds the signing key and can build the fee phase itself.
 *  - "sapient": the Sapient browser extension (`window.tari`). Keys never leave the extension and every
 *    transaction is approved in its own popup.
 */
import type { OotleAccount } from "@chironbuilder/ootle-sdk";
import { TARI_RESOURCE_ADDRESS } from "@tari-project/ootle";
import { parseOotleAddress } from "@tari-project/ootle-wasm";
import { CONFIG } from "./config";

export interface ExecOptions {
  maxFee: bigint;
  dryRun?: boolean;
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

const SAPIENT_NETWORK: Record<string, string> = { esmeralda: "esmeralda" };

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
    async execute(instructions, { maxFee, dryRun }) {
      const params = { kind: "instructions", instructions: jsonSafe(instructions), maxFee: maxFee.toString() };
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

export async function builtinWallet(account: OotleAccount, balance: () => Promise<bigint>): Promise<Wallet> {
  return {
    kind: "builtin",
    publicKey: await account.getPublicKey(),
    componentAddress: await account.getComponentAddress(),
    walletAddress: await account.getWalletAddress(),
    account,
    balance,
    execute: (instructions, { maxFee, dryRun }) =>
      account.execute(instructions as Parameters<OotleAccount["execute"]>[0], { maxFee, dryRun }),
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
