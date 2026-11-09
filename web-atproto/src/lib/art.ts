/** Each campaign gets its own constellation, drawn from a hash of its terms: one star per step, joined in order. */
import type { Rule } from "./campaign";
import { fromMicro, groupsOf } from "./campaign";
import { h } from "./dom";
import { ruleGlyph, ruleIcon } from "./icons";

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed: number): () => number {
  let x = seed || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
}

const NS = "http://www.w3.org/2000/svg";
function el(tag: string, attrs: Record<string, string | number>, text?: string): SVGElement {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text) e.textContent = text;
  return e;
}

/** `lit` marks steps already done, for showing progress on a claim page. */
export function questArt(name: string, rules: Rule[], lit: boolean[] = []): SVGSVGElement {
  const seedText = `${name}|${rules.map((r) => `${r.kind}:${r.target}`).join("|")}`;
  const seed = hash(seedText);
  const rand = rng(seed);
  const W = 360;
  const H = 150;
  // Night-sky colours only. Across the whole wheel, some campaigns came out a muddy brown.
  const SKIES = [195, 210, 225, 240, 255, 270, 285, 300, 320, 175];
  const pick = seed % SKIES.length;
  const hue = SKIES[pick]!;
  const hue2 = SKIES[(pick + 1 + (seed >>> 8) % 3) % SKIES.length]!;
  const id = `q${seed.toString(36)}`;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "questart", "aria-hidden": "true", preserveAspectRatio: "xMidYMid slice" }) as SVGSVGElement;
  const defs = el("defs", {});
  const grad = el("linearGradient", { id, x1: 0, y1: 0, x2: 1, y2: 1 });
  grad.appendChild(el("stop", { offset: 0, "stop-color": `hsl(${hue} 62% 22%)` }));
  grad.appendChild(el("stop", { offset: 1, "stop-color": `hsl(${hue2} 68% 12%)` }));
  defs.appendChild(grad);
  svg.appendChild(defs);
  const glow = el("radialGradient", { id: `${id}g` });
  glow.appendChild(el("stop", { offset: 0, "stop-color": `hsl(${hue2} 90% 66%)`, "stop-opacity": 0.55 }));
  glow.appendChild(el("stop", { offset: 1, "stop-color": `hsl(${hue2} 90% 66%)`, "stop-opacity": 0 }));
  defs.appendChild(glow);
  svg.appendChild(el("rect", { width: W, height: H, fill: `url(#${id})` }));
  svg.appendChild(el("circle", { cx: 40 + rand() * (W - 80), cy: rand() * H, r: 90 + rand() * 50, fill: `url(#${id}g)` }));
  svg.appendChild(el("circle", { cx: rand() * W, cy: rand() * H, r: 50 + rand() * 40, fill: `url(#${id}g)`, opacity: 0.6 }));
  for (let i = 0; i < 46; i++) {
    const star = el("circle", { cx: (rand() * W).toFixed(1), cy: (rand() * H).toFixed(1), r: (rand() * 1.1 + 0.25).toFixed(2), fill: "#fff", opacity: (rand() * 0.5 + 0.12).toFixed(2) });
    if (i % 5 === 0) {
      star.setAttribute("class", "tw");
      star.setAttribute("style", `animation-delay:${(rand() * 3.6).toFixed(2)}s`);
    }
    svg.appendChild(star);
  }

  const n = Math.max(rules.length, 1);
  const pts = Array.from({ length: n }, (_, i) => ({
    x: n === 1 ? W / 2 : 38 + ((W - 76) * i) / (n - 1),
    // Kept to the middle band: a wide, short card crops this picture's top and bottom.
    y: 58 + rand() * 34,
  }));
  const groups = groupsOf(rules);
  for (let i = 1; i < n; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const either = groups[i] !== 0 && groups[i] === groups[i - 1];
    svg.appendChild(el("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: "#fff", "stroke-opacity": lit[i - 1] && lit[i] ? 0.85 : 0.35, "stroke-width": 1.4, "stroke-dasharray": either ? "3 4" : "none" }));
  }
  pts.forEach((p, i) => {
    const rule = rules[i];
    const done = lit[i];
    if (done) svg.appendChild(el("circle", { class: "halo", cx: p.x, cy: p.y, r: 19, fill: `hsl(${hue2} 90% 70%)`, opacity: 0.28 }));
    svg.appendChild(el("circle", { cx: p.x, cy: p.y, r: 13.5, fill: done ? "#fff" : "rgba(255,255,255,.14)", stroke: "#fff", "stroke-opacity": 0.75, "stroke-width": 1.2 }));
    svg.appendChild(rule ? ruleGlyph(rule.kind, p.x, p.y, 15, done ? `hsl(${hue} 60% 22%)` : "#fff") : el("text", { x: p.x, y: p.y + 4.6, "text-anchor": "middle", "font-size": 13, "font-family": "system-ui, sans-serif", fill: "#fff" }, "+"));
  });
  return svg;
}

/** The kinds of step a campaign asks for, as icons. Either/or steps are marked, and the names are there for screen readers. */
export function ruleChips(rules: Rule[], names: (r: Rule) => string): HTMLElement {
  const groups = groupsOf(rules);
  return h("ul", { class: "rulechips" }, rules.slice(0, 8).map((r, i) => {
    const either = groups[i] !== 0 && (groups[i] === groups[i - 1] || groups[i] === groups[i + 1]);
    return h("li", { class: `rulechip${either ? " or" : ""}`, title: names(r) }, ruleIcon(r.kind, 16), h("span", { class: "vh" }, names(r)));
  }));
}

/** How much of a pool has been paid out. */
export function poolBar(paid: bigint, left: bigint, unit: string, animate: boolean): HTMLElement {
  const all = paid + left;
  const part = all > 0n ? Number((paid * 1000n) / all) / 10 : 0;
  return h("div", { class: "poolbar" },
    h("div", { role: "img", "aria-label": `${part}% of the pool paid out` }, h("i", { class: animate ? "fill" : null, style: `width:${part}%` })),
    h("span", null, `${part}% of the ${fromMicro(all)} ${unit} pool paid out`),
  );
}
