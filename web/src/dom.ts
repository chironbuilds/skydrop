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
  const colors = ["#1185fe", "#8b5cf6", "#34d399", "#fbbf24", "#f472b6"];
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
