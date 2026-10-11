// Live check of the withdraw button's code path: send tTARI from a funded built-in wallet to another address.
//   E2E_SEED=<32 hex> DEST=<otl address> AMOUNT=<µT> npx tsx scripts/e2e-withdraw.ts
import { initStorage, openWallet, formatTari, friendly } from "./shim";
import * as chain from "../src/chain";

initStorage();
const seed = process.env.E2E_SEED;
const dest = process.env.DEST;
if (!seed || !dest) throw new Error("set E2E_SEED and DEST");
const w = await openWallet(seed);
const amount = BigInt(process.env.AMOUNT ?? "100000");
console.log("from", w.walletAddress.slice(0, 24) + "…", "balance", formatTari(await w.balance()));
console.log("address problem:", chain.addressProblem(dest, w.walletAddress), "| bad address:", chain.addressProblem("nonsense", w.walletAddress), "| own:", chain.addressProblem(w.walletAddress, w.walletAddress));
try {
  const out = await chain.withdrawTo(w, dest, amount, (s) => console.log("  ·", s));
  console.log("sent", formatTari(amount), "tx", out.transactionId);
} catch (e) {
  console.log("withdraw failed:", friendly(e));
  process.exit(1);
}
await new Promise((r) => setTimeout(r, 3000));
console.log("balance after", formatTari(await w.balance()));
