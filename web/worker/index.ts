// Serves the static app, plus share cards: /e/<handle>?e=red&m=note&a=2 returns the page crawlers read (Open Graph),
// and /og draws the envelope as a PNG. People opening /e/... are sent straight on to the claim page.
import { initWasm, Resvg } from "@resvg/resvg-wasm";
// @ts-expect-error wrangler turns .wasm imports into compiled modules
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import { cleanNote, styleOf, type Style } from "../src/envelope-data";

interface Env { ASSETS: { fetch(r: Request): Promise<Response> } }

let ready: Promise<void> | null = null;
const ENT: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ENT[c]!);
const cleanHandle = (s: string): string => (/^[a-z0-9][a-z0-9.-]{0,252}$/i.test(s) ? s.toLowerCase() : "");
const cleanAmount = (s: string | null): string => (s && /^[0-9][0-9.,]{0,18}( [A-Za-z]{1,8})?$/.test(s) ? s : "");

function params(url: URL): { handle: string; style: Style; note: string; amount: string } {
  return {
    handle: cleanHandle(url.searchParams.get("h") ?? url.pathname.split("/")[2] ?? ""),
    style: styleOf(url.searchParams.get("e")),
    note: cleanNote(url.searchParams.get("m") ?? ""),
    amount: cleanAmount(url.searchParams.get("a")),
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
<meta name="theme-color" content="${style.paper}"><meta http-equiv="refresh" content="0;url=${esc(dest)}"></head>
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

const isWide = (c: string): boolean => /[\u2e80-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(c) || (c.codePointAt(0) ?? 0) > 0x1f000;
const isLatin = (c: string): boolean => !isWide(c) && c.charCodeAt(0) < 0x250;

function wrap(text: string, size: number, max: number): string[] {
  const width = (t: string): number => [...t].reduce((n, ch) => n + (isWide(ch) ? 1 : ch === " " ? 0.3 : 0.56) * size, 0);
  const lines: string[] = [];
  let cur = "";
  for (const ch of [...text]) {
    if (width(cur + ch) > max && cur) {
      const sp = !isWide(ch) ? cur.lastIndexOf(" ") : -1;
      if (sp > 0) { lines.push(cur.slice(0, sp)); cur = cur.slice(sp + 1); } else { lines.push(cur); cur = ""; }
    }
    cur += ch;
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines.slice(0, 3).map((l) => l.trim());
}

function card(style: Style, handle: string, note: string, amount: string): { svg: string; text: string } {
  const lines = wrap(note || (amount ? `${amount} for you` : "A little something for you"), 38, 520);
  const lineY = 250 - (lines.length - 1) * 23;
  const who = handle ? `@${handle}` : "";
  const head = who ? `a gift for ${who}` : "a gift on Tari";
  const text = [...lines, amount, head, "Skydrop", "skydrop.tari.mw", style.glyph].join("");
  const stripe = `<pattern id="s" width="40" height="40" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><rect width="20" height="40" fill="#d9362b"/><rect x="20" width="20" height="40" fill="#2350d8"/></pattern>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><defs>${stripe}</defs>
<rect width="1200" height="630" fill="#f0e6d0"/>
<rect width="1200" height="14" fill="url(#s)"/><rect y="616" width="1200" height="14" fill="url(#s)"/>
<text x="70" y="86" font-family="Fraunces" font-weight="700" font-size="40" fill="#191730">Skydrop</text>
<text x="1130" y="86" text-anchor="end" font-family="Fraunces" font-weight="700" font-size="30" fill="#191730">${esc(head)}</text>
<polygon points="250,335 950,335 600,105" fill="${style.flap}" stroke="#191730" stroke-width="5" stroke-linejoin="round"/>
<rect x="320" y="135" width="560" height="300" rx="12" fill="#fffdf6" stroke="#191730" stroke-width="5"/>
${lines.map((l, i) => `<text x="600" y="${lineY + i * 46}" text-anchor="middle" font-family="Fraunces, Noto Sans SC" font-weight="700" font-size="38" fill="#191730">${esc(l)}</text>`).join("")}
<rect x="250" y="330" width="700" height="232" rx="14" fill="${style.paper}" stroke="#191730" stroke-width="5"/>
<polyline points="252,332 600,490 948,332" fill="none" stroke="#000" stroke-opacity=".22" stroke-width="3"/>
<polyline points="252,560 460,420" fill="none" stroke="#000" stroke-opacity=".18" stroke-width="3"/><polyline points="948,560 740,420" fill="none" stroke="#000" stroke-opacity=".18" stroke-width="3"/>
<circle cx="600" cy="480" r="38" fill="${style.seal}" stroke="#191730" stroke-width="5"/>
<text x="600" y="492" text-anchor="middle" font-family="Noto Sans SC" font-weight="700" font-size="32" fill="${style.ink}">${esc(style.glyph)}</text>
${amount ? `<text x="600" y="548" text-anchor="middle" font-family="Fraunces" font-weight="700" font-size="28" fill="${style.ink}">${esc(amount)}</text>` : ""}
<text x="70" y="592" font-family="Fraunces" font-weight="700" font-size="28" fill="#857e96">skydrop.tari.mw</text>
</svg>`;
  return { svg, text };
}

async function png(url: URL): Promise<Response> {
  const { handle, style, note, amount } = params(url);
  const cache = (caches as unknown as { default: Cache }).default;
  const key = new Request(url.origin + "/og-cache" + url.search);
  const hit = await cache.match(key);
  if (hit) return hit;
  ready ??= initWasm(resvgWasm);
  await ready;
  const { svg, text } = card(style, handle, note, amount);
  const chars = [...new Set(text)];
  const latin = chars.filter(isLatin).join("");
  const wide = chars.filter((c) => !isLatin(c)).join("");
  const [a, b] = await Promise.all([font("Fraunces", 700, latin || "a"), wide ? font("Noto Sans SC", 700, wide) : Promise.resolve(null)]);
  const fontBuffers = [a, b].filter((f): f is Uint8Array => !!f);
  const out = new Resvg(svg, { font: { fontBuffers, loadSystemFonts: false, defaultFontFamily: "Fraunces" } }).render().asPng();
  const complete = !!a && (!wide || !!b);
  const res = new Response(out, { headers: { "content-type": "image/png", "cache-control": complete ? "public, max-age=86400" : "no-store" } });
  if (complete) await cache.put(key, res.clone());
  return res;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/e/")) return page(url);
    if (url.pathname === "/og") return png(url);
    return env.ASSETS.fetch(req);
  },
};
