// Envelope styles and notes. Purely cosmetic: the choice rides in the claim link (#/claim/handle?e=red&m=...),
// never on-chain, so nothing about the escrow changes and a link without it still works.
import { h } from "./dom";

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
  { id: "air", name: "Airmail", tag: "Classic", paper: "#fffaf0", flap: "#f6d44c", ink: "#191730", seal: "#d9362b", glyph: "✉" },
  { id: "red", name: "Red packet", tag: "红包", paper: "#d9362b", flap: "#b82418", ink: "#fbe7a1", seal: "#f6d44c", glyph: "福" },
  { id: "gold", name: "Gold", tag: "Festive", paper: "#f6d44c", flap: "#e8b923", ink: "#4a1d12", seal: "#d9362b", glyph: "★" },
  { id: "sakura", name: "Sakura", tag: "Soft", paper: "#fbd5df", flap: "#f4a9bd", ink: "#4a1d3a", seal: "#c2386b", glyph: "✿" },
  { id: "night", name: "Midnight", tag: "Dark", paper: "#191730", flap: "#2a2750", ink: "#f0e6d0", seal: "#f6d44c", glyph: "☾" },
  { id: "mint", name: "Mint", tag: "Fresh", paper: "#cfeedd", flap: "#9bd8b8", ink: "#13392b", seal: "#2350d8", glyph: "❀" },
];

export const MAX_NOTE = 80;

export function styleOf(id: string | null | undefined): Style {
  return STYLES.find((s) => s.id === id) ?? STYLES[0]!;
}

/** Keep notes short and free of control characters; they end up in a URL and in a post. */
export function cleanNote(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NOTE);
}

export function withEnvelope(link: string, styleId: string, note: string): string {
  const q: string[] = [];
  if (styleId && styleId !== "air") q.push("e=" + encodeURIComponent(styleId));
  const n = cleanNote(note);
  if (n) q.push("m=" + encodeURIComponent(n));
  return q.length ? `${link}?${q.join("&")}` : link;
}

/** An envelope with its flap and seal. `note` is printed on the letter peeking out the top. */
export function envelope(style: Style, note: string, opts: { amount?: string; open?: boolean } = {}): HTMLElement {
  const el = h(
    "div",
    { class: "env" + (opts.open ? " open" : ""), style: `--paper:${style.paper};--flap:${style.flap};--eink:${style.ink};--seal:${style.seal}` },
    h("div", { class: "env-letter" }, h("span", null, note || (opts.amount ? `${opts.amount} for you` : "A little something for you"))),
    h("div", { class: "env-body" }),
    h("div", { class: "env-flap" }),
    h("div", { class: "env-seal" }, style.glyph),
    opts.amount ? h("div", { class: "env-amt" }, opts.amount) : null,
  );
  return el;
}
