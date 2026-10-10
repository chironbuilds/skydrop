// Live check of the tip-budget plumbing against the deployed component: fund a budget, read it back from
// chain state, then withdraw it. Needs a funded wallet: E2E_SEED=<32 hex> npx tsx scripts/e2e-tips.ts
import { initStorage, openWallet, readBudget, openBudget, closeBudget, formatTari, friendly } from "./shim";
import { lookupProfile } from "../src/bsky";
import { toHex } from "../src/cbor";

initStorage();
const seed = process.env.E2E_SEED;
if (!seed) throw new Error("set E2E_SEED to a funded wallet's recovery key");
const w = await openWallet(seed);
const provider = await w.account!.getProvider();
console.log("wallet", w.walletAddress, "balance", formatTari(await w.balance()));

const prof = await lookupProfile("@0xhra.bsky.social");
const keyHex = toHex(w.publicKey);
console.log("budget before", await readBudget(provider, prof.did, keyHex));

const out = await openBudget(w, { did: prof.did, amount: 3_000_000n, window: 0, refundAfter: 500, maxTip: 1_000_000n }, (s) => console.log("  ·", s)).catch((e) => {
  console.log("open failed:", friendly(e));
  process.exit(1);
});
console.log("open tx", out.transactionId);
await new Promise((r) => setTimeout(r, 3000));
const b = await readBudget(provider, prof.did, keyHex);
console.log("budget after open", b);
if (!b || b.balance !== 3_000_000n || b.maxTip !== 1_000_000n || b.window !== 0 || b.refundAfter !== 500) throw new Error("budget did not read back as written");

const back = await closeBudget(w, prof.did, b.balance, (s) => console.log("  ·", s));
console.log("close tx", back.transactionId);
await new Promise((r) => setTimeout(r, 3000));
console.log("budget after close", await readBudget(provider, prof.did, keyHex), "balance", formatTari(await w.balance()));
