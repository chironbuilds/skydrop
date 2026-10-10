/** Minimal CBOR encoder for template call arguments (the shapes BskyClaim takes). */
export type CborValue = null | number | bigint | string | Uint8Array | CborValue[];

function head(major: number, n: number | bigint, out: number[]): void {
  const v = BigInt(n);
  const m = major << 5;
  if (v < 24n) out.push(m | Number(v));
  else if (v < 0x100n) out.push(m | 24, Number(v));
  else if (v < 0x10000n) out.push(m | 25, Number(v >> 8n), Number(v & 0xffn));
  else if (v < 0x100000000n) out.push(m | 26, ...[24n, 16n, 8n, 0n].map((s) => Number((v >> s) & 0xffn)));
  else out.push(m | 27, ...[56n, 48n, 40n, 32n, 24n, 16n, 8n, 0n].map((s) => Number((v >> s) & 0xffn)));
}

function encodeInto(v: CborValue, out: number[]): void {
  if (v === null) out.push(0xf6);
  else if (typeof v === "number" || typeof v === "bigint") head(0, v, out);
  else if (typeof v === "string") {
    const b = new TextEncoder().encode(v);
    head(3, b.length, out);
    for (const x of b) out.push(x);
  } else if (v instanceof Uint8Array) {
    head(2, v.length, out);
    for (const x of v) out.push(x);
  } else {
    head(4, v.length, out);
    for (const item of v) encodeInto(item, out);
  }
}

export function cbor(v: CborValue): Uint8Array {
  const out: number[] = [];
  encodeInto(v, out);
  return Uint8Array.from(out);
}

export const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export const fromHex = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/** A transaction `Literal` argument: the CBOR of the value, hex encoded. */
export const lit = (v: CborValue): { Literal: string } => ({ Literal: toHex(cbor(v)) });
