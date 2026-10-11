type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown> & { class?: string; style?: string };

/** Tiny hyperscript: h("div", {class: "x", onclick: fn}, "text", child). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === "class") el.className = String(v);
    else if (k === "style") el.setAttribute("style", String(v));
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
  }
}

export const mount = (root: HTMLElement, ...children: Child[]): void => {
  root.replaceChildren();
  append(root, children);
};

const svg = (inner: string, size = 24): SVGElement => {
  const w = document.createElement("div");
  w.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  return w.firstElementChild as SVGElement;
};

export const icons = {
  drop: (s = 20) => svg('<path d="M12 3c3.600 4.400 6 7.200 6 10.200a6 6 0 0 1-12 0C6 10.200 8.400 7.400 12 3z" fill="currentColor" stroke="none"/>', s),
  send: (s = 24) => svg('<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/>', s),
  gift: (s = 24) => svg('<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13"/><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.500 8a2.500 2.500 0 0 1 0-5C11 3 12 8 12 8s1-5 4.500-5a2.500 2.500 0 0 1 0 5"/>', s),
  shield: (s = 24) => svg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>', s),
  check: (s = 18) => svg('<path d="M20 6 9 17l-5-5"/>', s),
  copy: (s = 16) => svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>', s),
  external: (s = 16) => svg('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/>', s),
  wallet: (s = 18) => svg('<path d="M20 12V8H6a2 2 0 0 1 0-4h12v4"/><path d="M4 6v12a2 2 0 0 0 2 2h14v-4"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>', s),
  close: (s = 20) => svg('<path d="M18 6 6 18M6 6l12 12"/>', s),
};

/** The hero postage stamp (a parcel under a parachute) with a postmark across its corner. */
export function stamp(): HTMLElement {
  const w = document.createElement("div");
  w.className = "stamp-wrap";
  w.setAttribute("aria-hidden", "true");
  w.innerHTML = `
<div class="stamp"><svg viewBox="0 0 144 192" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="sk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8fb5ff"/><stop offset="1" stop-color="#e3eeff"/></linearGradient></defs>
  <rect width="144" height="192" fill="url(#sk)"/>
  <g fill="#fffaf0" opacity=".95"><ellipse cx="26" cy="160" rx="30" ry="9"/><ellipse cx="48" cy="166" rx="26" ry="8"/><ellipse cx="116" cy="150" rx="28" ry="8"/><ellipse cx="132" cy="157" rx="22" ry="7"/></g>
  <g stroke="#191730" stroke-width="1.6" fill="none"><path d="M20 80 L72 132"/><path d="M52 84 L72 132"/><path d="M92 84 L72 132"/><path d="M124 80 L72 132"/></g>
  <path d="M16 82 Q72 -14 128 82 Q110 96 92 84 Q72 98 52 84 Q34 96 16 82Z" fill="#d9362b" stroke="#191730" stroke-width="2.2" stroke-linejoin="round"/>
  <path d="M52 84 Q58 34 72 6 Q86 34 92 84 Q72 96 52 84Z" fill="#fff4dc" stroke="#191730" stroke-width="2.2" stroke-linejoin="round"/>
  <rect x="52" y="130" width="40" height="32" fill="#d9a566" stroke="#191730" stroke-width="2.2"/>
  <rect x="68" y="130" width="8" height="32" fill="#f6d44c" stroke="#191730" stroke-width="1.6"/>
  <text x="9" y="17" font-family="DM Mono, monospace" font-size="8" letter-spacing="2" fill="#191730">SKYDROP</text>
  <text x="9" y="184" font-family="Fraunces, Georgia, serif" font-weight="800" font-size="17" fill="#191730">1 tTARI</text>
</svg></div>
<svg class="postmark" viewBox="0 0 118 96" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="#d9362b" stroke-width="2.4">
  <defs><path id="pm" d="M70 48 m-30 0 a30 30 0 1 1 60 0 a30 30 0 1 1 -60 0"/></defs>
  <circle cx="70" cy="48" r="40"/><circle cx="70" cy="48" r="22" stroke-width="1.4"/>
  <text font-family="DM Mono, monospace" font-size="9.5" letter-spacing="2.2" fill="#d9362b" stroke="none"><textPath href="#pm">SKYDROP · TESTNET · BSKY ·</textPath></text>
  <path d="M0 30 q8 -7 16 0 t16 0 t16 0"/><path d="M0 46 q8 -7 16 0 t16 0 t16 0"/><path d="M0 62 q8 -7 16 0 t16 0 t16 0"/>
</svg>`;
  return w;
}

export function toast(message: string, kind: "good" | "bad" | "" = ""): void {
  const box = document.getElementById("toasts")!;
  const t = h("div", { class: `toast ${kind}`, role: "status" }, message);
  box.appendChild(t);
  setTimeout(() => t.remove(), kind === "bad" ? 7000 : 4000);
}

export async function copy(text: string, label = "Copied"): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(label, "good");
  } catch {
    toast("Couldn't copy. Select the text and copy it by hand.", "bad");
  }
}

export const short = (s: string, a = 10, b = 6): string => (s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s);

export function spinnerLabel(text: string): HTMLElement[] {
  return [h("span", { class: "spin" }), h("span", null, text)];
}

export function confetti(): void {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const canvas = document.getElementById("confetti") as HTMLCanvasElement;
  const ctx = canvas.getContext("2d")!;
  const dpr = devicePixelRatio || 1;
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  ctx.scale(dpr, dpr);
  const colors = ["#d9362b", "#2350d8", "#f6d44c", "#fffaf0", "#191730"];
  const parts = Array.from({ length: 140 }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 120,
    y: innerHeight * 0.45,
    vx: (Math.random() - 0.5) * 16,
    vy: -Math.random() * 15 - 4,
    r: Math.random() * 6 + 3,
    c: colors[Math.floor(Math.random() * colors.length)]!,
    a: Math.random() * Math.PI,
  }));
  let frames = 0;
  const tick = (): void => {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of parts) {
      p.vy += 0.38;
      p.x += p.vx;
      p.y += p.vy;
      p.a += 0.2;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.a);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.r / 2, -p.r / 2, p.r, p.r * 0.6);
      ctx.restore();
    }
    if (++frames < 150) requestAnimationFrame(tick);
    else ctx.clearRect(0, 0, innerWidth, innerHeight);
  };
  tick();
}
