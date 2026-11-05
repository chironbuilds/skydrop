/** Reads public atproto data and assembles the proofs a contract checks. Browser-only network code; no keys here. */
import { CarReader } from "@ipld/car";
import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";

const APPVIEW = "https://public.api.bsky.app";
const PLC = "https://plc.directory";

export interface Actor { did: string; handle: string; displayName: string; avatar?: string }
export interface RepoProof { commit: Uint8Array; nodes: Uint8Array[]; record: Uint8Array }

const NOT_PLC = "This account uses a did:web identity. Contracts can only verify did:plc accounts, which is almost everyone.";

export function cleanActor(input: string): string {
  let s = input.trim();
  const m = s.match(/bsky\.app\/profile\/([^/?#\s]+)/i);
  if (m) s = m[1]!;
  s = s.replace(/^at:\/\//, "").replace(/^@/, "");
  const did = s.match(/^did:[a-z]+:[a-zA-Z0-9._:-]+/);
  if (did) return did[0];
  return s.split("/")[0]!.toLowerCase();
}

const cache = new Map<string, Promise<Actor>>();

export function resolveActor(input: string): Promise<Actor> {
  let actor = cleanActor(input);
  // Most people mean their bsky.social name when they type just "alice".
  if (/^[a-z0-9][a-z0-9-]*$/.test(actor)) actor = `${actor}.bsky.social`;
  if (!actor || !/^[a-zA-Z0-9.:_-]+$/.test(actor) || (!actor.includes(".") && !actor.startsWith("did:"))) {
    return Promise.reject(new Error("That doesn't look like a Bluesky handle. Try name.bsky.social"));
  }
  let p = cache.get(actor);
  if (!p) {
    p = (async () => {
      const r = await fetch(`${APPVIEW}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`);
      if (!r.ok) throw new Error(r.status === 400 ? `No Bluesky account found for ${actor}` : `Bluesky lookup failed (${r.status})`);
      const j = (await r.json()) as { did: string; handle: string; displayName?: string; avatar?: string };
      return { did: j.did, handle: j.handle, displayName: j.displayName || j.handle, avatar: j.avatar };
    })();
    p.catch(() => cache.delete(actor));
    cache.set(actor, p);
  }
  return p;
}

export interface AtUri { did: string; collection: string; rkey: string }

export function parseAtUri(uri: string): AtUri | null {
  const m = uri.match(/^at:\/\/(did:[^/]+)\/([^/]+)\/([^/?#]+)$/);
  return m ? { did: m[1]!, collection: m[2]!, rkey: m[3]! } : null;
}

/** Turns a bsky.app post/list/profile URL, an at:// URI, a handle or a DID into the exact value a contract compares. */
export async function toTarget(input: string, want: "post" | "list" | "did"): Promise<string> {
  const s = input.trim();
  if (!s) throw new Error("Enter a value");
  if (want === "did") return (await resolveActor(s)).did;
  const seg = want === "post" ? "post" : "lists";
  const coll = want === "post" ? "app.bsky.feed.post" : "app.bsky.graph.list";
  if (s.startsWith("at://")) {
    const at = s.match(/^at:\/\/([^/]+)\/([^/]+)\/([^/?#]+)/);
    if (!at || at[2] !== coll) throw new Error(`Expected an at:// URI in ${coll}`);
    const did = at[1]!.startsWith("did:") ? at[1]! : (await resolveActor(at[1]!)).did;
    return `at://${did}/${coll}/${at[3]}`;
  }
  const m = s.match(new RegExp(`bsky\\.app/profile/([^/]+)/${seg}/([^/?#\\s]+)`, "i"));
  if (!m) throw new Error(want === "post" ? "Paste a post link like bsky.app/profile/name/post/3k…" : "Paste a list link like bsky.app/profile/name/lists/3k…");
  return `at://${(await resolveActor(m[1]!)).did}/${coll}/${m[2]}`;
}

/** A web link back to a target, for showing people what to act on. */
export function targetLink(target: string): string | null {
  const at = parseAtUri(target);
  if (at?.collection === "app.bsky.feed.post") return `https://bsky.app/profile/${at.did}/post/${at.rkey}`;
  if (at?.collection === "app.bsky.graph.list") return `https://bsky.app/profile/${at.did}/lists/${at.rkey}`;
  if (target.startsWith("did:")) return `https://bsky.app/profile/${target}`;
  return null;
}

export const composeUrl = (text: string): string => `https://bsky.app/intent/compose?text=${encodeURIComponent(text)}`;

type PlcOp = Record<string, unknown>;

export async function plcLog(did: string): Promise<PlcOp[]> {
  if (!did.startsWith("did:plc:")) throw new Error(NOT_PLC);
  const r = await fetch(`${PLC}/${did}/log`);
  if (!r.ok) throw new Error(`Couldn't read the identity log (${r.status})`);
  return (await r.json()) as PlcOp[];
}

export const encodeOps = (log: PlcOp[]): Uint8Array[] => log.map((o) => dagCbor.encode(o));

export function pdsOf(log: PlcOp[]): string {
  const last = log[log.length - 1]!;
  const services = last.services as Record<string, { endpoint: string }> | undefined;
  const pds = services?.atproto_pds?.endpoint ?? (last as { service?: string }).service;
  if (!pds) throw new Error("This account names no data host");
  return safeHost(pds);
}

/** An account chooses its own data host, so only a public https origin is ever contacted. */
export function safeHost(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("The account's data host isn't a web address.");
  }
  const host = u.hostname.toLowerCase();
  const bad =
    u.protocol !== "https:" || !!u.username || !!u.password || (!!u.port && u.port !== "443") || !host.includes(".") || host.includes(":") ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /(^|\.)(localhost|local|internal|lan|home|corp|intranet|arpa)$/.test(host);
  if (bad) throw new Error("The account's data host isn't a public https address, so it was not contacted.");
  return u.origin;
}

async function limitedBytes(url: string, max: number): Promise<Uint8Array> {
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: "error" });
  if (r.status === 400 || r.status === 404) throw new Error("That record is not in this account's repo.");
  if (!r.ok) throw new Error(`The account's data host answered ${r.status}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf.length > max) throw new Error("The response was too large.");
  return buf;
}

/** Everything a contract needs for one record: the signed commit, the tree path and the record bytes. */
export async function fetchProof(pds: string, did: string, collection: string, rkey: string): Promise<RepoProof> {
  const url = `${pds}/xrpc/com.atproto.sync.getRecord?did=${encodeURIComponent(did)}&collection=${encodeURIComponent(collection)}&rkey=${encodeURIComponent(rkey)}`;
  const car = await CarReader.fromBytes(await limitedBytes(url, 1_000_000));
  const [root] = await car.getRoots();
  const commit = await car.get(root as CID);
  if (!commit) throw new Error("The signed commit is missing from the response");
  const nodes: Uint8Array[] = [];
  let record: Uint8Array | null = null;
  for await (const b of car.blocks()) {
    if (b.cid.equals(root as CID)) continue;
    const v = dagCbor.decode(b.bytes) as { e?: unknown };
    if (v && typeof v === "object" && Array.isArray(v.e)) nodes.push(b.bytes);
    else record = b.bytes;
  }
  if (!record) throw new Error("The record is missing from the response");
  return { commit: commit.bytes, nodes, record };
}

export const decodeRecord = (bytes: Uint8Array): Record<string, unknown> => dagCbor.decode(bytes) as Record<string, unknown>;

interface Listed { uri: string; value: Record<string, unknown> }

/** Searches a repo collection newest-first. Bounded: a very active account may need a direct link instead. */
export async function findInRepo(pds: string, did: string, collection: string, match: (v: Record<string, unknown>) => boolean, maxPages = 6): Promise<Listed | null> {
  let cursor = "";
  for (let i = 0; i < maxPages; i++) {
    const url = `${pds}/xrpc/com.atproto.repo.listRecords?repo=${encodeURIComponent(did)}&collection=${encodeURIComponent(collection)}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: "error" });
    if (!r.ok) throw new Error(`The account's data host answered ${r.status}`);
    const j = (await r.json()) as { records?: Listed[]; cursor?: string };
    for (const rec of j.records ?? []) if (match(rec.value)) return rec;
    if (!j.cursor || !(j.records ?? []).length) return null;
    cursor = j.cursor;
  }
  return null;
}

/** The AppView's follow lookup: much faster than paging through a repo, then the record itself is proven. */
export async function followUri(from: string, to: string): Promise<string | null> {
  const r = await fetch(`${APPVIEW}/xrpc/app.bsky.graph.getRelationships?actor=${encodeURIComponent(from)}&others=${encodeURIComponent(to)}`);
  if (!r.ok) return null;
  const j = (await r.json()) as { relationships?: { following?: string }[] };
  return j.relationships?.[0]?.following ?? null;
}

export interface PostInfo { uri: string; handle: string; displayName: string; avatar?: string; text: string }

/** Looks a post up on the public AppView. A display convenience: nothing here is trusted by a contract. */
export async function fetchPost(uri: string): Promise<PostInfo | null> {
  const r = await fetch(`${APPVIEW}/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(uri)}`);
  if (!r.ok) return null;
  const j = (await r.json()) as { posts?: { uri: string; author: { handle: string; displayName?: string; avatar?: string }; record?: { text?: string } }[] };
  const p = j.posts?.[0];
  return p ? { uri: p.uri, handle: p.author.handle, displayName: p.author.displayName || p.author.handle, avatar: p.author.avatar, text: p.record?.text ?? "" } : null;
}

export async function latestPost(actor: string): Promise<{ uri: string; text: string } | null> {
  const r = await fetch(`${APPVIEW}/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(actor)}&limit=10&filter=posts_no_replies`);
  if (!r.ok) return null;
  const j = (await r.json()) as { feed?: { post: { uri: string; author: { did: string }; record?: { text?: string } } }[] };
  const did = (await resolveActor(actor)).did;
  const p = j.feed?.find((f) => f.post.author.did === did)?.post;
  return p ? { uri: p.uri, text: p.record?.text ?? "" } : null;
}
