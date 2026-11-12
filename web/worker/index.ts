// Serves the static app, plus share cards: /e/<handle>?e=red&m=note&a=2 returns the page crawlers read (Open Graph),
// and /og draws the envelope as a PNG. People opening /e/... are sent straight on to the claim page.
import { handleLists } from "./lists";
import { esc, handleShare, isLatin, isWide, wrap } from "./share";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
// @ts-expect-error wrangler turns .wasm imports into compiled modules
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import { handleGate, liveDeps } from "./gate";
import { card } from "./card";
import { cleanNote, cleanRecord, effectiveStyle, envelopeHash, extrasFromQuery, isCoverId, styleOf, type Extras, type Style } from "../src/envelope-data";
import { fullPageRequest, httpsRedirect, readCapped, readCappedBytes, secure } from "../../web-atproto/worker/secure";
import { atPath, networkResponse, onMainnet } from "../../web-atproto/worker/network";

interface KVNamespace {
  get(key: string): Promise<string | null>;
  get(key: string, type: "json"): Promise<unknown>;
  get(key: string, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
  put(key: string, value: string | ArrayBuffer, opts?: { expirationTtl?: number }): Promise<void>;
}
interface Env {
  ASSETS: { fetch(r: Request): Promise<Response> };
  COVERS: KVNamespace;
  LAUNCH_STATE?: KVNamespace;
}

const MAX_COVER = 90_000;

// Runtime address injection from KV (fills empty mainnet addresses without a rebuild)
let _cachedAddrs: string | null = null;
let _addrsFetchedAt = 0;
const _ADDRS_TTL_MS = 2 * 60 * 1000;
async function getAddresses(ls: KVNamespace | undefined): Promise<string | null> {
  if (!ls) return null;
  const now = Date.now();
  if (_cachedAddrs !== null || (_addrsFetchedAt > 0 && now - _addrsFetchedAt < _ADDRS_TTL_MS)) return _cachedAddrs;
  _cachedAddrs = await ls.get("mainnet:addresses").catch(() => null);
  _addrsFetchedAt = now;
  return _cachedAddrs;
}
async function injectAddrScript(res: Response, addrs: string): Promise<Response> {
  const script = `<script>window.__SD_ADDR__=${addrs}</script>`;
  const html = await res.text();
  const patched = html.includes("</head>") ? html.replace("</head>", script + "</head>") : script + html;
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return new Response(patched, { status: res.status, statusText: res.statusText, headers });
}
// long enough for any gift's refund period, short enough that nothing is hosted for ever
const COVER_TTL = 60 * 60 * 24 * 90;

let ready: Promise<void> | null = null;
const cleanHandle = (s: string): string => (/^[a-z0-9][a-z0-9.-]{0,252}$/i.test(s) ? s.toLowerCase() : "");
const cleanAmount = (s: string | null): string => (s && /^[0-9][0-9.,]{0,18}( [A-Za-z]{1,8})?$/.test(s) ? s : "");

function params(url: URL): { handle: string; style: Style; note: string; amount: string; cover: string; extras: Extras } {
  return {
    handle: cleanHandle(url.searchParams.get("h") ?? url.pathname.split("/")[2] ?? ""),
    style: styleOf(url.searchParams.get("e")),
    note: cleanNote(url.searchParams.get("m") ?? ""),
    amount: cleanAmount(url.searchParams.get("a")),
    cover: isCoverId(url.searchParams.get("c")) ? url.searchParams.get("c")! : "",
    extras: extrasFromQuery((k) => url.searchParams.get(k)),
  };
}

/** The extras as a stable query string, for cache keys. */
const extrasKey = (x: Extras): string => (["p", "g", "k", "f", "x"] as const).map((k) => `${k}=${encodeURIComponent(x[k] ?? "")}`).join("&");

function page(url: URL): Response {
  const origin = url.hostname === "localhost" ? url.origin : "https://" + url.host;
  const { handle, style: base, note, amount, extras } = params(url);
  const style = effectiveStyle(base, extras);
  const dest = `${origin}/#/claim/${handle}${url.search}`;
  const title = handle ? `@${handle}, you got a gift on Tari` : "You got a gift on Tari";
  const desc = note ? `\u201c${note}\u201d` : amount ? `${amount} is waiting for you. Collect it with one Bluesky post.` : "Collect it with one Bluesky post. No wallet needed.";
  const img = `${origin}/og${url.search}${url.search ? "&" : "?"}h=${encodeURIComponent(handle)}`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta property="og:type" content="website"><meta property="og:site_name" content="Skydrop">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(img)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:url" content="${esc(url.href)}"><meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${esc(img)}">
<meta property="og:image:type" content="image/png"><meta property="og:image:secure_url" content="${esc(img)}"><meta name="theme-color" content="${style.paper}"></head>
<body><p><a href="${esc(dest)}">Open your gift</a></p><script>location.replace(${JSON.stringify(dest).replace(/</g, "\\u003c")})</script></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" } });
}

async function font(family: string, weight: number, text: string): Promise<Uint8Array | null> {
  const key = new Request(`https://fonts.cache/${family}/${weight}/${encodeURIComponent(text)}`);
  const cache = (caches as unknown as { default: Cache }).default;
  const hit = await cache.match(key);
  if (hit) return new Uint8Array(await hit.arrayBuffer());
  try {
    const css = await (await fetch(`https://fonts.googleapis.com/css2?family=${family.replace(/ /g, "+")}:wght@${weight}&text=${encodeURIComponent(text)}`)).text();
    const src = /url\((https:[^)]+)\)/.exec(css)?.[1];
    if (!src) return null;
    const buf = await (await fetch(src)).arrayBuffer();
    await cache.put(key, new Response(buf, { headers: { "cache-control": "public, max-age=604800" } }));
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

/** Draws a card. `complete` is false if a font couldn't be fetched, so the picture shouldn't be kept. */
async function render(svg: string, text: string, extra: { family: string; weight: number; text: string }[] = []): Promise<{ bytes: Uint8Array; complete: boolean }> {
  ready ??= initWasm(resvgWasm);
  await ready;
  const chars = [...new Set(text)];
  const latin = chars.filter(isLatin).join("");
  const wide = chars.filter((c) => !isLatin(c)).join("");
  // Emoji and symbols (a seal can be any one): the monochrome Noto Emoji covers what Noto Sans SC doesn't. Google
  // subsets each font to the characters it actually has, so asking both for the same symbols is harmless.
  const symbols = chars.filter((c) => /\p{Extended_Pictographic}|[\u2600-\u27bf]/u.test(c)).join("");
  const [a, b, e, ...more] = await Promise.all([
    font("Fraunces", 700, latin || "a"),
    wide ? font("Noto Sans SC", 700, wide) : Promise.resolve(null),
    symbols ? font("Noto Emoji", 700, symbols) : Promise.resolve(null),
    ...extra.map((f) => font(f.family, f.weight, f.text || "a")),
  ]);
  const fontBuffers = [a, b, e, ...more].filter((f): f is Uint8Array => !!f);
  const bytes = new Resvg(svg, { font: { fontBuffers, loadSystemFonts: false, defaultFontFamily: "Fraunces" } }).render().asPng();
  // A card missing a font (a blank seal, say) is still shown, but not kept, so the next request draws it again.
  return { bytes, complete: !!a && (!wide || !!b) && (!symbols || !!e) && more.every((f) => !!f) };
}

function toBase64(buf: ArrayBuffer): string {
  let bin = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** At most `max` calls of `name` per address per hour. KV is eventually consistent, so this is a brake, not a hard cap. */
async function overLimit(req: Request, env: Env, name: string, max: number): Promise<boolean> {
  const seen = req.headers.get("cf-connecting-ip") ?? "unknown";
  // One IPv6 customer holds a whole /64, so counting single addresses would give them billions of allowances.
  const ip = seen.includes(":") ? seen.split(":").slice(0, 4).join(":") : seen;
  const hour = Math.floor(Date.now() / 3_600_000);
  const rate = `rate:${name}:${hour}:${ip}`;
  try {
    const used = Number(new TextDecoder().decode((await env.COVERS.get(rate, "arrayBuffer")) ?? new ArrayBuffer(0))) || 0;
    if (used >= max) return true;
    await env.COVERS.put(rate, new TextEncoder().encode(String(used + 1)).buffer as ArrayBuffer, { expirationTtl: 3700 });
    return false;
  } catch {
    // The counter's own storage has failed, so whatever this guards can't safely store anything either.
    return true;
  }
}

async function png(url: URL, env: Env, req: Request): Promise<Response> {
  const { handle, style, note, amount, cover, extras } = params(url);
  const cache = (caches as unknown as { default: Cache }).default;
  // keyed by what is actually drawn, so junk in the query string cannot create new entries
  const key = new Request(`${url.origin}/og-cache?h=${encodeURIComponent(handle)}&e=${style.id}&m=${encodeURIComponent(note)}&a=${encodeURIComponent(amount)}&c=${cover}&${extrasKey(extras)}`);
  const hit = await cache.match(key);
  if (hit) return hit;
  // drawing costs CPU and font downloads: a new picture is allowed a limited number of times per address
  if (await overLimit(req, env, "og", 60)) return new Response("slow down", { status: 429 });
  const coverBytes = cover && !(await banned(cover, env)) ? await env.COVERS.get(cover, "arrayBuffer") : null;
  const built = card(style, handle, note, amount, coverBytes ? "x" : "", extras);
  const svg = coverBytes ? built.svg.replace("__COVER__", "data:image/jpeg;base64," + toBase64(coverBytes)) : built.svg;
  const { bytes: out, complete } = await render(svg, built.text, built.fonts);
  const res = new Response(out, { headers: { "content-type": "image/png", "cache-control": complete ? "public, max-age=86400" : "no-store" } });
  if (complete) await cache.put(key, res.clone());
  return res;
}

const isJpeg = (b: Uint8Array): boolean => b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/** Stores an uploaded cover (a JPEG the page already shrank) under its content hash. */
async function saveCover(req: Request, env: Env): Promise<Response> {
  const json = (o: unknown, status = 200): Response => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  if (await overLimit(req, env, "cover", 20)) return json({ error: "slow down" }, 429);
  const bytes = await readCappedBytes(req, MAX_COVER);
  if (!bytes) return json({ error: "too big" }, 413);
  if (!isJpeg(bytes)) return json({ error: "not a jpeg" }, 415);
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  const id = [...digest.slice(0, 8)].map((x) => x.toString(16).padStart(2, "0")).join("");
  await env.COVERS.put(id, buf, { expirationTtl: COVER_TTL });
  return json({ id });
}

/** An operator can take a picture down with `wrangler kv key put --binding COVERS "ban:<id>" 1`. */
const banned = async (id: string, env: Env): Promise<boolean> => !!(await env.COVERS.get(`ban:${id}`, "arrayBuffer"));

async function serveCover(url: URL, env: Env): Promise<Response> {
  const id = url.pathname.replace(/^\/c\//, "").replace(/\.jpg$/, "");
  const buf = isCoverId(id) && !(await banned(id, env)) ? await env.COVERS.get(id, "arrayBuffer") : null;
  if (!buf) return new Response("not found", { status: 404 });
  // Pictures are uploaded by strangers, so one opened directly can't do anything but be a picture.
  return new Response(buf, { headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" } });
}

const HASH_RE = /^[0-9a-f]{64}$/;

/**
 * Who a gift says it's from: the sender types a Bluesky account (optional; empty means anonymous) and the page records it
 * here before sending, keyed by the recipient, the sending wallet's key and the amount. Nothing checks the name here; the
 * bot names it as the sender's own word unless that account's linked wallet is the one that sent the gift. The first
 * record wins, so nobody can swap the name once the sender has set it.
 */
async function giftFrom(req: Request, url: URL, env: Env): Promise<Response> {
  const json = (o: unknown, status = 200): Response => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  const ok = (did: string, sender: string, amount: string) => /^did:plc:[a-z2-7]{24}$/.test(did) && /^[0-9a-f]{64}$/.test(sender) && /^[1-9][0-9]{0,18}$/.test(amount);
  if (req.method === "GET") {
    const [did, sender, amount] = ["did", "sender", "amount"].map((k) => url.searchParams.get(k) ?? "");
    if (!ok(did!, sender!, amount!)) return json({ error: "bad request" }, 400);
    return json({ from: await env.COVERS.get(`from:${did}:${sender}:${amount}`) });
  }
  if (req.method !== "POST") return json({ error: "GET or POST" }, 405);
  if (await overLimit(req, env, "from", 30)) return json({ error: "slow down" }, 429);
  const text = await readCapped(req, 400);
  if (text === null) return json({ error: "too big" }, 413);
  let body: { did?: string; sender?: string; amount?: string; from?: string };
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "bad json" }, 400);
  }
  const [did, sender, amount, from] = [body.did ?? "", body.sender ?? "", String(body.amount ?? ""), body.from ?? ""];
  if (!ok(did, sender, amount) || !/^did:plc:[a-z2-7]{24}$/.test(from)) return json({ error: "bad request" }, 400);
  const key = `from:${did}:${sender}:${amount}`;
  if (!(await env.COVERS.get(key))) await env.COVERS.put(key, from, { expirationTtl: 60 * 60 * 24 * 30 });
  return json({ ok: true });
}

/**
 * Remembers which envelope went with a deposit, keyed by the deposit's fingerprint (sender key, amount, refund
 * epoch, window), so the bot's mention and the sender's "Remind them" link can show the same card. The first
 * write wins, so nobody can swap the envelope of a deposit after its sender registered it.
 */
async function saveEnvelope(req: Request, env: Env): Promise<Response> {
  const json = (o: unknown, status = 200): Response => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  if (await overLimit(req, env, "envelope", 30)) return json({ error: "slow down" }, 429);
  const text = await readCapped(req, 600);
  if (text === null) return json({ error: "too big" }, 413);
  let body: Record<string, string>;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "bad json" }, 400);
  }
  // a record is stored under the hash of its own content, which is what a deposit commits to on-chain: it cannot be
  // squatted, and nobody can store a different record where a gift's envelope belongs
  const rec = cleanRecord(body && typeof body === "object" ? body : {});
  const hash = await envelopeHash(rec);
  const key = `env:${hash}`;
  if (!(await env.COVERS.get(key, "arrayBuffer"))) {
    await env.COVERS.put(key, new TextEncoder().encode(JSON.stringify(rec)).buffer as ArrayBuffer, { expirationTtl: 60 * 60 * 24 * 90 });
  }
  return json({ ok: true, hash });
}

async function readEnvelope(url: URL, env: Env): Promise<Response> {
  const hash = url.searchParams.get("h") ?? "";
  const buf = HASH_RE.test(hash) ? await env.COVERS.get(`env:${hash}`, "arrayBuffer") : null;
  if (!buf) return new Response("not found", { status: 404 });
  return new Response(buf, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/**
 * A queue of campaign claims waiting for the bot to pay their network fee (accounts whose linked wallet holds no TARI).
 * It holds only public facts (a campaign address and a DID), so it needs no secret: the bot checks every entry on-chain
 * before paying anything, and an entry it can't use costs it nothing. Entries expire on their own.
 */
const RELAY_TTL_MS = 30 * 60_000;

async function relayQueue(req: Request, url: URL, env: Env, mainnet: boolean): Promise<Response> {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" } });
  const kv = env.LAUNCH_STATE;
  if (!kv) return json({ error: "Relaying isn't available here." }, 503);
  const prefix = `relayq:${mainnet ? "mainnet" : "testnet"}:`;
  // The queue lives in one key, not one key per entry: the bot polls every 15 s and KV allows only 1,000 list() calls
  // a day (it ran out by mid-morning and every request failed), while get() has a far larger allowance.
  const indexKey = `${prefix}index`;
  const readIndex = async (): Promise<Record<string, number>> => {
    const raw = (await kv.get(indexKey, "json").catch(() => null)) as Record<string, number> | null;
    const now = Date.now();
    return Object.fromEntries(Object.entries(raw ?? {}).filter(([, t]) => typeof t === "number" && now - t < RELAY_TTL_MS));
  };
  const enqueue = async (name: string): Promise<Response> => {
    const idx = await readIndex();
    if (!(name in idx) && Object.keys(idx).length >= 200) return json({ error: "Skydrop is busy. Try again in a few minutes." }, 503);
    idx[name] = Date.now();
    await kv.put(indexKey, JSON.stringify(idx));
    return json({ queued: true }, 202);
  };
  if (url.pathname === "/api/relay-queue") {
    const items = Object.keys(await readIndex()).map((name) => {
      const parts = name.split("|");
      if (parts[0] === "linked") return { kind: "linked", did: parts[1], step: parts[2] };
      if (parts[0] === "float") return { kind: "float", did: parts[1], address: parts[2] };
      if (parts[0] === "record") return { kind: "record", did: parts[1], ...(parts[2] ? { campaign: parts[2] } : {}) };
      return parts[0] === "link" ? { kind: "link", did: parts[1], account: parts[2], owner: parts[3] } : { kind: "claim", campaign: parts[0], did: parts[1] };
    });
    return json({ items });
  }
  if (req.method !== "POST") return json({ error: "POST a campaign and a DID." }, 405);
  if (await overLimit(req, env, "relay", 30)) return json({ error: "Too many requests from this address. Try again later." }, 429);
  let body: { kind?: unknown; campaign?: unknown; did?: unknown; account?: unknown; owner?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: "Send JSON." }, 400);
  }
  const did = String(body.did ?? "");
  // Linking a wallet that holds no TARI: the bot creates the account if needed and submits the bind post.
  if (body.kind === "link") {
    const account = String(body.account ?? "");
    const owner = String(body.owner ?? "");
    if (!/^did:plc:[a-z2-7]{24}$/.test(did) || !/^component_[0-9a-f]{64}$/.test(account) || !/^[0-9a-f]{64}$/.test(owner)) return json({ error: "That isn't a did:plc, an account and a key." }, 400);
    return enqueue(`link|${did}|${account}|${owner}`);
  }
  // An old account's identity history, recorded in the ChainBook so its free (sponsored) v2 claim fits.
  if (body.kind === "record") {
    const campaign = String(body.campaign ?? "");
    if (!/^did:plc:[a-z2-7]{24}$/.test(did) || (campaign && !/^component_[0-9a-f]{64}$/.test(campaign))) return json({ error: "That isn't a did:plc (and a campaign)." }, 400);
    return enqueue(`record|${did}${campaign ? `|${campaign}` : ""}`);
  }
  // A phrase gift for a linked account whose linked wallet holds no TARI: the bot starts the claim or pays it out.
  if (body.kind === "linked") {
    const step = String((body as { step?: unknown }).step ?? "");
    if (!/^did:plc:[a-z2-7]{24}$/.test(did) || (step !== "start" && step !== "finalize")) return json({ error: "That isn't a did:plc and a step." }, 400);
    return enqueue(`linked|${did}|${step}`);
  }
  // A gift claim whose proof is too big to be sponsored: the bot sends the wallet enough TARI to pay the fee itself.
  if (body.kind === "float") {
    const address = String((body as { address?: unknown }).address ?? "");
    if (!/^did:plc:[a-z2-7]{24}$/.test(did) || !/^otl_[a-z0-9_]{20,200}$/.test(address)) return json({ error: "That isn't a did:plc and a wallet address." }, 400);
    return enqueue(`float|${did}|${address}`);
  }
  const campaign = String(body.campaign ?? "");
  if (!/^component_[0-9a-f]{64}$/.test(campaign) || !/^did:plc:[a-z2-7]{24}$/.test(did)) return json({ error: "That isn't a campaign address and a did:plc." }, 400);
  return enqueue(`${campaign}|${did}`);
}

async function serve(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const mainnet = await onMainnet();
    if (url.pathname === "/__network") return networkResponse();
    // Locked posts are testnet-only.
    if (!mainnet && url.pathname === "/api/gate" && req.method === "POST" && (await overLimit(req, env, "gate", 20))) return new Response(JSON.stringify({ error: "Too many locked posts from this address. Try again later." }), { status: 429, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
    if (!mainnet) {
      const gate = await handleGate(req, liveDeps(env.COVERS as never));
      if (gate) return gate;
    }
    const list = await handleLists(req, url, env.COVERS, (big) => (big ? overLimit(req, env, "list-big", 2) : overLimit(req, env, "list", 10)));
    if (list) return list;
    const share = await handleShare(req, url, {
      overLimit: () => overLimit(req, env, "og", 60),
      draw: async (svg, text) => {
        const { bytes, complete } = await render(svg, text);
        return complete ? bytes : null;
      },
    });
    if (share) return share;
    if (url.pathname === "/api/relay-claim" || url.pathname === "/api/relay-queue") return relayQueue(req, url, env, mainnet);
    if (url.pathname === "/api/from") return giftFrom(req, url, env);
    if (url.pathname.startsWith("/e/")) return page(url);
    if (url.pathname === "/og") return png(url, env, req);
    if (url.pathname === "/cover" && req.method === "POST") return saveCover(req, env);
    if (url.pathname === "/envelope") return req.method === "POST" ? saveEnvelope(req, env) : readEnvelope(url, env);
    if (url.pathname.startsWith("/c/")) return serveCover(url, env);
    const mainnetPage = url.pathname === "/quests" ? "/mainnet/quests" : url.pathname === "/" || url.pathname === "/index.html" ? "/mainnet/" : null;
    const targetReq = fullPageRequest(mainnet && mainnetPage ? atPath(req, mainnetPage) : req);
    const assetRes = await env.ASSETS.fetch(targetReq);
    if (mainnet && !/\.[a-z0-9]+$/i.test(url.pathname)) {
      const addrs = await getAddresses(env.LAUNCH_STATE);
      if (addrs) return injectAddrScript(assetRes, addrs);
    }
    return assetRes;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const upgrade = httpsRedirect(req);
    if (upgrade) return upgrade;
    try {
      return await secure(await serve(req, env));
    } catch (e) {
      console.error(e);
      return secure(new Response(JSON.stringify({ error: "Something went wrong." }), { status: 500, headers: { "content-type": "application/json", "cache-control": "no-store" } }));
    }
  },
};
