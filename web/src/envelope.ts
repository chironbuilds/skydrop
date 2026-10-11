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
    h("div", { class: "env-seal" }, h("span", null, style.glyph)),
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
