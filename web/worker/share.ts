/**
 * A live campaign's share link: /q/<component>. People are sent straight on to their quests. Crawlers, like the one
 * behind Bluesky's link cards, read a page built from the contract, so a link can't claim terms the campaign doesn't have.
 */
import { approxTime, encodeLive, fromMicro, summarize } from "../../web-atproto/src/lib/campaign";
import { isComponent, phaseOf, readCampaign, type ChainCampaign } from "../../web-atproto/src/lib/chain";

const ENT: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ENT[c]!);

export const isWide = (c: string): boolean => /[\u2e80-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(c) || (c.codePointAt(0) ?? 0) > 0x1f000;
export const isLatin = (c: string): boolean => !isWide(c) && c.charCodeAt(0) < 0x250;

export function wrap(text: string, size: number, max: number, lines = 3): string[] {
  const width = (t: string): number => [...t].reduce((n, ch) => n + (isWide(ch) ? 1 : ch === " " ? 0.3 : 0.56) * size, 0);
  const out: string[] = [];
  let cur = "";
  for (const ch of [...text]) {
    if (width(cur + ch) > max && cur) {
      const sp = !isWide(ch) ? cur.lastIndexOf(" ") : -1;
      if (sp > 0) { out.push(cur.slice(0, sp)); cur = cur.slice(sp + 1); } else { out.push(cur); cur = ""; }
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  const kept = out.slice(0, lines).map((l) => l.trim());
  if (out.length > lines) kept[lines - 1] = `${kept[lines - 1]!.slice(0, -1)}…`;
  return kept;
}

const REF = /^did:(plc:[a-z2-7]{24}|web:[a-zA-Z0-9.-]{1,200})$/;
const COMPONENT_PATH = /^\/q\/(component_[0-9a-f]{64})(\/card\.png)?$/;

export interface ShareRoute { component: string; card: boolean; ref: string | null }

/** What a /q/ address asks for. Anything else in it is ignored, so junk can't make new cache entries. */
export function shareRoute(url: URL): ShareRoute | null {
  const m = COMPONENT_PATH.exec(url.pathname);
  if (!m || !isComponent(m[1]!)) return null;
  const ref = url.searchParams.get("ref");
  return { component: m[1]!, card: !!m[2], ref: ref && REF.test(ref) ? ref : null };
}

const rewardOf = (c: ChainCampaign): string => (c.root ? "Listed amounts" : `${fromMicro(c.reward)} tTARI`);
const stepsOf = (c: ChainCampaign): string => {
  if (!c.rules.length) return "Paid to the accounts on its list.";
  const s = summarize(c.rules);
  return `${s[0]!.toUpperCase()}${s.slice(1)}.`;
};
const timing = (c: ChainCampaign): string => {
  const phase = phaseOf(c);
  if (phase === "closed") return "This campaign has closed.";
  if (phase === "upcoming") return `Opens in ${approxTime(c.openEpoch - c.epoch)}.`;
  return `Closes in ${approxTime(c.closeEpoch - c.epoch)}.`;
};

/** Where a person following the link ends up. */
export const shareDest = (origin: string, component: string, ref: string | null): string => `${origin}/quests#add=${encodeLive(component)}${ref ? `&ref=${ref}` : ""}`;

export function sharePage(origin: string, url: URL, route: ShareRoute, c: ChainCampaign | null): string {
  const dest = c ? shareDest(origin, route.component, route.ref) : `${origin}/quests`;
  const title = c ? `${c.name}: ${c.root ? "see if you're on the list" : `earn ${rewardOf(c)}`} on Skydrop` : "A campaign on Skydrop";
  const desc = c ? `${stepsOf(c)} ${timing(c)} Testnet tokens with no monetary value.` : "See the Bluesky campaigns you're in and what you can claim.";
  const img = `${origin}/q/${route.component}/card.png`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta property="og:type" content="website"><meta property="og:site_name" content="Skydrop">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
${c ? `<meta property="og:image" content="${esc(img)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:type" content="image/png"><meta name="twitter:image" content="${esc(img)}">` : ""}
<meta property="og:url" content="${esc(url.href)}"><meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}"></head>
<body><p><a href="${esc(dest)}">Open this campaign on Skydrop</a></p><script>location.replace(${JSON.stringify(dest).replace(/</g, "\\u003c")})</script></body></html>`;
}

/** The picture on a link card. Everything on it comes from the contract, and anyone can write a campaign's name, so it's all escaped. */
export function shareCard(c: ChainCampaign): { svg: string; text: string } {
  const name = wrap(c.name, 62, 1060, 2);
  const steps = wrap(stepsOf(c), 32, 1060, 2);
  const reward = rewardOf(c);
  const foot = `${c.claimants.toLocaleString("en-US")} claimed · ${timing(c).replace(/\.$/, "")}`;
  const stripe = `<pattern id="s" width="40" height="40" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><rect width="20" height="40" fill="#d9362b"/><rect x="20" width="20" height="40" fill="#2350d8"/></pattern>`;
  const nameY = 190;
  const rewardY = nameY + (name.length - 1) * 74 + 104;
  const stepsY = rewardY + 66;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><defs>${stripe}</defs>
<rect width="1200" height="630" fill="#f0e6d0"/>
<rect width="1200" height="14" fill="url(#s)"/><rect y="616" width="1200" height="14" fill="url(#s)"/>
<text x="70" y="96" font-family="Fraunces" font-weight="700" font-size="38" fill="#191730">Skydrop</text>
<text x="1130" y="94" text-anchor="end" font-family="Fraunces" font-weight="700" font-size="26" fill="#857e96">Tari testnet</text>
${name.map((l, i) => `<text x="70" y="${nameY + i * 74}" font-family="Fraunces, Noto Sans SC" font-weight="700" font-size="62" fill="#191730">${esc(l)}</text>`).join("")}
<text x="70" y="${rewardY}" font-family="Fraunces" font-weight="700" font-size="72" fill="#d9362b">${esc(reward)}</text>
${steps.map((l, i) => `<text x="70" y="${stepsY + i * 42}" font-family="Fraunces, Noto Sans SC" font-weight="700" font-size="32" fill="#5a5470">${esc(l)}</text>`).join("")}
<text x="70" y="572" font-family="Fraunces" font-weight="700" font-size="26" fill="#5a5470">${esc(foot)}</text>
<text x="1130" y="572" text-anchor="end" font-family="Fraunces" font-weight="700" font-size="26" fill="#857e96">skydrop.tari.mw</text>
</svg>`;
  return { svg, text: [...name, ...steps, reward, foot, "Skydrop", "Tari testnet", "skydrop.tari.mw"].join("") };
}

export interface ShareDeps {
  draw: (svg: string, text: string) => Promise<Uint8Array | null>;
  overLimit: () => Promise<boolean>;
  read?: (component: string) => Promise<ChainCampaign>;
}

/** Handles /q/ addresses; null for anything else. Both answers are cached, so a popular link doesn't hammer the network. */
export async function handleShare(req: Request, url: URL, deps: ShareDeps): Promise<Response | null> {
  if (!url.pathname.startsWith("/q/")) return null;
  const route = shareRoute(url);
  if (!route || (req.method !== "GET" && req.method !== "HEAD")) return new Response("not found", { status: 404 });
  const origin = url.hostname === "localhost" ? url.origin : `https://${url.host}`;
  const cache = (caches as unknown as { default: Cache }).default;
  const key = new Request(`${url.origin}/q-cache/${route.component}${route.card ? "/card" : ""}?ref=${encodeURIComponent(route.ref ?? "")}`);
  const hit = await cache.match(key);
  if (hit) return hit;
  const c = await (deps.read ?? readCampaign)(route.component).catch(() => null);
  if (route.card) {
    if (!c) return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
    if (await deps.overLimit()) return new Response("slow down", { status: 429 });
    const { svg, text } = shareCard(c);
    const png = await deps.draw(svg, text);
    if (!png) return new Response("unavailable", { status: 503, headers: { "cache-control": "no-store" } });
    const res = new Response(png, { headers: { "content-type": "image/png", "cache-control": "public, max-age=600" } });
    await cache.put(key, res.clone());
    return res;
  }
  // An address with no campaign is remembered briefly too, so made-up ones can't be used to hammer the network.
  const res = new Response(sharePage(origin, url, route, c), { status: c ? 200 : 404, headers: { "content-type": "text/html; charset=utf-8", "cache-control": c ? "public, max-age=300" : "public, max-age=60" } });
  await cache.put(key, res.clone());
  return res;
}
