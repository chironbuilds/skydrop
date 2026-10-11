import { h } from "./dom";
import type { Style } from "./envelope-data";
export * from "./envelope-data";

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
