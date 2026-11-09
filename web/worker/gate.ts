// Tip to unlock. A creator publishes a post whose body is encrypted; the key is held here and released
// only to a wallet that has paid the creator's Bluesky account through the Skydrop escrow.
//
//   POST /api/gate          creator stores {did, price, title, ciphertext, iv, key}      -> {id}
//   GET  /api/gate/<id>     public: {did, price, title, ciphertext, iv}  (never the key)
//   POST /api/unlock/<id>   viewer proves they hold the paying key, gets the key         -> {key}
//   GET  /u/<id>            a plain page for anyone without the extension
//
// Why a service at all: a chain keeps no secrets, so something has to hand over the key after payment.
// What it can and cannot do: it can see who unlocked what, and it could refuse to release after being paid;
// it cannot unlock for a wallet that hasn't paid, and it never sees the viewer's secret.
//
// Who is the payer: the escrow records the sender's public key with every deposit. The viewer signs a fresh
// challenge with that key (the wallet's ordinary ownership signature), so a stranger can't claim someone
// else's payment. The signature check is the same independent verifier the paylink dapp uses.
import { ristretto255 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { CONFIG } from "../src/config";
import { readCapped } from "../../web-atproto/worker/secure";

const { Point } = ristretto255;
const GROUP_ORDER = (1n << 252n) + 27742317777372353535851937790883648493n;

export const INDEXER = "https://ootle-indexer-a.tari.com";
/** Esmeralda's network byte, as signed into the wallet-ownership message. */
export const NETWORK_BYTE = 0x26;
const MAX_CIPHERTEXT = 32_768;
const MAX_TITLE = 80;
/** The ciphertext as hex or base64, plus the rest of a request. Nothing valid comes near this. */
const MAX_BODY = 128_000;
const MIN_PRICE = 1000n;
const MAX_PRICE = 100_000_000n;
/** How far a signed challenge's timestamp may be from now. */
const SKEW_MS = 5 * 60_000;
const TTL = 60 * 60 * 24 * 365;

// ---- Schnorr verification (byte-for-byte what tari-crypto's SchnorrSignature::verify does) -------------------

function u64le(n: number): Uint8Array {
  const b = new Uint8Array(8);
  let v = BigInt(n);
  for (let i = 0; i < 8; i++) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
}

class DomainSeparatedHasher {
  private chunks: Uint8Array[];
  constructor(domain: string, version: number, label: string, private dkLen: 32 | 64) {
    const tag = utf8ToBytes(`${domain}.v${version}.${label}`);
    this.chunks = [u64le(tag.length), tag];
  }
  chain(data: Uint8Array): this {
    this.chunks.push(u64le(data.length), data);
    return this;
  }
  finalize(): Uint8Array {
    return blake2b(concatBytes(...this.chunks), { dkLen: this.dkLen });
  }
}

const leScalar = (bytes: Uint8Array): bigint => {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]!);
  return n;
};

export function fromHex(hex: string): Uint8Array {
  if (!/^([0-9a-f]{2})*$/i.test(hex)) throw new Error("Malformed hex.");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** Must stay byte-identical to the wallet SDK's buildWalletOwnershipMessage. */
export function walletOwnershipMessage(networkByte: number, walletAddress: string, challenge: string): Uint8Array {
  return new DomainSeparatedHasher("com.tari.paylink.wallet_ownership_proof", 1, "v1", 64)
    .chain(new Uint8Array([networkByte]))
    .chain(utf8ToBytes(walletAddress))
    .chain(utf8ToBytes(challenge))
    .finalize();
}

export function schnorrVerify(publicKeyHex: string, publicNonceHex: string, signatureHex: string, message: Uint8Array): boolean {
  try {
    const nonce = fromHex(publicNonceHex);
    const key = fromHex(publicKeyHex);
    const sig = fromHex(signatureHex);
    if (nonce.length !== 32 || key.length !== 32 || sig.length !== 32) return false;
    const R = Point.fromBytes(nonce);
    const P = Point.fromBytes(key);
    if (P.equals(Point.ZERO)) return false;
    const s = leScalar(sig);
    if (s >= GROUP_ORDER) return false;
    const e = leScalar(new DomainSeparatedHasher("com.tari.schnorr_signature", 1, "challenge", 64).chain(nonce).chain(key).chain(message).finalize()) % GROUP_ORDER;
    return Point.BASE.multiply(s === 0n ? 0n : s).equals(R.add(P.multiply(e)));
  } catch {
    return false;
  }
}

// ---- storage + chain access, injectable so the logic is testable -----------------------------------------------

export interface GateStore {
  get(key: string, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
  put(key: string, value: ArrayBuffer, opts?: { expirationTtl?: number }): Promise<void>;
}

export interface GateDeps {
  store: GateStore;
  now: () => number;
  random: (n: number) => Uint8Array;
  /** GET a JSON document from the indexer. */
  indexer: (path: string) => Promise<unknown>;
}

export function liveDeps(store: GateStore): GateDeps {
  return {
    store,
    now: () => Date.now(),
    random: (n) => crypto.getRandomValues(new Uint8Array(n)),
    indexer: async (path) => {
      const r = await fetch(`${INDEXER}/${path}`, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`indexer ${r.status}`);
      return r.json();
    },
  };
}

interface GateRecord {
  did: string;
  price: string;
  title: string;
  ciphertext: string;
  iv: string;
  key: string;
  epoch: number;
  createdAt: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

async function load<T>(deps: GateDeps, key: string): Promise<T | null> {
  const buf = await deps.store.get(key, "arrayBuffer");
  return buf ? (JSON.parse(dec.decode(buf)) as T) : null;
}

async function save(deps: GateDeps, key: string, value: unknown): Promise<void> {
  const bytes = enc.encode(JSON.stringify(value));
  await deps.store.put(key, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { expirationTtl: TTL });
}

// ---- helpers -------------------------------------------------------------------------------------------------

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS } });

const fail = (status: number, error: string): Response => json({ error }, status);

const isPlcDid = (s: unknown): s is string => typeof s === "string" && /^did:plc:[a-z2-7]{24}$/.test(s);
const isId = (s: string): boolean => /^[0-9a-f]{32}$/.test(s);

const b64ToBytes = (s: string): Uint8Array => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/** True for standard base64 that decodes to exactly `bytes` bytes (or at most, with `max`). */
function b64Size(s: unknown, bytes: number, max = false): boolean {
  if (typeof s !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return false;
  try {
    const n = b64ToBytes(s).length;
    return max ? n > 0 && n <= bytes : n === bytes;
  } catch {
    return false;
  }
}

type Cbor = unknown;
const hexOf = (v: Cbor): string => (v as { hex?: string })?.hex ?? "";

async function componentState(deps: GateDeps, address: string): Promise<Cbor[]> {
  const sub = (await deps.indexer(`substates/${encodeURIComponent(address)}`)) as {
    state?: { up?: { substate?: { Component?: { body?: { state?: Cbor[] } } } } };
  };
  const state = sub.state?.up?.substate?.Component?.body?.state;
  if (!state) throw new Error("contract unreadable");
  return state;
}

const addressOf = (v: Cbor): string => `component_${(v as { value?: { hex?: string } })?.value?.hex ?? hexOf(v)}`;

/**
 * Every payment to `did` the gate can count: who sent it, how much, and in which epoch — the gifts escrowed
 * under ClaimPolicy (Escrow deposits: index 7; a deposit is [sender, amount, refund, policy, metadata, created])
 * and those delivered straight to a linked wallet (ClaimPolicy's delivery log: index 8, [sender, amount, epoch]).
 * Both epochs are recorded by the contracts, never by the payer.
 */
export async function depositsFor(deps: GateDeps, did: string): Promise<{ sender: string; amount: bigint; created: number }[]> {
  const [escrow, claim] = await Promise.all([componentState(deps, CONFIG.escrow), componentState(deps, CONFIG.claim)]);
  const rows = ((escrow[7] as Record<string, Cbor[][]> | undefined) ?? {})[did] ?? [];
  const escrowed = rows
    .filter((d) => addressOf(d[3]) === CONFIG.claim)
    .map((d) => ({ sender: hexOf(d[0]).toLowerCase(), amount: BigInt(d[1] as number), created: Number(d[5] ?? 0) }));
  const delivered = (((claim[8] as Record<string, Cbor[][]> | undefined) ?? {})[did] ?? []).map((d) => ({
    sender: hexOf(d[0]).toLowerCase(),
    amount: BigInt(d[1] as number),
    created: Number(d[2] ?? 0),
  }));
  return [...escrowed, ...delivered];
}

/** A payment's identity for the spent ledger: the same sender can make several equal payments in one epoch. */
const fingerprint = (d: { amount: bigint; created: number }, nth: number): string => `${d.created}:${d.amount}:${nth}`;

async function currentEpoch(deps: GateDeps): Promise<number> {
  const s = (await deps.indexer("epoch-manager/stats")) as { current_epoch?: number };
  if (typeof s.current_epoch !== "number") throw new Error("epoch unavailable");
  return s.current_epoch;
}

// ---- routes --------------------------------------------------------------------------------------------------

async function createGate(req: Request, deps: GateDeps): Promise<Response> {
  let b: Record<string, unknown>;
  try {
    const text = await readCapped(req, MAX_BODY);
    if (text === null) return fail(413, "That is too large.");
    b = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return fail(400, "Send JSON.");
  }
  if (!isPlcDid(b.did)) return fail(400, "A did:plc account is required.");
  const price = typeof b.price === "string" && /^\d{1,12}$/.test(b.price) ? BigInt(b.price) : -1n;
  if (price < MIN_PRICE || price > MAX_PRICE) return fail(400, "The price is out of range.");
  const title = typeof b.title === "string" ? b.title.trim() : "";
  if (!title || [...title].length > MAX_TITLE) return fail(400, `A title of up to ${MAX_TITLE} characters is required.`);
  if (!b64Size(b.ciphertext, MAX_CIPHERTEXT, true)) return fail(400, "The locked content is empty or too large.");
  if (!b64Size(b.iv, 12)) return fail(400, "Bad nonce.");
  if (!b64Size(b.key, 32)) return fail(400, "Bad key.");

  let epoch: number;
  try {
    epoch = await currentEpoch(deps);
  } catch {
    return fail(503, "The network is not reachable right now. Try again.");
  }
  const id = toHex(deps.random(16));
  const rec: GateRecord = { did: b.did, price: price.toString(), title, ciphertext: b.ciphertext as string, iv: b.iv as string, key: b.key as string, epoch, createdAt: deps.now() };
  await save(deps, `gate/${id}`, rec);
  return json({ id });
}

async function readGate(id: string, deps: GateDeps): Promise<Response> {
  const g = await load<GateRecord>(deps, `gate/${id}`);
  if (!g) return fail(404, "No such locked post.");
  return json({ id, did: g.did, price: g.price, title: g.title, ciphertext: g.ciphertext, iv: g.iv, epoch: g.epoch });
}

async function unlock(id: string, req: Request, deps: GateDeps): Promise<Response> {
  const g = await load<GateRecord>(deps, `gate/${id}`);
  if (!g) return fail(404, "No such locked post.");
  let b: Record<string, unknown>;
  try {
    const text = await readCapped(req, MAX_BODY);
    if (text === null) return fail(413, "That is too large.");
    b = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return fail(400, "Send JSON.");
  }
  const { ownerKey, walletAddress, publicNonce, signature, ts } = b;
  if (typeof ownerKey !== "string" || !/^[0-9a-f]{64}$/i.test(ownerKey)) return fail(400, "Bad key.");
  if (typeof walletAddress !== "string" || walletAddress.length > 200) return fail(400, "Bad address.");
  if (typeof publicNonce !== "string" || typeof signature !== "string") return fail(400, "Bad signature.");
  if (typeof ts !== "number" || !Number.isFinite(ts) || Math.abs(deps.now() - ts) > SKEW_MS) return fail(400, "That request is out of date. Try again.");

  const key = ownerKey.toLowerCase();
  const challenge = `skydrop-unlock:v1:${id}:${ts}`;
  if (!schnorrVerify(key, publicNonce, signature, walletOwnershipMessage(NETWORK_BYTE, walletAddress, challenge))) {
    return fail(401, "That signature isn't valid for this key.");
  }

  const paidKey = `paid/${id}/${key}`;
  if (!(await deps.store.get(paidKey, "arrayBuffer"))) {
    let rows;
    try {
      rows = await depositsFor(deps, g.did);
    } catch {
      return fail(503, "Couldn't check the payment right now. Try again.");
    }
    const price = BigInt(g.price);
    // A payment counts if it came from this key, covers the price, was made after the post was locked, and
    // hasn't already unlocked another post — otherwise one tip would open every post the author locked before it.
    const spentKey = `spent/${g.did}/${key}`;
    const spent = new Set((await load<string[]>(deps, spentKey)) ?? []);
    const seen = new Map<string, number>();
    let use: string | null = null;
    for (const d of rows.filter((r) => r.sender === key)) {
      const base = `${d.created}:${d.amount}`;
      const nth = seen.get(base) ?? 0;
      seen.set(base, nth + 1);
      const fp = fingerprint(d, nth);
      if (d.amount >= price && d.created >= g.epoch && !spent.has(fp)) {
        use = fp;
        break;
      }
    }
    if (!use) return fail(402, "No unused payment from this wallet was found yet.");
    spent.add(use);
    await save(deps, spentKey, [...spent].slice(-500));
    await save(deps, paidKey, { at: deps.now(), payment: use });
  }
  return json({ key: g.key });
}

const ENT: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ENT[c]!);

async function landing(id: string, deps: GateDeps): Promise<Response> {
  const g = await load<GateRecord>(deps, `gate/${id}`);
  const title = g ? g.title : "Locked post";
  const price = g ? `${Number(BigInt(g.price)) / 1e6} tTARI` : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta property="og:title" content="${esc("🔒 " + title)}"><meta property="og:description" content="${esc(price ? `Unlock for ${price} with the Sapient wallet.` : "Unlock with the Sapient wallet.")}">
<style>body{font:16px system-ui,sans-serif;max-width:32rem;margin:12vh auto;padding:0 1rem;line-height:1.5}</style></head>
<body><h1>🔒 ${esc(title)}</h1>
<p>${g ? `This post is unlocked by tipping its author <b>${esc(price)}</b>.` : "This locked post could not be found."}</p>
<p>Open it on Bluesky with the <b>Sapient</b> wallet extension installed, and press <b>Unlock</b> under the post.</p></body></html>`;
  return new Response(html, { status: g ? 200 : 404, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" } });
}

/** Returns a Response for the gate routes, or null if the path isn't one of them. */
export async function handleGate(req: Request, deps: GateDeps): Promise<Response | null> {
  const url = new URL(req.url);
  const p = url.pathname;
  if (!(p === "/api/gate" || p.startsWith("/api/gate/") || p.startsWith("/api/unlock/") || p.startsWith("/u/"))) return null;
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  try {
    if (p === "/api/gate") return req.method === "POST" ? await createGate(req, deps) : fail(405, "POST only.");
    const id = p.split("/")[3] ?? p.split("/")[2] ?? "";
    if (!isId(id)) return fail(404, "No such locked post.");
    if (p.startsWith("/api/gate/")) return req.method === "GET" ? await readGate(id, deps) : fail(405, "GET only.");
    if (p.startsWith("/api/unlock/")) return req.method === "POST" ? await unlock(id, req, deps) : fail(405, "POST only.");
    return await landing(id, deps);
  } catch {
    return fail(500, "Something went wrong.");
  }
}
