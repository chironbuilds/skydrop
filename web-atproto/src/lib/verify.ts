/** The same `atp-verify` Rust the Ootle contracts link, compiled to WASM (see atp-verify-wasm/). */
export interface ChainResult { ok: true; len: number; alg: "k256" | "p256"; key: string; tip: string; handles: string[] }
export interface RecordResult { ok: true; root: string; rev: number; type: string }
export interface Failure { ok: false; stage: string; error: string }

interface Exports {
  memory: WebAssembly.Memory;
  alloc(n: number): number;
  dealloc(p: number, n: number): void;
  call(which: number, p: number, n: number): number;
  out_len(): number;
}

let loaded: Promise<Exports> | null = null;
let override: BufferSource | null = null;

/** For tests outside a browser: supply the module bytes directly. */
export function useWasmBytes(bytes: BufferSource): void {
  override = bytes;
  loaded = null;
}

function load(): Promise<Exports> {
  loaded ??= (async () => {
    const bytes = override ?? (await (await fetch("/atp_verify.wasm")).arrayBuffer());
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return instance.exports as unknown as Exports;
  })();
  return loaded;
}

function frames(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + 4 + p.length, 0));
  const view = new DataView(out.buffer);
  let off = 0;
  for (const p of parts) {
    view.setUint32(off, p.length, true);
    out.set(p, off + 4);
    off += 4 + p.length;
  }
  return out;
}

async function invoke<T>(which: number, parts: Uint8Array[]): Promise<T | Failure> {
  const w = await load();
  const input = frames(parts);
  const p = w.alloc(input.length);
  new Uint8Array(w.memory.buffer, p, input.length).set(input);
  let text: string;
  try {
    const at = w.call(which, p, input.length);
    text = new TextDecoder().decode(new Uint8Array(w.memory.buffer, at, w.out_len()));
  } catch {
    // the module aborts on a panic; a fresh instance is needed afterwards
    loaded = null;
    return { ok: false, stage: "panic", error: "Malformed input" };
  }
  w.dealloc(p, input.length);
  return JSON.parse(text) as T | Failure;
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

export const verifyChain = (did: string, ops: Uint8Array[]): Promise<ChainResult | Failure> => invoke<ChainResult>(0, [utf8(did), ...ops]);

export function verifyRecord(did: string, chain: ChainResult, proof: { commit: Uint8Array; nodes: Uint8Array[]; record: Uint8Array }, collection: string, rkey: string): Promise<RecordResult | Failure> {
  const key = Uint8Array.from(chain.key.match(/../g)!.map((b) => parseInt(b, 16)));
  return invoke<RecordResult>(1, [utf8(did), Uint8Array.of(chain.alg === "k256" ? 0 : 1), key, proof.commit, utf8(collection), utf8(rkey), proof.record, ...proof.nodes]);
}

export async function fieldStr(record: Uint8Array, path: string[]): Promise<string | null> {
  const r = await invoke<{ ok: true; value: string }>(2, [record, ...path.map(utf8)]);
  return r.ok ? r.value : null;
}

const WHY: Record<string, string> = {
  BadSignature: "A signature did not verify against the key the identity log names.",
  BrokenChain: "An operation does not link to the one before it, or was signed by a key not allowed to.",
  BadDid: "The operation log does not hash to this DID.",
  BadOp: "An identity operation is malformed.",
  BadKey: "A key in the identity log could not be parsed.",
  BadCommit: "The repo commit is malformed or belongs to another account.",
  NotFound: "The record is not in the repo tree the commit signs.",
  BadProof: "The Merkle path does not link the record to the signed tree.",
  Cbor: "The bytes are not well-formed DAG-CBOR.",
};

export const explain = (f: Failure): string => WHY[f.error] ?? f.error;
