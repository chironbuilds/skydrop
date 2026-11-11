/**
 * Recording an account's identity chain in the ChainBook (the v2 contracts read keys from it).
 *
 * The book checks each operation against the one rotation key its *hint* names, so a client works the hints out here:
 * for each operation, which of the previous operation's rotation keys signed it. That is the same signature check the
 * contract does, done once in JavaScript to find the right key (Bluesky accounts are usually signed by their second
 * key, so trying them in order on-chain would waste a check per operation).
 */
import * as dagCbor from "@ipld/dag-cbor";
import { base58btc } from "multiformats/bases/base58";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { p256 } from "@noble/curves/nist.js";

export type PlcOp = Record<string, unknown>;

/** The most operations one `advance` takes (the book's MAX_ADVANCE). */
export const BOOK_MAX_ADVANCE = 24;

function base64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

/** A `did:key:z…` as (curve, compressed key). */
function parseDidKey(k: string): { curve: "k256" | "p256"; key: Uint8Array } {
  if (!k.startsWith("did:key:")) throw new Error("not a did:key");
  const raw = base58btc.decode(k.slice("did:key:".length));
  if (raw[0] === 0xe7 && raw[1] === 0x01) return { curve: "k256", key: raw.slice(2) };
  if (raw[0] === 0x80 && raw[1] === 0x24) return { curve: "p256", key: raw.slice(2) };
  throw new Error("unsupported key type");
}

/** The keys that may sign the operation after `op`, highest priority first (a legacy `create` ranks recovery first). */
function rotationKeys(op: PlcOp): string[] {
  if (op.type === "create") return [String(op.recoveryKey), String(op.signingKey)];
  return (op.rotationKeys as string[] | undefined) ?? [];
}

/** What an operation's signature covers: the operation without its `sig`, as DAG-CBOR. */
export function unsignedBytes(op: PlcOp): Uint8Array {
  const rest: PlcOp = { ...op };
  delete rest.sig;
  return dagCbor.encode(rest);
}

function signedBy(op: PlcOp, didKey: string): boolean {
  try {
    const { curve, key } = parseDidKey(didKey);
    const sig = base64url(String(op.sig));
    const msg = unsignedBytes(op);
    // prehash: sha256 of the message, as atproto signs; lowS: atproto refuses high-S signatures, and so does the book.
    return (curve === "k256" ? secp256k1 : p256).verify(sig, msg, key, { prehash: true, lowS: true });
  } catch {
    return false;
  }
}

/**
 * For each operation of a log (genesis first), the index of the rotation key that signed it, among the previous
 * operation's keys (the genesis among its own). Throws if an operation verifies against none of them: the book would
 * refuse it too.
 */
export function signerHints(log: PlcOp[]): number[] {
  return log.map((op, i) => {
    const keys = rotationKeys(i === 0 ? op : log[i - 1]!);
    const at = keys.findIndex((k) => signedBy(op, k));
    if (at < 0) throw new Error(`Operation ${i} of this account's identity history doesn't verify.`);
    return at;
  });
}

/** sha256 of an operation's unsigned bytes, hex: what the book stores per operation. */
export async function opHashHex(op: PlcOp): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", unsignedBytes(op)));
  return Array.from(h, (x) => x.toString(16).padStart(2, "0")).join("");
}
