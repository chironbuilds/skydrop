/** Each campaign gets its own constellation, drawn from a hash of its terms: one star per step, joined in order. */
import type { Rule } from "./campaign";
import { groupsOf, PALETTE } from "./campaign";

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
  const hue = seed % 360;
  const hue2 = (hue + 40 + Math.floor(rand() * 90)) % 360;
  const id = `q${seed.toString(36)}`;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "questart", "aria-hidden": "true", preserveAspectRatio: "xMidYMid slice" }) as SVGSVGElement;
  const defs = el("defs", {});
  const grad = el("linearGradient", { id, x1: 0, y1: 0, x2: 1, y2: 1 });
  grad.appendChild(el("stop", { offset: 0, "stop-color": `hsl(${hue} 62% 22%)` }));
  grad.appendChild(el("stop", { offset: 1, "stop-color": `hsl(${hue2} 68% 12%)` }));
  defs.appendChild(grad);
  svg.appendChild(defs);
  svg.appendChild(el("rect", { width: W, height: H, fill: `url(#${id})` }));
  for (let i = 0; i < 46; i++) {
    svg.appendChild(el("circle", { cx: (rand() * W).toFixed(1), cy: (rand() * H).toFixed(1), r: (rand() * 1.1 + 0.25).toFixed(2), fill: "#fff", opacity: (rand() * 0.5 + 0.12).toFixed(2) }));
  }

  const n = Math.max(rules.length, 1);
  const pts = Array.from({ length: n }, (_, i) => ({
    x: n === 1 ? W / 2 : 38 + ((W - 76) * i) / (n - 1),
    y: 32 + rand() * (H - 64),
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
    if (done) svg.appendChild(el("circle", { cx: p.x, cy: p.y, r: 19, fill: `hsl(${hue2} 90% 70%)`, opacity: 0.28 }));
    svg.appendChild(el("circle", { cx: p.x, cy: p.y, r: 13.5, fill: done ? "#fff" : "rgba(255,255,255,.14)", stroke: "#fff", "stroke-opacity": 0.75, "stroke-width": 1.2 }));
    const icon = rule ? PALETTE.find((q) => q.kind === rule.kind)?.icon ?? "•" : "+";
    svg.appendChild(el("text", { x: p.x, y: p.y + 4.6, "text-anchor": "middle", "font-size": 13, "font-family": "system-ui, sans-serif", fill: done ? `hsl(${hue} 60% 22%)` : "#fff" }, icon));
  });
  return svg;
}
