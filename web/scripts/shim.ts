// Node has no localStorage; the same chain code runs against the SDK's in-memory store.
export * from "../src/chain";
import { toHex } from "../src/cbor";
export const createSeedForTest = () => toHex(crypto.getRandomValues(new Uint8Array(16)));
