import { h } from "./dom";
import type { Style } from "./envelope-data";
export * from "./envelope-data";

/**
 * A tall red-packet style envelope: a cover (a colour, or the sender's own picture) with a round seal, and the
 * note and amount waiting inside. Tapping it lifts the cover away.
 */
export function envelope(style: Style, note: string, opts: { amount?: string; open?: boolean; coverUrl?: string; onToggle?: () => void } = {}): HTMLElement {
  const cover = h("div", { class: "env-cover" });
  if (opts.coverUrl) {
    cover.style.backgroundImage = `url("${opts.coverUrl}")`;
    cover.classList.add("pic");
  }
  const el = h(
    "div",
    { class: "env" + (opts.open ? " open" : ""), style: `--paper:${style.paper};--flap:${style.flap};--eink:${style.ink};--seal:${style.seal}`, role: "img", "aria-label": "Gift envelope" },
    h("div", { class: "env-in" }, h("span", { class: "env-msg" }, note || "A little something for you"), opts.amount ? h("b", { class: "env-amt" }, opts.amount) : null),
    cover,
    h("div", { class: "env-seal" }, h("span", null, opts.coverUrl ? "福" : style.glyph)),
  );
  el.addEventListener("click", () => {
    el.classList.toggle("open");
    opts.onToggle?.();
  });
  return el;
}

/** Shrinks a picture to a tall cover and returns a small JPEG (the Worker accepts at most 90 KB). */
export async function prepareCover(file: File): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const W = 420;
  const H = 560;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  // cover-fit: fill the frame, crop what overflows
  const scale = Math.max(W / bmp.width, H / bmp.height);
  const w = bmp.width * scale;
  const hh = bmp.height * scale;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(bmp, (W - w) / 2, (H - hh) / 2, w, hh);
  for (const q of [0.88, 0.8, 0.72, 0.64, 0.55, 0.45, 0.35]) {
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", q));
    if (blob && blob.size <= 90_000) return blob;
  }
  throw new Error("That picture is too detailed to shrink enough. Try another one.");
}

/** Uploads a prepared cover and returns its id. */
export async function uploadCover(blob: Blob): Promise<string> {
  const r = await fetch("/cover", { method: "POST", headers: { "content-type": "image/jpeg" }, body: blob });
  if (!r.ok) throw new Error(r.status === 413 ? "That picture is too big." : "Couldn't upload the picture. Try again.");
  const { id } = (await r.json()) as { id: string };
  return id;
}

export const PRESETS = [
  { id: "lantern", name: "Lantern" },
  { id: "fireworks", name: "Fireworks" },
  { id: "coins", name: "Coins" },
  { id: "blossom", name: "Blossom" },
] as const;

/** Draws one of the built-in cover designs as a small JPEG, the same shape an uploaded picture is. */
export async function presetCover(id: string): Promise<Blob> {
  const W = 420;
  const H = 560;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const bg = (a: string, b: string) => {
    const gr = g.createLinearGradient(0, 0, 0, H);
    gr.addColorStop(0, a);
    gr.addColorStop(1, b);
    g.fillStyle = gr;
    g.fillRect(0, 0, W, H);
  };
  if (id === "lantern") {
    bg("#e0392b", "#a31f16");
    g.strokeStyle = "#f6d44c";
    g.lineWidth = 3;
    for (let i = 0; i < 4; i++) { g.beginPath(); g.arc(W / 2, 40 + i * 4, 120 + i * 40, 0.15 * Math.PI, 0.85 * Math.PI); g.globalAlpha = 0.2; g.stroke(); }
    g.globalAlpha = 1;
    g.fillStyle = "#f6d44c";
    g.fillRect(W / 2 - 3, 0, 6, 120);
    const grad = g.createRadialGradient(W / 2, 250, 20, W / 2, 250, 120);
    grad.addColorStop(0, "#ff6a4a");
    grad.addColorStop(1, "#c1241a");
    g.fillStyle = grad;
    g.beginPath(); g.ellipse(W / 2, 250, 105, 120, 0, 0, 2 * Math.PI); g.fill();
    g.strokeStyle = "#f6d44c"; g.lineWidth = 5; g.stroke();
    for (const dx of [-55, 0, 55]) { g.beginPath(); g.ellipse(W / 2 + dx * 0.0, 250, Math.abs(dx) || 8, 120, 0, 0, 2 * Math.PI); g.strokeStyle = "rgba(246,212,76,.7)"; g.lineWidth = 2.5; g.stroke(); }
    g.fillStyle = "#f6d44c"; g.fillRect(W / 2 - 40, 120, 80, 14); g.fillRect(W / 2 - 40, 366, 80, 14);
    g.strokeStyle = "#f6d44c"; g.lineWidth = 4;
    for (let i = -3; i <= 3; i++) { g.beginPath(); g.moveTo(W / 2 + i * 9, 380); g.lineTo(W / 2 + i * 12, 440); g.stroke(); }
  } else if (id === "fireworks") {
    bg("#10123a", "#2a1b5e");
    const cols = ["#f6d44c", "#ff6a4a", "#7fd1ff", "#ff7ad9", "#9dff8a"];
    for (let k = 0; k < 6; k++) {
      const cx = 60 + rnd() * (W - 120), cy = 60 + rnd() * 300, r = 40 + rnd() * 60, col = cols[k % cols.length]!;
      g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 3; g.lineCap = "round";
      for (let a = 0; a < 20; a++) {
        const t = (a / 20) * Math.PI * 2;
        g.beginPath(); g.moveTo(cx + Math.cos(t) * r * 0.35, cy + Math.sin(t) * r * 0.35); g.lineTo(cx + Math.cos(t) * r, cy + Math.sin(t) * r); g.stroke();
        g.beginPath(); g.arc(cx + Math.cos(t) * r * 1.12, cy + Math.sin(t) * r * 1.12, 3, 0, 7); g.fill();
      }
    }
    g.fillStyle = "#fff";
    for (let i = 0; i < 60; i++) { g.globalAlpha = 0.3 + rnd() * 0.6; g.fillRect(rnd() * W, rnd() * H, 2, 2); }
    g.globalAlpha = 1;
  } else if (id === "coins") {
    bg("#f6d44c", "#e0a81f");
    for (let k = 0; k < 26; k++) {
      const x = rnd() * W, y = rnd() * H * 0.95, r = 22 + rnd() * 26;
      g.fillStyle = "#f9e48a"; g.strokeStyle = "#a97a10"; g.lineWidth = 3;
      g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); g.stroke();
      g.strokeStyle = "rgba(169,122,16,.7)"; g.lineWidth = 2;
      g.strokeRect(x - r * 0.3, y - r * 0.3, r * 0.6, r * 0.6);
    }
  } else {
    bg("#fbd5df", "#f4a9bd");
    for (let k = 0; k < 16; k++) {
      const x = rnd() * W, y = rnd() * H * 0.95, r = 18 + rnd() * 22, rot = rnd() * 6;
      for (let p = 0; p < 5; p++) {
        const a = rot + (p / 5) * Math.PI * 2;
        g.fillStyle = k % 3 ? "#fff3f6" : "#ffd0dc";
        g.strokeStyle = "rgba(194,56,107,.55)"; g.lineWidth = 2;
        g.beginPath(); g.ellipse(x + Math.cos(a) * r, y + Math.sin(a) * r, r * 0.8, r * 0.55, a, 0, 7); g.fill(); g.stroke();
      }
      g.fillStyle = "#f6d44c"; g.beginPath(); g.arc(x, y, r * 0.35, 0, 7); g.fill();
    }
  }
  const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/jpeg", 0.85));
  if (!blob) throw new Error("Couldn't draw that design.");
  return blob;
}
