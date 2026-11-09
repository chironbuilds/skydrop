/**
 * Stores campaigns' allocation lists, so a share link doesn't have to carry them. The chain holds only a list's Merkle
 * root, and a list is stored under the root this code works out from it, so nobody can put a different list where a
 * campaign's belongs. Readers check the root again themselves. Lists are public by design: a claim has to prove against
 * the whole list.
 */
import { allocationRoot, type Allocation } from "../../web-atproto/src/lib/campaign";
import { readCapped } from "../../web-atproto/worker/secure";

export const MAX_LIST_ENTRIES = 20_000;
const MAX_LIST_BYTES = 2_000_000;
const BIG_LIST_BYTES = 200_000;
/** Longer than any campaign can stay open from the start, which is about 833 days. */
const LIST_TTL = 60 * 60 * 24 * 1000;
const U64_MAX = (1n << 64n) - 1n;
const DID = /^did:[a-z]+:[A-Za-z0-9._:%-]{1,200}$/;
const AMOUNT = /^[1-9]\d{0,19}$/;
const ROOT = /^[0-9a-f]{64}$/;

export interface ListStore {
  get(k: string, t: "arrayBuffer"): Promise<ArrayBuffer | null>;
  put(k: string, v: ArrayBuffer, o?: { expirationTtl?: number }): Promise<void>;
}

const json = (o: unknown, status = 200): Response => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" } });

/** The list if it's well formed, or the reason it isn't. */
function parseList(text: string): Allocation[] | string {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return "bad json";
  }
  if (!Array.isArray(body) || !body.length) return "not a list";
  if (body.length > MAX_LIST_ENTRIES) return "too many accounts";
  const seen = new Set<string>();
  const out: Allocation[] = [];
  for (const x of body as { did?: unknown; amount?: unknown }[]) {
    const did = x?.did;
    const amount = x?.amount;
    if (typeof did !== "string" || !DID.test(did)) return "bad account";
    if (typeof amount !== "string" || !AMOUNT.test(amount) || BigInt(amount) > U64_MAX) return "bad amount";
    if (seen.has(did)) return "an account is listed twice";
    seen.add(did);
    out.push({ did, amount });
  }
  return out;
}

async function saveList(req: Request, store: ListStore, slowDown: (big: boolean) => Promise<boolean>): Promise<Response> {
  const text = await readCapped(req, MAX_LIST_BYTES);
  if (text === null) return json({ error: "too big" }, 413);
  // Lists are kept for years, so big ones get a tighter allowance: storage is what this could be used to fill.
  if (await slowDown(text.length > BIG_LIST_BYTES)) return json({ error: "slow down" }, 429);
  const list = parseList(text);
  if (typeof list === "string") return json({ error: list }, 400);
  const root = await allocationRoot(list);
  const key = `list:${root}`;
  if (!(await store.get(key, "arrayBuffer"))) await store.put(key, new TextEncoder().encode(JSON.stringify(list)).buffer as ArrayBuffer, { expirationTtl: LIST_TTL });
  return json({ root });
}

async function readList(root: string, store: ListStore): Promise<Response> {
  const buf = ROOT.test(root) ? await store.get(`list:${root}`, "arrayBuffer") : null;
  if (!buf) return json({ error: "not found" }, 404);
  // The address is the content's own fingerprint, so what's here can't change.
  return new Response(buf, { headers: { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" } });
}

/** Handles POST /api/list and GET /api/list/<root>. Null for anything else. */
export async function handleLists(req: Request, url: URL, store: ListStore, slowDown: (big: boolean) => Promise<boolean>): Promise<Response | null> {
  if (url.pathname === "/api/list") return req.method === "POST" ? saveList(req, store, slowDown) : json({ error: "method not allowed" }, 405);
  if (url.pathname.startsWith("/api/list/")) return req.method === "GET" ? readList(url.pathname.slice("/api/list/".length), store) : json({ error: "method not allowed" }, 405);
  return null;
}
