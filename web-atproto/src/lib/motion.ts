/**
 * The moving parts both sites share. All of it is decoration: nothing here carries information that isn't already on the
 * page, and someone who asked for reduced motion gets none of it.
 */
import "./motion.css";

export const calm = (): boolean => matchMedia("(prefers-reduced-motion: reduce)").matches;

const onceSeen = new Set<string>();
/** True the first time a key is asked about. Pages redraw often, and an entrance should only play once. */
export function once(key: string): boolean {
  if (onceSeen.has(key)) return false;
  onceSeen.add(key);
  return true;
}

// ---- things arriving on the page -------------------------------------------------------------------------------

const REVEAL = ".card, .quick, .qopen, .qcard, .qtile, .qempty, .qarrive, .chain .link, .node, .stepcard, .action, .howstep, .step";

/** What makes two renders of the same thing the same, so a redraw isn't mistaken for something new. */
function revealKey(el: Element): string {
  if (el.id) return `#${el.id}`;
  const label = el.querySelector("h3, h2, strong, span")?.textContent ?? el.textContent ?? "";
  return `${el.className.split(" ")[0]}|${label.slice(0, 60)}`;
}

/**
 * Fades cards in as they scroll into view. They're only ever hidden once this knows how to show them, and a timer shows
 * anything the observer missed, so nothing can stay invisible.
 */
export function initMotion(root: Element = document.body): void {
  if (calm() || typeof IntersectionObserver === "undefined" || typeof MutationObserver === "undefined") return;
  const show = (el: Element, delay = 0): void => {
    const e = el as HTMLElement;
    e.style.setProperty("--rv-delay", `${delay}ms`);
    e.classList.remove("rv-wait");
    e.classList.add("rv-in");
    e.addEventListener("animationend", () => e.classList.remove("rv-in"), { once: true });
    window.setTimeout(() => e.classList.remove("rv-in"), delay + 1200);
  };
  const io = new IntersectionObserver((entries) => {
    let i = 0;
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      io.unobserve(entry.target);
      show(entry.target, Math.min(i++, 8) * 45);
    }
  }, { rootMargin: "0px 0px -6% 0px" });
  const consider = (el: Element): void => {
    if (!once(revealKey(el))) return;
    el.classList.add("rv-wait");
    io.observe(el);
    window.setTimeout(() => {
      if (!el.classList.contains("rv-wait")) return;
      const r = el.getBoundingClientRect();
      if (r.top < innerHeight && r.bottom > 0) show(el);
    }, 1400);
  };
  const scan = (node: Node): void => {
    if (!(node instanceof Element)) return;
    if (node.matches(REVEAL)) consider(node);
    node.querySelectorAll(REVEAL).forEach(consider);
  };
  scan(root);
  new MutationObserver((records) => records.forEach((r) => r.addedNodes.forEach(scan))).observe(root, { childList: true, subtree: true });
  initPointer();
}

// ---- things under the pointer ------------------------------------------------------------------------------------

const TILT = ".qopen, a.card, .quick, .qtile, .stamp-wrap";

/** Cards lean slightly towards the pointer and carry a soft light under it. Only where there's a real pointer. */
function initPointer(): void {
  if (!matchMedia("(hover: hover) and (pointer: fine)").matches) return;
  let active: HTMLElement | null = null;
  const clear = (): void => {
    if (!active) return;
    active.classList.remove("tilting");
    active.style.removeProperty("--rx");
    active.style.removeProperty("--ry");
    active = null;
  };
  document.addEventListener("pointermove", (e) => {
    const el = (e.target as Element).closest?.(TILT) as HTMLElement | null;
    if (el !== active) clear();
    if (!el) return;
    active = el;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    el.style.setProperty("--mx", `${(x * 100).toFixed(1)}%`);
    el.style.setProperty("--my", `${(y * 100).toFixed(1)}%`);
    el.style.setProperty("--rx", `${((0.5 - y) * 3).toFixed(2)}deg`);
    el.style.setProperty("--ry", `${((x - 0.5) * 3).toFixed(2)}deg`);
    el.classList.add("tilting");
  }, { passive: true });
  document.addEventListener("pointerleave", clear);
}

// ---- numbers ---------------------------------------------------------------------------------------------------------

const shown = new Map<string, number>();

/**
 * Runs a figure up to its new value. The exact text always lands at the end, and on a redraw it picks up from wherever
 * the last one had reached. Anything that isn't a plain figure is left alone.
 */
export function countUp(el: HTMLElement, key: string): void {
  const text = el.textContent ?? "";
  const m = /^([\d,]+(?:\.(\d+))?)(.*)$/.exec(text);
  if (!m) return;
  const to = Number(m[1]!.replace(/,/g, ""));
  if (!Number.isFinite(to)) return;
  const from = shown.get(key) ?? 0;
  shown.set(key, to);
  // Only good news runs up. A total that fell, because a campaign was removed, just shows its new value.
  if (to <= from || calm()) return;
  const places = m[2]?.length ?? 0;
  const tail = m[3] ?? "";
  const started = performance.now();
  el.classList.add("counting");
  const step = (now: number): void => {
    if (!el.isConnected) return;
    const t = Math.min(1, (now - started) / 650);
    if (t >= 1) {
      el.textContent = text;
      el.classList.remove("counting");
      return;
    }
    const value = from + (to - from) * (1 - (1 - t) ** 3);
    shown.set(key, value);
    el.textContent = `${value.toLocaleString("en-US", { minimumFractionDigits: places, maximumFractionDigits: places })}${tail}`;
    requestAnimationFrame(step);
  };
  shown.set(key, from);
  requestAnimationFrame(step);
  // A frame can be held back in a hidden tab, so the final figure doesn't depend on one arriving.
  window.setTimeout(() => {
    shown.set(key, to);
    if (el.isConnected) {
      el.textContent = text;
      el.classList.remove("counting");
    }
  }, 900);
}

// ---- celebrating -----------------------------------------------------------------------------------------------------

const COLORS = ["#d9362b", "#2350d8", "#f6d44c", "#15714a", "#fffaf0"];

/** Airmail confetti and a falling coin, from wherever the good news happened. */
export function celebrate(from?: Element | null): void {
  if (calm()) return;
  const r = from?.isConnected ? from.getBoundingClientRect() : null;
  const x = r ? r.left + r.width / 2 : innerWidth / 2;
  const y = r ? r.top + r.height / 2 : innerHeight / 3;
  const layer = document.createElement("div");
  layer.className = "burst";
  layer.setAttribute("aria-hidden", "true");
  document.body.appendChild(layer);
  for (let i = 0; i < 34; i++) {
    const bit = document.createElement("i");
    const coin = i % 7 === 0;
    bit.className = coin ? "bit coin" : "bit";
    if (!coin) bit.style.background = COLORS[i % COLORS.length]!;
    layer.appendChild(bit);
    const angle = Math.random() * Math.PI * 2;
    const reach = 90 + Math.random() * 190;
    const dx = Math.cos(angle) * reach;
    const dy = Math.sin(angle) * reach * 0.8 - 70;
    const turn = (Math.random() - 0.5) * 900;
    bit.animate(
      [
        { transform: `translate(${x}px, ${y}px) rotate(0deg) scale(.4)`, opacity: 1 },
        { transform: `translate(${x + dx}px, ${y + dy}px) rotate(${turn / 2}deg) scale(1)`, opacity: 1, offset: 0.45 },
        { transform: `translate(${x + dx * 1.2}px, ${y + dy + 260 + Math.random() * 120}px) rotate(${turn}deg) scale(.8)`, opacity: 0 },
      ],
      { duration: 1100 + Math.random() * 500, easing: "cubic-bezier(.16,.84,.44,1)", fill: "forwards" },
    );
  }
  window.setTimeout(() => layer.remove(), 1800);
}

// ---- moving between pages --------------------------------------------------------------------------------------------

type Transitioning = Document & { startViewTransition?: (fn: () => void) => { finished: Promise<void>; ready: Promise<void> } };

/** Runs a page change as a soft cross-fade, where the browser can. The change itself always happens. */
export function pageChange(paint: () => void): void {
  const d = document as Transitioning;
  if (!d.startViewTransition || calm() || document.hidden) {
    paint();
    return;
  }
  d.startViewTransition(paint).finished.catch(() => {});
}

/** Swaps the theme with a circle opening out from the button that was pressed. */
export function themeChange(from: Element, change: () => void): void {
  const d = document as Transitioning;
  if (!d.startViewTransition || calm() || document.hidden) {
    change();
    return;
  }
  const r = from.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const root = document.documentElement;
  root.classList.add("theme-swap");
  const t = d.startViewTransition(change);
  t.ready.then(() => {
    root.animate({ clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] }, { duration: 460, easing: "cubic-bezier(.4,0,.2,1)", pseudoElement: "::view-transition-new(root)" } as KeyframeAnimationOptions);
  }).catch(() => {});
  t.finished.catch(() => {}).finally(() => root.classList.remove("theme-swap"));
}

/** A placeholder for something still loading, shaped like what's coming. */
export function skeleton(count = 2, className = "skel"): HTMLElement {
  const box = document.createElement("div");
  box.className = "skelgrid";
  box.setAttribute("aria-hidden", "true");
  for (let i = 0; i < count; i++) {
    const c = document.createElement("div");
    c.className = className;
    c.append(...["skel-art", "skel-line wide", "skel-line", "skel-line short"].map((k) => {
      const l = document.createElement("i");
      l.className = k;
      return l;
    }));
    box.appendChild(c);
  }
  return box;
}
