// Live check of "Your sends": deposit with a 1-epoch refund, then list it back. With REFUND=1 it takes it back
// (works only once the epoch has advanced).   E2E_SEED=<32 hex> [REFUND=1] npx tsx scripts/e2e-sent.ts
import { initStorage, openWallet, formatTari, friendly } from "./shim";
import { toHex } from "../src/cbor";
import { CONFIG } from "../src/config";
import * as chain from "../src/chain";

initStorage();
const seed = process.env.E2E_SEED;
if (!seed) throw new Error("set E2E_SEED");
const w = await openWallet(seed);
const provider = await w.account!.getProvider();
const key = toHex(w.publicKey);
const DID = "did:plc:gcz3uzyvcex77mqylzggkqjf";
console.log("balance", formatTari(await w.balance()));
if (!process.env.REFUND) {
  CONFIG.refundAfterEpochs = 1;
  const esc = await chain.readEscrow(provider, DID);
  await chain.sendTip(w, { did: DID, amount: 10_000n, window: 0, challenge: process.env.CHALLENGE ?? "" }, esc.epoch, (s) => console.log("  ·", s));
  console.log("deposited 0.01, epoch", esc.epoch);
  await new Promise((r) => setTimeout(r, 3000));
}
const sent = await chain.readSentBy(provider, key);
console.log("epoch", sent.epoch, "sent:", sent.items.map((d) => `${formatTari(d.amount)} to ${d.did.slice(0, 16)} refundEpoch ${d.refundEpoch} challenge ${JSON.stringify(d.challenge)}`));
if (process.env.REFUND) {
  for (const d of sent.items) {
    try {
      await chain.refundDeposit(w, provider, d, (s) => console.log("  ·", s));
      console.log("refunded", formatTari(d.amount));
    } catch (e) {
      console.log("refund:", friendly(e));
    }
  }
  console.log("balance", formatTari(await w.balance()));
}
