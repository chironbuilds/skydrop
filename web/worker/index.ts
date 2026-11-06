// Serves the static app, plus share cards: /e/<handle>?e=red&m=note&a=2 returns the page crawlers read (Open Graph),
// and /og draws the envelope as a PNG. People opening /e/... are sent straight on to the claim page.
import { handleLists } from "./lists";
import { esc, handleShare, isLatin, isWide, wrap } from "./share";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
// @ts-expect-error wrangler turns .wasm imports into compiled modules
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import { handleGate, liveDeps } from "./gate";
import { cleanNote, envelopeHash, isCoverId, styleOf, type Style } from "../src/envelope-data";

interface Env {
  ASSETS: { fetch(r: Request): Promise<Response> };
  COVERS: { get(k: string, t: "arrayBuffer"): Promise<ArrayBuffer | null>; put(k: string, v: ArrayBuffer, o?: { expirationTtl?: number }): Promise<void> };
}

const MAX_COVER = 90_000;
// long enough for any gift's refund period, short enough that nothing is hosted for ever
const COVER_TTL = 60 * 60 * 24 * 90;

let ready: Promise<void> | null = null;
const cleanHandle = (s: string): string => (/^[a-z0-9][a-z0-9.-]{0,252}$/i.test(s) ? s.toLowerCase() : "");
const cleanAmount = (s: string | null): string => (s && /^[0-9][0-9.,]{0,18}( [A-Za-z]{1,8})?$/.test(s) ? s : "");

function params(url: URL): { handle: string; style: Style; note: string; amount: string; cover: string } {
  return {
    handle: cleanHandle(url.searchParams.get("h") ?? url.pathname.split("/")[2] ?? ""),
    style: styleOf(url.searchParams.get("e")),
    note: cleanNote(url.searchParams.get("m") ?? ""),
    amount: cleanAmount(url.searchParams.get("a")),
    cover: isCoverId(url.searchParams.get("c")) ? url.searchParams.get("c")! : "",
  };
}

function page(url: URL): Response {
  const origin = url.hostname === "localhost" ? url.origin : "https://" + url.host;
  const { handle, style, note, amount } = params(url);
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
async function render(svg: string, text: string): Promise<{ bytes: Uint8Array; complete: boolean }> {
  ready ??= initWasm(resvgWasm);
  await ready;
  const chars = [...new Set(text)];
  const latin = chars.filter(isLatin).join("");
  const wide = chars.filter((c) => !isLatin(c)).join("");
  const [a, b] = await Promise.all([font("Fraunces", 700, latin || "a"), wide ? font("Noto Sans SC", 700, wide) : Promise.resolve(null)]);
  const fontBuffers = [a, b].filter((f): f is Uint8Array => !!f);
  const bytes = new Resvg(svg, { font: { fontBuffers, loadSystemFonts: false, defaultFontFamily: "Fraunces" } }).render().asPng();
  return { bytes, complete: !!a && (!wide || !!b) };
}

function toBase64(buf: ArrayBuffer): string {
  let bin = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** The preview card: the tall envelope on the left (with the sender's picture as its cover, if any), the words on the right. */
function card(style: Style, handle: string, note: string, amount: string, cover: string): { svg: string; text: string } {
  const lines = wrap(note || (amount ? `${amount} for you` : "A little something for you"), 46, 560);
  const who = handle ? `@${handle}` : "";
  const head = who ? `a gift for ${who}` : "a gift on Tari";
  const text = [...lines, amount, head, "Skydrop", "skydrop.tari.mw", style.glyph, "福"].join("");
  const stripe = `<pattern id="s" width="40" height="40" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><rect width="20" height="40" fill="#d9362b"/><rect x="20" width="20" height="40" fill="#2350d8"/></pattern>`;
  // envelope: x 130..440, y 60..570. The cover covers the top 78% and its bottom edge bulges down in the middle.
  const x0 = 130, x1 = 440, y0 = 60, y1 = 570, cx = (x0 + x1) / 2;
  const cb = y0 + (y1 - y0) * 0.78;
  const bulge = 34;
  const coverPath = `M${x0},${y0 + 18} Q${x0},${y0} ${x0 + 18},${y0} L${x1 - 18},${y0} Q${x1},${y0} ${x1},${y0 + 18} L${x1},${cb - 12} Q${x1},${cb} ${cx},${cb + bulge} Q${x0},${cb} ${x0},${cb - 12} Z`;
  const pic = cover
    ? `<clipPath id="cv"><path d="${coverPath}"/></clipPath><image href="__COVER__" x="${x0}" y="${y0}" width="${x1 - x0}" height="${cb + bulge - y0}" preserveAspectRatio="xMidYMid slice" clip-path="url(#cv)"/>`
    : `<path d="${coverPath}" fill="${style.paper}"/><rect x="${x0 + 18}" y="${y0 + 18}" width="${x1 - x0 - 36}" height="${cb - y0 - 40}" rx="10" fill="none" stroke="${style.ink}" stroke-opacity=".35" stroke-width="3"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><defs>${stripe}</defs>
<rect width="1200" height="630" fill="#f0e6d0"/>
<rect width="1200" height="14" fill="url(#s)"/><rect y="616" width="1200" height="14" fill="url(#s)"/>
<rect x="${x0 + 8}" y="${y0 + 8}" width="${x1 - x0}" height="${y1 - y0}" rx="20" fill="#191730"/>
<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" rx="20" fill="${style.paper}" stroke="#191730" stroke-width="5"/>
${pic}
<path d="${coverPath}" fill="none" stroke="#191730" stroke-width="5"/>
<circle cx="${cx}" cy="${cb + bulge - 6}" r="44" fill="#e9cf9b" stroke="#191730" stroke-opacity=".35" stroke-width="3"/>
<text x="${cx}" y="${cb + bulge + 8}" text-anchor="middle" font-family="Noto Sans SC" font-weight="700" font-size="38" fill="#a98b4d">${esc(cover ? "福" : style.glyph)}</text>
<text x="540" y="120" font-family="Fraunces" font-weight="700" font-size="40" fill="#191730">Skydrop</text>
<text x="540" y="168" font-family="Fraunces" font-weight="700" font-size="28" fill="#857e96">${esc(head)}</text>
${lines.map((l, i) => `<text x="540" y="${290 + i * 58}" font-family="Fraunces, Noto Sans SC" font-weight="700" font-size="46" fill="#191730">${esc(l)}</text>`).join("")}
${amount ? `<text x="540" y="${290 + lines.length * 58 + 30}" font-family="Fraunces" font-weight="700" font-size="40" fill="#d9362b">${esc(amount)}</text>` : ""}
<text x="540" y="580" font-family="Fraunces" font-weight="700" font-size="26" fill="#857e96">skydrop.tari.mw</text>
</svg>`;
  return { svg, text };
}

/** At most `max` calls of `name` per address per hour. KV is eventually consistent, so this is a brake, not a hard cap. */
async function overLimit(req: Request, env: Env, name: string, max: number): Promise<boolean> {
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  const hour = Math.floor(Date.now() / 3_600_000);
  const rate = `rate:${name}:${hour}:${ip}`;
  const used = Number(new TextDecoder().decode((await env.COVERS.get(rate, "arrayBuffer")) ?? new ArrayBuffer(0))) || 0;
  if (used >= max) return true;
  await env.COVERS.put(rate, new TextEncoder().encode(String(used + 1)).buffer as ArrayBuffer, { expirationTtl: 3700 });
  return false;
}

async function png(url: URL, env: Env, req: Request): Promise<Response> {
  const { handle, style, note, amount, cover } = params(url);
  const cache = (caches as unknown as { default: Cache }).default;
  // keyed by what is actually drawn, so junk in the query string cannot create new entries
  const key = new Request(`${url.origin}/og-cache?h=${encodeURIComponent(handle)}&e=${style.id}&m=${encodeURIComponent(note)}&a=${encodeURIComponent(amount)}&c=${cover}`);
  const hit = await cache.match(key);
  if (hit) return hit;
  // drawing costs CPU and font downloads: a new picture is allowed a limited number of times per address
  if (await overLimit(req, env, "og", 60)) return new Response("slow down", { status: 429 });
  const coverBytes = cover && !(await banned(cover, env)) ? await env.COVERS.get(cover, "arrayBuffer") : null;
  const built = card(style, handle, note, amount, coverBytes ? "x" : "");
  const svg = coverBytes ? built.svg.replace("__COVER__", "data:image/jpeg;base64," + toBase64(coverBytes)) : built.svg;
  const { bytes: out, complete } = await render(svg, built.text);
  const res = new Response(out, { headers: { "content-type": "image/png", "cache-control": complete ? "public, max-age=86400" : "no-store" } });
  if (complete) await cache.put(key, res.clone());
  return res;
}

const isJpeg = (b: Uint8Array): boolean => b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/** Stores an uploaded cover (a JPEG the page already shrank) under its content hash. */
async function saveCover(req: Request, env: Env): Promise<Response> {
  const json = (o: unknown, status = 200): Response => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  if (await overLimit(req, env, "cover", 20)) return json({ error: "slow down" }, 429);
  if (Number(req.headers.get("content-length") ?? 0) > MAX_COVER) return json({ error: "too big" }, 413);
  const buf = await req.arrayBuffer();
  if (buf.byteLength > MAX_COVER) return json({ error: "too big" }, 413);
  if (!isJpeg(new Uint8Array(buf))) return json({ error: "not a jpeg" }, 415);
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
  return new Response(buf, { headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" } });
}

const HASH_RE = /^[0-9a-f]{64}$/;

/**
 * Remembers which envelope went with a deposit, keyed by the deposit's fingerprint (sender key, amount, refund
 * epoch, window), so the bot's mention and the sender's "Remind them" link can show the same card. The first
 * write wins, so nobody can swap the envelope of a deposit after its sender registered it.
 */
async function saveEnvelope(req: Request, env: Env): Promise<Response> {
  const json = (o: unknown, status = 200): Response => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  if (await overLimit(req, env, "envelope", 30)) return json({ error: "slow down" }, 429);
  const text = await req.text();
  if (text.length > 600) return json({ error: "too big" }, 413);
  let body: { e?: string; m?: string; c?: string };
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "bad json" }, 400);
  }
  // a record is stored under the hash of its own content, which is what a deposit commits to on-chain: it cannot be
  // squatted, and nobody can store a different record where a gift's envelope belongs
  const rec = { e: styleOf(body.e).id, m: cleanNote(body.m ?? ""), c: isCoverId(body.c) ? body.c : "" };
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

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/api/gate" && req.method === "POST" && (await overLimit(req, env, "gate", 20))) return new Response(JSON.stringify({ error: "Too many locked posts from this address. Try again later." }), { status: 429, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
    const gate = await handleGate(req, liveDeps(env.COVERS as never));
    if (gate) return gate;
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
    if (url.pathname.startsWith("/e/")) return page(url);
    if (url.pathname === "/og") return png(url, env, req);
    if (url.pathname === "/cover" && req.method === "POST") return saveCover(req, env);
    if (url.pathname === "/envelope") return req.method === "POST" ? saveEnvelope(req, env) : readEnvelope(url, env);
    if (url.pathname.startsWith("/c/")) return serveCover(url, env);
    return env.ASSETS.fetch(req);
  },
};
