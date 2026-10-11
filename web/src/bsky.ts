import * as dagCbor from "@ipld/dag-cbor";
import { CarReader } from "@ipld/car";
import type { CID } from "multiformats/cid";
import { CONFIG } from "./config";
import { toHex, fromHex } from "./cbor";

export interface Profile {
  did: string;
  handle: string;
  displayName: string;
  avatar?: string;
  description?: string;
}

/** Normalises user input like "@Alice.bsky.social", "alice.bsky.social" or a bsky.app profile URL. */
export function cleanHandle(input: string): string {
  let s = input.trim().toLowerCase();
  const m = s.match(/bsky\.app\/profile\/([^/?#\s]+)/);
  if (m) s = m[1]!;
  return s.replace(/^@/, "").replace(/^at:\/\//, "");
}

export async function lookupProfile(input: string): Promise<Profile> {
  const actor = cleanHandle(input);
  if (!actor || !/^[a-z0-9.:-]+$/.test(actor) || (!actor.includes(".") && !actor.startsWith("did:"))) {
    throw new Error("That doesn't look like a Bluesky handle. Try something like name.bsky.social");
  }
  const r = await fetch(`${CONFIG.publicApi}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`);
  if (!r.ok) throw new Error(r.status === 400 ? `No Bluesky account found for @${actor}` : `Bluesky lookup failed (${r.status})`);
  const p = (await r.json()) as { did: string; handle: string; displayName?: string; avatar?: string; description?: string };
  if (!p.did.startsWith("did:plc:")) {
    throw new Error("This account uses a did:web identity, which isn't supported yet. did:plc accounts (almost everyone) work.");
  }
  return { did: p.did, handle: p.handle, displayName: p.displayName || p.handle, avatar: p.avatar, description: p.description };
}

/** What a claimant must post. The code binds this component, the DID and the claimant's Ootle key. */
export async function claimCode(component: string, did: string, claimant: Uint8Array): Promise<string> {
  const enc = new TextEncoder();
  const parts = [enc.encode(CONFIG.claimDomain), enc.encode(component), enc.encode(":"), enc.encode(did), enc.encode(":"), claimant];
  const data = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    data.set(p, off);
    off += p.length;
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return `tari-claim:${toHex(digest.slice(0, 16))}`;
}

/** What an owner posts to link `did` to the Ootle account `address`. */
export async function bindCode(component: string, did: string, address: string): Promise<string> {
  const enc = new TextEncoder();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`tari-bsky-bind:v1:${component}:${did}:${address}`)));
  return `tari-bind:${toHex(digest.slice(0, 16))}`;
}

/** The time in a repo commit's `rev` (a TID), in microseconds. The account's signing key signs it. */
export function commitRevMicros(commit: Uint8Array): number {
  const rev = (dagCbor.decode(commit) as { rev?: string }).rev ?? "";
  const alphabet = "234567abcdefghijklmnopqrstuvwxyz";
  if (rev.length !== 13) throw new Error("This snapshot of your account has no usable time.");
  let v = 0n;
  for (const c of rev) {
    const d = alphabet.indexOf(c);
    if (d < 0) throw new Error("This snapshot of your account has no usable time.");
    v = (v << 5n) | BigInt(d);
  }
  return Number(v >> 10n);
}

/** The account's current operation chain, and the hash of its last operation (how the contract names a chain). */
export async function currentChain(did: string): Promise<{ ops: Uint8Array[]; tipHex: string }> {
  const log = await plcLog(did);
  const ops = log.map((o) => dagCbor.encode(o));
  const tip = new Uint8Array(await crypto.subtle.digest("SHA-256", ops[ops.length - 1]!));
  return { ops, tipHex: toHex(tip) };
}

export const composeUrl = (text: string): string => `https://bsky.app/intent/compose?text=${encodeURIComponent(text)}`;

export interface ClaimProof {
  did: string;
  rkey: string;
  ops: Uint8Array[];
  commit: Uint8Array;
  nodes: Uint8Array[];
  record: Uint8Array;
  text: string;
}

async function plcLog(did: string): Promise<Record<string, unknown>[]> {
  const r = await fetch(`${CONFIG.plcDirectory}/${did}/log`);
  if (!r.ok) throw new Error(`Couldn't read the account's identity log (${r.status})`);
  return (await r.json()) as Record<string, unknown>[];
}

/** Finds the user's post containing `code`, newest first. */
export async function findClaimPost(did: string, code: string, phrases: string[] = []): Promise<{ uri: string; rkey: string } | null> {
  // with no code a post only counts if it carries the phrases (otherwise every post would match)
  if (!code && !phrases.length) return null;
  const r = await fetch(
    `${CONFIG.publicApi}/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(did)}&limit=50&filter=posts_no_replies`,
  );
  if (!r.ok) throw new Error(`Couldn't read your posts (${r.status})`);
  const feed = (await r.json()) as { feed: { post: { uri: string; author: { did: string }; record?: { text?: string } } }[] };
  for (const { post } of feed.feed) {
    if (post.author.did === did && (post.record?.text ?? "").includes(code) && phrases.every((p) => (post.record?.text ?? "").includes(p))) {
      const rkey = post.uri.split("/").pop()!;
      return { uri: post.uri, rkey };
    }
  }
  return null;
}

/**
 * Everything the contract verifies on-chain: the account's identity-operation chain, the signed repo
 * commit, the Merkle-search-tree path to the post, and the post itself.
 */
/**
 * The data host named in an account's identity document is chosen by whoever owns the account, and this code also
 * runs on the bot's server. So it must be a public https host: no addresses, no localhost or internal names, no odd ports.
 */
export function safeHost(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("The account names a data host that isn't a web address.");
  }
  const h = u.hostname.toLowerCase();
  const bad =
    u.protocol !== "https:" ||
    !!u.username ||
    !!u.password ||
    (!!u.port && u.port !== "443") ||
    !h.includes(".") ||
    h.includes(":") ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(h) ||
    /(^|\.)(localhost|local|internal|lan|home|corp|intranet|arpa)$/.test(h);
  if (bad) throw new Error("The account names a data host that isn't a public https address, so it was not contacted.");
  return u.origin;
}

/** GET with a time limit, a size limit, and no redirects (a public host must not be able to bounce us inward). */
async function getBytes(url: string, max: number, ms: number): Promise<Uint8Array> {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), redirect: "error" });
  if (!r.ok) throw new Error(`Couldn't fetch the signed copy of your post (${r.status})`);
  if (Number(r.headers.get("content-length") ?? 0) > max) throw new Error("The response was too large.");
  const reader = r.body?.getReader();
  if (!reader) return new Uint8Array(await r.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new Error("The response was too large.");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export async function buildClaimProof(did: string, rkey: string): Promise<ClaimProof> {
  const log = await plcLog(did);
  const services = log[log.length - 1]!.services as Record<string, { endpoint: string }> | undefined;
  const pds = services?.atproto_pds?.endpoint ?? (log[log.length - 1] as { service?: string }).service;
  if (!pds) throw new Error("Couldn't find where your Bluesky data is hosted");
  const url = `${safeHost(pds)}/xrpc/com.atproto.sync.getRecord?did=${encodeURIComponent(did)}&collection=${CONFIG.collection}&rkey=${encodeURIComponent(rkey)}`;
  const car = await CarReader.fromBytes(await getBytes(url, 1_000_000, 15_000));
  const [root] = await car.getRoots();
  const commit = await car.get(root as CID);
  if (!commit) throw new Error("The signed repo commit is missing from the response");
  const nodes: Uint8Array[] = [];
  let record: Uint8Array | null = null;
  for await (const b of car.blocks()) {
    if (b.cid.equals(root as CID)) continue;
    const v = dagCbor.decode(b.bytes) as Record<string, unknown>;
    if (v && typeof v === "object" && Array.isArray((v as { e?: unknown }).e)) nodes.push(b.bytes);
    else record = b.bytes;
  }
  if (!record) throw new Error("The post is missing from the response");
  const text = ((dagCbor.decode(record) as { text?: string }).text) ?? "";
  return { did, rkey, ops: log.map((o) => dagCbor.encode(o)), commit: commit.bytes, nodes, record, text };
}

export { toHex, fromHex };

/** The claim post to suggest: the code, then each phrase the senders asked for, as long as a post can hold. */
export function claimPostText(symbol: string, code: string, phrases: string[]): { text: string; used: string[]; dropped: number } {
  // a linked account posts the sender's phrase alone
  const tail = code ? `Claiming my ${symbol} on Tari. ${code}` : "";
  const used: string[] = [];
  let dropped = 0;
  let len = [...tail].length;
  for (const p of phrases) {
    const add = [...p].length + 1;
    if (len + add <= 290) {
      len += add;
      used.push(p);
    } else dropped++;
  }
  // the senders' phrases lead the post, the claim line follows
  return { text: [...used, tail].filter(Boolean).join("\n"), used, dropped };
}

/** Why no post matched: a claim post for another wallet, or one missing a phrase. Empty if there is no claim post at all. */
export async function whyNoClaimPost(did: string, code: string, phrases: string[]): Promise<string> {
  try {
    const r = await fetch(`${CONFIG.publicApi}/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(did)}&limit=30&filter=posts_no_replies`);
    if (!r.ok) return "";
    const feed = (await r.json()) as { feed: { post: { author: { did: string }; record?: { text?: string } } }[] };
    const mine = feed.feed.filter((f) => f.post.author.did === did).map((f) => f.post.record?.text ?? "");
    const claims = mine.filter((t) => t.includes("tari-claim:"));
    if (!claims.length) return "";
    const withCode = claims.find((t) => t.includes(code));
    if (!withCode) {
      const other = /tari-claim:[0-9a-f]{32}/.exec(claims[0]!)?.[0] ?? "a claim code";
      return `Your latest claim post has ${other}, but the wallet in this browser expects ${code}. The code is tied to the wallet, so post the text shown on this page (same browser you're verifying in).`;
    }
    const missing = phrases.find((p) => !withCode.includes(p));
    return missing ? `Your post is missing the sender's phrase “${missing}”. It has to match exactly, capital letters included.` : "";
  } catch {
    return "";
  }
}
