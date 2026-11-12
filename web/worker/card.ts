// The gift link's preview card (the picture Bluesky and Telegram show). Pure: no KV, no WASM, so it can be tested.
import { esc, wrap } from "./share";
import { effectiveStyle, noteFont, patternTile, type Extras, type Style } from "../src/envelope-data";

/** The preview card: the tall envelope on the left (with the sender's picture as its cover, if any), the words on the right. */
export function card(base: Style, handle: string, note: string, amount: string, cover: string, extras: Extras = {}): { svg: string; text: string; fonts: { family: string; weight: number; text: string }[] } {
  const style = effectiveStyle(base, extras);
  const nf = noteFont(extras.f);
  const lines = wrap(note || (amount ? `${amount} for you` : "A little something for you"), nf === "Caveat" ? 54 : 46, 560);
  const who = handle ? `@${handle}` : "";
  const head = who ? `a gift for ${who}` : "a gift on Tari";
  const seal = extras.g || (cover ? "福" : style.glyph);
  const text = [...lines, amount, head, "Skydrop", "skydrop.tari.mw", seal].join("");
  // DM Mono has no bold, so the typewriter note uses its 500 weight.
  const noteWeight = nf === "DM Mono" ? 500 : 700;
  const fonts = nf === "Fraunces" ? [] : [{ family: nf, weight: noteWeight, text: lines.join("") }];
  const tile = cover ? null : patternTile(style.pattern, style.ink);
  const patDef = tile ? `<pattern id="pt" width="${tile.w}" height="${tile.h}" patternUnits="userSpaceOnUse">${tile.body}</pattern>` : "";
  const stripe = `<pattern id="s" width="40" height="40" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><rect width="20" height="40" fill="#d9362b"/><rect x="20" width="20" height="40" fill="#2350d8"/></pattern>`;
  // envelope: x 130..440, y 60..570. The cover covers the top 78% and its bottom edge bulges down in the middle.
  const x0 = 130, x1 = 440, y0 = 60, y1 = 570, cx = (x0 + x1) / 2;
  const cb = y0 + (y1 - y0) * 0.78;
  const bulge = 34;
  const coverPath = `M${x0},${y0 + 18} Q${x0},${y0} ${x0 + 18},${y0} L${x1 - 18},${y0} Q${x1},${y0} ${x1},${y0 + 18} L${x1},${cb - 12} Q${x1},${cb} ${cx},${cb + bulge} Q${x0},${cb} ${x0},${cb - 12} Z`;
  const pic = cover
    ? `<clipPath id="cv"><path d="${coverPath}"/></clipPath><image href="__COVER__" x="${x0}" y="${y0}" width="${x1 - x0}" height="${cb + bulge - y0}" preserveAspectRatio="xMidYMid slice" clip-path="url(#cv)"/>`
    : `<path d="${coverPath}" fill="${style.paper}"/>${tile ? `<path d="${coverPath}" fill="url(#pt)"/>` : ""}<rect x="${x0 + 18}" y="${y0 + 18}" width="${x1 - x0 - 36}" height="${cb - y0 - 40}" rx="10" fill="none" stroke="${style.ink}" stroke-opacity=".35" stroke-width="3"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><defs>${stripe}${patDef}</defs>
<rect width="1200" height="630" fill="#f0e6d0"/>
<rect width="1200" height="14" fill="url(#s)"/><rect y="616" width="1200" height="14" fill="url(#s)"/>
<rect x="${x0 + 8}" y="${y0 + 8}" width="${x1 - x0}" height="${y1 - y0}" rx="20" fill="#191730"/>
<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" rx="20" fill="${style.paper}" stroke="#191730" stroke-width="5"/>
${pic}
<path d="${coverPath}" fill="none" stroke="#191730" stroke-width="5"/>
<circle cx="${cx}" cy="${cb + bulge - 6}" r="44" fill="#e9cf9b" stroke="#191730" stroke-opacity=".35" stroke-width="3"/>
<text x="${cx}" y="${cb + bulge + 8}" text-anchor="middle" font-family="Noto Sans SC, Noto Emoji" font-weight="700" font-size="38" fill="#a98b4d">${esc(seal)}</text>
<text x="540" y="120" font-family="Fraunces" font-weight="700" font-size="40" fill="#191730">Skydrop</text>
<text x="540" y="168" font-family="Fraunces" font-weight="700" font-size="28" fill="#857e96">${esc(head)}</text>
${lines.map((l, i) => `<text x="540" y="${290 + i * 58}" font-family="${nf}, Noto Sans SC, Noto Emoji" font-weight="${noteWeight}" font-size="${nf === "Caveat" ? 56 : nf === "DM Mono" ? 38 : 46}" fill="#191730">${esc(l)}</text>`).join("")}
${amount ? `<text x="540" y="${290 + lines.length * 58 + 30}" font-family="Fraunces" font-weight="700" font-size="40" fill="#d9362b">${esc(amount)}</text>` : ""}
<text x="540" y="580" font-family="Fraunces" font-weight="700" font-size="26" fill="#857e96">skydrop.tari.mw</text>
</svg>`;
  return { svg, text, fonts };
}
