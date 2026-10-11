// Envelope styles and notes (no DOM, so the share-card Worker can use it too). Purely cosmetic: the choice rides in the claim link (#/claim/handle?e=red&m=...),
// never on-chain, so nothing about the escrow changes and a link without it still works.

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
}

export const STYLES: Style[] = [
  { id: "air", name: "Airmail", tag: "Classic", paper: "#fffaf0", flap: "#f6d44c", ink: "#191730", seal: "#d9362b", glyph: "邮" },
  { id: "red", name: "Red packet", tag: "福", paper: "#d9362b", flap: "#b82418", ink: "#fbe7a1", seal: "#f6d44c", glyph: "福" },
  { id: "gold", name: "Gold", tag: "Festive", paper: "#f6d44c", flap: "#e8b923", ink: "#4a1d12", seal: "#d9362b", glyph: "★" },
  { id: "sakura", name: "Sakura", tag: "Soft", paper: "#fbd5df", flap: "#f4a9bd", ink: "#4a1d3a", seal: "#c2386b", glyph: "花" },
  { id: "night", name: "Midnight", tag: "Dark", paper: "#191730", flap: "#2a2750", ink: "#f0e6d0", seal: "#f6d44c", glyph: "月" },
  { id: "mint", name: "Mint", tag: "Fresh", paper: "#cfeedd", flap: "#9bd8b8", ink: "#13392b", seal: "#2350d8", glyph: "叶" },
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

/** The link to share. With an envelope it points at /e/<handle>, which serves a preview card to crawlers (Telegram, Bluesky) and sends people on to the claim page. */
export function shareLink(origin: string, handle: string, styleId: string, note: string, amount: string, cover = ""): string {
  const n = cleanNote(note);
  const c = isCoverId(cover) ? cover : "";
  if ((!styleId || styleId === "air") && !n && !c) return `${origin}/#/claim/${handle}`;
  const q: string[] = [];
  if (styleId && styleId !== "air") q.push("e=" + encodeURIComponent(styleId));
  if (n) q.push("m=" + encodeURIComponent(n));
  if (c) q.push("c=" + c);
  if (amount) q.push("a=" + encodeURIComponent(amount));
  return `${origin}/e/${handle}${q.length ? "?" + q.join("&") : ""}`;
}
