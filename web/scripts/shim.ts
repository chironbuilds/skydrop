// Node has no localStorage; the same chain code runs against the SDK's in-memory store.
export * from "../src/chain";
import { toHex } from "../src/cbor";
export const createSeedForTest = () => toHex(crypto.getRandomValues(new Uint8Array(16)));
import { builtinWallet } from "../src/wallet";
import { openAccount as _open, tariBalance as _bal } from "../src/chain";
export const openWallet = async (seed: string) => {
  const a = _open(seed);
  return builtinWallet(a, () => _bal(a));
};
