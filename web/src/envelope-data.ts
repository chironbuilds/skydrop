// Envelope styles and notes (no DOM, so the share-card Worker and the bot can use it too). Purely cosmetic: the choice
// rides in the claim link (#/claim/handle?e=red&m=...), and a deposit commits only to its hash, so nothing about the
// escrow changes and a link without it still works.

export interface Style {
  id: string;
  name: string;
  /** shown under the name, for the picker */
  tag: string;
  paper: string;
  flap: string;
  ink: string;
  seal: string;
  glyph: string;
  /** the pattern on the cover when the sender doesn't pick one */
  pattern?: string;
}

export const STYLES: Style[] = [
  { id: "air", name: "Airmail", tag: "Classic", paper: "#fffaf0", flap: "#f6d44c", ink: "#191730", seal: "#d9362b", glyph: "邮" },
  { id: "red", name: "Red packet", tag: "福", paper: "#d9362b", flap: "#b82418", ink: "#fbe7a1", seal: "#f6d44c", glyph: "福" },
  { id: "gold", name: "Gold", tag: "Festive", paper: "#f6d44c", flap: "#e8b923", ink: "#4a1d12", seal: "#d9362b", glyph: "★" },
  { id: "sakura", name: "Sakura", tag: "Soft", paper: "#fbd5df", flap: "#f4a9bd", ink: "#4a1d3a", seal: "#c2386b", glyph: "花" },
  { id: "night", name: "Midnight", tag: "Dark", paper: "#191730", flap: "#2a2750", ink: "#f0e6d0", seal: "#f6d44c", glyph: "月" },
  { id: "mint", name: "Mint", tag: "Fresh", paper: "#cfeedd", flap: "#9bd8b8", ink: "#13392b", seal: "#2350d8", glyph: "叶" },
  { id: "bday", name: "Birthday", tag: "Party", paper: "#ffd6e8", flap: "#ff9ec7", ink: "#5b1037", seal: "#7b3fe4", glyph: "🎂", pattern: "confetti" },
  { id: "love", name: "Love", tag: "Hearts", paper: "#e5384f", flap: "#c21f3a", ink: "#fff0f2", seal: "#ffd1dc", glyph: "♥", pattern: "hearts" },
  { id: "snow", name: "Snowfall", tag: "Winter", paper: "#dceefe", flap: "#a9d2f7", ink: "#123a63", seal: "#d9362b", glyph: "❄", pattern: "snow" },
  { id: "galaxy", name: "Galaxy", tag: "Cosmic", paper: "#14123a", flap: "#2a2770", ink: "#e9e4ff", seal: "#c792ff", glyph: "✦", pattern: "stars" },
  { id: "tari", name: "Tari", tag: "Gem", paper: "#6b3fe4", flap: "#4f27c2", ink: "#f3ecff", seal: "#ffd84d", glyph: "💎", pattern: "grid" },
  { id: "ocean", name: "Ocean", tag: "Calm", paper: "#1f6fb2", flap: "#155a93", ink: "#e8f6ff", seal: "#f6d44c", glyph: "🌊", pattern: "waves" },
  { id: "kraft", name: "Kraft", tag: "Rustic", paper: "#c89b6d", flap: "#a97c4f", ink: "#3a2412", seal: "#8a1c1c", glyph: "✉", pattern: "stripes" },
  { id: "matcha", name: "Matcha", tag: "Earthy", paper: "#a9bf7a", flap: "#8aa35a", ink: "#23331a", seal: "#f6d44c", glyph: "茶", pattern: "dots" },
];

export const MAX_NOTE = 80;

export function styleOf(id: string | null | undefined): Style {
  return STYLES.find((s) => s.id === id) ?? STYLES[0]!;
}

/** Keep notes short and free of control characters; they end up in a URL and in a post. */
export function cleanNote(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NOTE);
}

/** An uploaded cover is stored by the Worker under the first 16 hex of its SHA-256. */
export const isCoverId = (s: string | null | undefined): s is string => !!s && /^[0-9a-f]{16}$/.test(s);

// ---- extras: everything beyond style, note and picture. Each is optional and short. -------------------------

/** p: cover pattern, g: seal symbol, k: custom cover colour, f: note font, x: what bursts out when it's opened */
export interface Extras { p?: string; g?: string; k?: string; f?: string; x?: string }

export const PATTERNS: { id: string; name: string }[] = [
  { id: "none", name: "Plain" },
  { id: "dots", name: "Dots" },
  { id: "stripes", name: "Stripes" },
  { id: "grid", name: "Grid" },
  { id: "waves", name: "Waves" },
  { id: "confetti", name: "Confetti" },
  { id: "hearts", name: "Hearts" },
  { id: "stars", name: "Stars" },
  { id: "snow", name: "Snow" },
];
export const FONTS: { id: string; name: string }[] = [
  { id: "", name: "Classic" },
  { id: "hand", name: "Handwritten" },
  { id: "type", name: "Typewriter" },
];
export const EFFECTS: { id: string; name: string; chars: string[] }[] = [
  { id: "", name: "None", chars: [] },
  { id: "confetti", name: "Confetti", chars: [] },
  { id: "hearts", name: "Hearts", chars: ["❤️", "💖", "💕"] },
  { id: "stars", name: "Sparkles", chars: ["✨", "⭐", "🌟"] },
  { id: "snow", name: "Snow", chars: ["❄️", "❅", "❆"] },
  { id: "coins", name: "Coins", chars: ["🪙", "💰", "💎"] },
  { id: "flowers", name: "Petals", chars: ["🌸", "🌷", "🌼"] },
];
/** Seal symbols offered in the picker. Any single symbol can be typed too. */
export const SEALS = ["福", "★", "♥", "✦", "❄", "☀", "☾", "♪", "🎂", "🎉", "🎁", "❤️", "🌸", "🍀", "🔥", "🚀", "💎", "☕", "🐉", "🌊"];

const FONT_FAMILY: Record<string, string> = { hand: "Caveat", type: "DM Mono" };
/** The font a card or page uses for the note. */
export const noteFont = (f: string | undefined): string => FONT_FAMILY[f ?? ""] ?? "Fraunces";

/** One symbol (a single grapheme, emoji included), or "" when it isn't one. */
export function cleanGlyph(s: string | null | undefined): string {
  const t = (s ?? "").replace(/[\u0000-\u001f\u007f\s<>&"'`\\]/g, "");
  if (!t) return "";
  const seg = typeof Intl !== "undefined" && "Segmenter" in Intl ? [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(t)].map((x) => x.segment) : [...t];
  const g = seg[0] ?? "";
  return g.length <= 16 ? g : "";
}

/** The extras with anything unknown or malformed dropped. */
export function cleanExtras(x: Partial<Record<keyof Extras, string | null | undefined>> | null | undefined): Extras {
  const out: Extras = {};
  if (!x) return out;
  if (x.p && PATTERNS.some((p) => p.id === x.p)) out.p = x.p;
  const g = cleanGlyph(x.g);
  if (g) out.g = g;
  const k = (x.k ?? "").replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{6}$/.test(k)) out.k = `#${k}`;
  if (x.f && FONTS.some((f) => f.id === x.f && f.id)) out.f = x.f;
  if (x.x && EFFECTS.some((e) => e.id === x.x && e.id)) out.x = x.x;
  return out;
}

export const hasExtras = (x: Extras): boolean => Object.keys(cleanExtras(x)).length > 0;

/** Reads extras from a link's query (p, g, k, f, x). */
export const extrasFromQuery = (get: (k: string) => string | null): Extras => cleanExtras({ p: get("p"), g: get("g"), k: get("k"), f: get("f"), x: get("x") });

const hex = (c: string): [number, number, number] => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
const toHex = (r: number, g: number, b: number): string => "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");

/** The style as the extras change it: a custom colour repaints the cover (with readable ink), a seal symbol replaces the glyph. */
export function effectiveStyle(style: Style, x: Extras): Style & { pattern: string } {
  const c = cleanExtras(x);
  let s: Style = { ...style };
  if (c.k) {
    const [r, g, b] = hex(c.k);
    const light = 0.2126 * r + 0.7152 * g + 0.0722 * b > 150;
    s = { ...s, paper: c.k, flap: toHex(r * 0.82, g * 0.82, b * 0.82), ink: light ? "#191730" : "#fffaf0" };
  }
  if (c.g) s.glyph = c.g;
  return { ...s, pattern: c.p ?? style.pattern ?? "none" };
}

/**
 * A repeating tile for a cover pattern, as SVG markup (no outer <svg>), drawn in `ink`. The page uses it as a
 * background picture and the share card as an SVG <pattern>, so both look the same.
 */
export function patternTile(id: string, ink: string): { w: number; h: number; body: string } | null {
  const o = `fill="${ink}" fill-opacity=".22"`;
  const s = `fill="none" stroke="${ink}" stroke-opacity=".2"`;
  const heart = (x: number, y: number, k: number): string => `<path transform="translate(${x} ${y}) scale(${k})" d="M5 9C5 9 0 6 0 3C0 0 4-1 5 2C6-1 10 0 10 3C10 6 5 9 5 9Z" ${o}/>`;
  const star = (x: number, y: number, k: number): string => `<path transform="translate(${x} ${y}) scale(${k})" d="M5 0L6.2 3.8L10 5L6.2 6.2L5 10L3.8 6.2L0 5L3.8 3.8Z" fill="${ink}" fill-opacity=".35"/>`;
  switch (id) {
    case "dots":
      return { w: 24, h: 24, body: `<circle cx="6" cy="6" r="2.6" ${o}/><circle cx="18" cy="18" r="2.6" ${o}/>` };
    case "stripes":
      return { w: 20, h: 20, body: `<path d="M-5 5L5-5M0 20L20 0M15 25L25 15" ${s} stroke-width="4"/>` };
    case "grid":
      return { w: 28, h: 28, body: `<path d="M14 0V28M0 14H28" ${s} stroke-width="3"/><path d="M0 0H28V28" ${s} stroke-width="1"/>` };
    case "waves":
      return { w: 40, h: 16, body: `<path d="M0 8Q10 0 20 8T40 8" ${s} stroke-width="2.5"/>` };
    case "hearts":
      return { w: 40, h: 40, body: heart(6, 6, 1) + heart(26, 24, 0.8) };
    case "stars":
      return { w: 44, h: 44, body: star(4, 6, 1) + star(28, 26, 0.7) + `<circle cx="30" cy="8" r="1.2" fill="${ink}" fill-opacity=".4"/><circle cx="10" cy="34" r="1" fill="${ink}" fill-opacity=".4"/>` };
    case "snow":
      return { w: 36, h: 36, body: `<circle cx="7" cy="8" r="2.4" ${o}/><circle cx="25" cy="20" r="3.2" ${o}/><circle cx="14" cy="29" r="1.6" ${o}/><circle cx="31" cy="5" r="1.3" ${o}/>` };
    case "confetti": {
      const bits: [number, number, number, string][] = [[6, 8, 20, "#d9362b"], [28, 6, -30, "#2350d8"], [18, 26, 45, "#f6d44c"], [38, 30, 10, "#2aa876"], [8, 38, -15, "#c2386b"], [32, 44, 60, "#7b3fe4"]];
      return { w: 48, h: 52, body: bits.map(([x, y, r, c]) => `<rect x="${x}" y="${y}" width="7" height="3.4" rx="1" fill="${c}" fill-opacity=".75" transform="rotate(${r} ${x + 3.5} ${y + 1.7})"/>`).join("") };
    }
    default:
      return null;
  }
}

/** The link to share. With an envelope it points at /e/<handle>, which serves a preview card to crawlers (Telegram, Bluesky) and sends people on to the claim page. */
export function shareLink(origin: string, handle: string, styleId: string, note: string, amount: string, cover = "", extras: Extras = {}): string {
  const n = cleanNote(note);
  const c = isCoverId(cover) ? cover : "";
  const x = cleanExtras(extras);
  const q: string[] = [];
  if (styleId && styleId !== "air") q.push("e=" + encodeURIComponent(styleId));
  if (n) q.push("m=" + encodeURIComponent(n));
  if (c) q.push("c=" + c);
  if (x.p) q.push("p=" + x.p);
  if (x.g) q.push("g=" + encodeURIComponent(x.g));
  if (x.k) q.push("k=" + x.k.slice(1));
  if (x.f) q.push("f=" + x.f);
  if (x.x) q.push("x=" + x.x);
  if (amount) q.push("a=" + encodeURIComponent(amount));
  return `${origin}/e/${handle}${q.length ? "?" + q.join("&") : ""}`;
}

export interface EnvelopeRecord extends Extras { e: string; m: string; c: string; a?: string }

type RecLike = { e?: string; m?: string; c?: string } & Partial<Record<keyof Extras, string>>;

/** A record's extras in a fixed key order, or null when it has none (so older envelopes keep their old hash). */
function canonExtras(rec: RecLike): Record<string, string> | null {
  const x = cleanExtras(rec) as Record<string, string>;
  const keys = Object.keys(x).sort();
  return keys.length ? Object.fromEntries(keys.map((k) => [k, x[k]!])) : null;
}

/**
 * The hash a deposit commits to for its envelope: SHA-256 of the cleaned style, note, cover and extras. The registry
 * stores a record under its own hash, so nobody can put something else where a gift's envelope belongs, and the bot
 * only shows a record whose hash matches the one on-chain. A record without extras hashes exactly as before.
 */
export async function envelopeHash(rec: RecLike): Promise<string> {
  const base: unknown[] = [styleOf(rec.e).id, cleanNote(rec.m ?? ""), isCoverId(rec.c) ? rec.c : ""];
  const x = canonExtras(rec);
  const canon = JSON.stringify(x ? [...base, x] : base);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canon)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The record to store and hash: style, note, cover and the extras, all cleaned. */
export function cleanRecord(rec: RecLike): EnvelopeRecord {
  return { e: styleOf(rec.e).id, m: cleanNote(rec.m ?? ""), c: isCoverId(rec.c) ? rec.c : "", ...cleanExtras(rec) };
}

/** True when the envelope is just the plain default, which needs no hash or registry entry. */
export const isPlainEnvelope = (rec: RecLike): boolean => styleOf(rec.e).id === "air" && !cleanNote(rec.m ?? "") && !isCoverId(rec.c) && !canonExtras(rec);
