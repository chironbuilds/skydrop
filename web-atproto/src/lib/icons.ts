/** One drawn icon for each kind of step, so a step looks the same wherever it appears. Built without parsing any HTML. */
const NS = "http://www.w3.org/2000/svg";

/** Paths in a 24 by 24 box, stroked. */
export const RULE_PATHS: Record<number, string[]> = {
  0: ["M12 20.5s-7.5-4.6-9-9.6C2 7.200 4.500 4.500 7.500 4.500c1.900 0 3.500 1 4.500 2.700 1-1.700 2.600-2.700 4.500-2.700 3 0 5.500 2.700 4.500 6.400-1.500 5-9 9.600-9 9.600z"],
  1: ["M17 2.500l3.500 3.500L17 9.500", "M3.500 11V9.500A3.500 3.500 0 0 1 7 6h13.500", "M7 21.500L3.500 18 7 14.500", "M20.500 13v1.500A3.500 3.500 0 0 1 17 18H3.500"],
  2: ["M15.500 20v-1.500a4 4 0 0 0-4-4h-5a4 4 0 0 0-4 4V20", "M9 11a3.700 3.700 0 1 0 0-7.400A3.700 3.700 0 0 0 9 11z", "M19 8v6", "M16 11h6"],
  3: ["M4.500 9h15", "M4.500 15h15", "M10 3.500L8 20.500", "M16 3.500l-2 17"],
  4: ["M21 11.500a8.300 8.300 0 0 1-8.500 8.300 8.800 8.800 0 0 1-3.600-.8L3.500 20.500l1.500-4.800a8 8 0 0 1-1.100-4.200A8.300 8.300 0 0 1 12.400 3.200 8.300 8.300 0 0 1 21 11.500z"],
  5: ["M10 7H5.500A1.500 1.500 0 0 0 4 8.500V13a1.500 1.500 0 0 0 1.500 1.500H8c0 2-1 3.500-3 4.500", "M20 7h-4.500A1.500 1.500 0 0 0 14 8.500V13a1.500 1.500 0 0 0 1.500 1.500H18c0 2-1 3.500-3 4.500"],
  6: ["M8.500 6.500H21", "M8.500 12H21", "M8.500 17.500H21", "M3.500 6.500h.01", "M3.500 12h.01", "M3.500 17.500h.01"],
  7: ["M16 20v-1.500a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20", "M9.500 11a3.700 3.700 0 1 0 0-7.400 3.700 3.700 0 0 0 0 7.400z", "M22 11h-6", "M18.500 8L15.500 11l3 3"],
  8: ["M12 21.500s8-4 8-10V5.200L12 2.500 4 5.200v6.300c0 6 8 10 8 10z", "M8.800 11.800l2.300 2.300 4.200-4.300"],
};

function svgEl(tag: string, attrs: Record<string, string | number>): SVGElement {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

/** A step's icon as a standalone picture. */
export function ruleIcon(kind: number, size = 18): SVGSVGElement {
  const s = svgEl("svg", { viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", class: "ruleicon" }) as SVGSVGElement;
  for (const d of RULE_PATHS[kind] ?? RULE_PATHS[8]!) s.appendChild(svgEl("path", { d }));
  return s;
}

/** A step's icon inside another drawing, centred on a point. */
export function ruleGlyph(kind: number, x: number, y: number, size: number, color: string): SVGElement {
  const g = svgEl("g", { transform: `translate(${x - size / 2} ${y - size / 2}) scale(${size / 24})`, fill: "none", stroke: color, "stroke-width": 2.2, "stroke-linecap": "round", "stroke-linejoin": "round" });
  for (const d of RULE_PATHS[kind] ?? RULE_PATHS[8]!) g.appendChild(svgEl("path", { d }));
  return g;
}

/** Skydrop's parcel under a parachute, for decoration. */
export function parachute(size = 150): SVGSVGElement {
  const s = svgEl("svg", { viewBox: "0 0 144 172", width: size, height: Math.round((size * 172) / 144), "aria-hidden": "true", class: "chute" }) as SVGSVGElement;
  const ink = "#191730";
  for (const d of ["M20 80 L72 132", "M52 84 L72 132", "M92 84 L72 132", "M124 80 L72 132"]) s.appendChild(svgEl("path", { d, stroke: ink, "stroke-width": 1.6, fill: "none" }));
  s.appendChild(svgEl("path", { d: "M16 82 Q72 -14 128 82 Q110 96 92 84 Q72 98 52 84 Q34 96 16 82Z", fill: "#d9362b", stroke: ink, "stroke-width": 2.2, "stroke-linejoin": "round" }));
  s.appendChild(svgEl("path", { d: "M52 84 Q58 34 72 6 Q86 34 92 84 Q72 96 52 84Z", fill: "#fff4dc", stroke: ink, "stroke-width": 2.2, "stroke-linejoin": "round" }));
  s.appendChild(svgEl("rect", { x: 52, y: 130, width: 40, height: 32, fill: "#d9a566", stroke: ink, "stroke-width": 2.2 }));
  s.appendChild(svgEl("rect", { x: 68, y: 130, width: 8, height: 32, fill: "#f6d44c", stroke: ink, "stroke-width": 1.6 }));
  return s;
}
