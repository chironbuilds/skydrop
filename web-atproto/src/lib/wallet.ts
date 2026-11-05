/**
 * Sapient (and any other Tari wallet that announces itself the same way). Keys never leave the wallet: this page only
 * ever sees the account address and asks the wallet to approve transactions in its own popup.
 */
export interface TariProvider {
  isEmbedded?: boolean;
  info?: { name?: string; embedded?: boolean };
  request(args: { method: string; params?: unknown }): Promise<any>;
}

/** Typed locally rather than on Window, because Skydrop's older wallet module declares its own window.tari. */
const injected = (): { tari?: TariProvider; tariProviders?: TariProvider[] } => window as unknown as { tari?: TariProvider; tariProviders?: TariProvider[] };

export interface WalletState {
  available: boolean;
  connected: boolean;
  name: string;
  account: string | null;
  address: string | null;
  /** 64-hex public key: what campaigns record as their funder and what claim codes bind to. */
  key: string | null;
  network: string | null;
}

const state: WalletState = { available: false, connected: false, name: "Sapient", account: null, address: null, key: null, network: null };
let provider: TariProvider | null = null;
let ready: Promise<void> | null = null;
const listeners = new Set<(s: WalletState) => void>();

export const walletState = (): WalletState => ({ ...state });

/** Calls back now and on every change; returns a function that stops it. */
export function onWallet(fn: (s: WalletState) => void): () => void {
  listeners.add(fn);
  fn(walletState());
  return () => listeners.delete(fn);
}
const emit = () => listeners.forEach((fn) => fn(walletState()));

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32M = 0x2bc830a3;

function polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = (((chk & 0x1ffffff) << 5) ^ v) >>> 0;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk = (chk ^ GEN[i]!) >>> 0;
  }
  return chk;
}

/** The spend key from an Ootle address: bech32m, whose payload starts with the 32-byte spend key. */
export function keyFromAddress(address: string): string {
  const a = address.trim().toLowerCase();
  const sep = a.lastIndexOf("1");
  if (sep < 1 || a.length - sep < 8) throw new Error("That isn't an Ootle address.");
  const hrp = a.slice(0, sep);
  if (!hrp.startsWith("otl_")) throw new Error("That isn't an Ootle address.");
  const data = [...a.slice(sep + 1)].map((c) => CHARSET.indexOf(c));
  if (data.includes(-1)) throw new Error("That isn't an Ootle address.");
  const expanded = [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
  if (polymod([...expanded, ...data]) !== BECH32M) throw new Error("That address has a typo in it.");
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const v of data.slice(0, -6)) {
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 255);
    }
    acc &= (1 << bits) - 1;
  }
  if (out.length < 32) throw new Error("That address is too short.");
  return out.slice(0, 32).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function pick(): TariProvider | null {
  const w = injected();
  const all = (w.tariProviders ?? []).filter(Boolean);
  if (w.tari && !all.includes(w.tari)) all.unshift(w.tari);
  const framed = window.top !== window;
  const embedded = all.find((p) => p.isEmbedded || p.info?.embedded);
  const extension = all.find((p) => !(p.isEmbedded || p.info?.embedded));
  return (framed ? embedded ?? extension : extension ?? embedded) ?? null;
}

function detect(timeoutMs = 1200): Promise<void> {
  ready ??= new Promise((resolve) => {
    const done = () => {
      provider = pick();
      state.available = !!provider;
      if (provider?.info?.name) state.name = provider.info.name;
      resolve();
    };
    if (injected().tari || injected().tariProviders?.length) return done();
    const t = setTimeout(done, timeoutMs);
    const on = () => {
      clearTimeout(t);
      done();
    };
    addEventListener("tari#initialized", on, { once: true });
    addEventListener("tari:announceProvider", on, { once: true });
  });
  return ready;
}

export function friendly(err: unknown): string {
  const msg = String((err as Error)?.message ?? err ?? "");
  if (/locked/i.test(msg)) return "Your wallet is locked. Unlock it, then try again.";
  if (/not connected|requestAccounts first/i.test(msg)) return "This site isn't connected to your wallet yet.";
  if (/reject|denied|declined|cancel/i.test(msg)) return "You declined the request in your wallet.";
  if (/No wallet set up/i.test(msg)) return "Set up your wallet first, then come back.";
  return msg || "Something went wrong in the wallet.";
}

async function adopt(account: string | null): Promise<void> {
  state.account = account;
  state.connected = !!account;
  state.address = null;
  state.key = null;
  state.network = null;
  if (account && provider) {
    try {
      state.address = await provider.request({ method: "tari_getWalletAddress" });
      state.key = keyFromAddress(state.address!);
    } catch {
      /* the account is still usable for display */
    }
    state.network = await provider.request({ method: "tari_getNetwork" }).catch(() => null);
  }
  emit();
}

/** Reconnects with no popup if this site was approved before. Safe to call on every page load. */
export async function silentConnect(): Promise<void> {
  await detect();
  emit();
  if (!provider) return;
  try {
    const accounts: string[] = await provider.request({ method: "tari_getAccounts" });
    if (accounts?.length) await adopt(accounts[0]!);
  } catch {
    /* locked or not approved yet */
  }
  addEventListener("tari#accountsChanged", (e) => void adopt((e as CustomEvent<string[]>).detail?.[0] ?? null));
}

export async function connectWallet(): Promise<void> {
  await detect();
  if (!provider) throw new Error("NO_WALLET");
  try {
    const accounts: string[] = await provider.request({ method: "tari_requestAccounts" });
    await adopt(accounts?.[0] ?? null);
  } catch (e) {
    throw new Error(friendly(e));
  }
}

export async function disconnectWallet(): Promise<void> {
  try {
    await provider?.request({ method: "tari_disconnect" });
  } catch {
    /* already disconnected */
  }
  await adopt(null);
}

export const shortAddress = (a: string): string => (a.length > 20 ? `${a.slice(0, 12)}…${a.slice(-6)}` : a);

/** Revealed tTARI in the wallet, in µT, or null if the wallet won't say. */
export async function walletBalance(): Promise<bigint | null> {
  if (!provider || !state.connected) return null;
  try {
    const all: { resourceAddress: string; amount: string }[] = await provider.request({ method: "tari_getBalances" });
    const t = all.find((b) => b.resourceAddress === "resource_0101010101010101010101010101010101010101010101010101010101010101");
    return t ? BigInt(t.amount) : 0n;
  } catch {
    return null;
  }
}
