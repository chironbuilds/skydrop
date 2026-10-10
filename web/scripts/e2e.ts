import { openWallet, initStorage, createSeedForTest, openAccount, readEscrow, sendTip, startClaim, tariBalance, useFaucet, formatTari, friendly } from "./shim";
import { lookupProfile, claimCode, findClaimPost, buildClaimProof } from "../src/bsky";
import { CONFIG } from "../src/config";

initStorage();
const seed = process.env.E2E_SEED ?? createSeedForTest();
console.log("seed", seed);
const acct = openAccount(seed);
const w = await openWallet(seed);
console.log("wallet", await acct.getWalletAddress());
console.log("balance before", formatTari(await tariBalance(acct)));
await useFaucet(acct).catch((e) => console.log("faucet:", e.message));
await new Promise((r) => setTimeout(r, 4000));
console.log("balance after faucet", formatTari(await tariBalance(acct)));

const prof = await lookupProfile("@0xhra.bsky.social");
console.log("profile", prof.displayName, prof.did);
const provider = await acct.getProvider();
let esc = await readEscrow(provider, prof.did);
console.log("escrow before", esc.deposits.length, "epoch", esc.epoch);

const tip = await sendTip(w, { did: prof.did, amount: 2000n, window: 0 }, esc.epoch, (s) => console.log("  ·", s));
console.log("tip tx", tip.transactionId);
await new Promise((r) => setTimeout(r, 3000));
esc = await readEscrow(provider, prof.did);
console.log("escrow after", esc.deposits.map((d) => `${d.amount} w${d.window} refund@${d.refundEpoch}`));

// A claim for the *old* post can't carry this component's code, so the contract must reject at exactly that check,
// after decoding every argument and verifying the identity chain and the repo proof.
import { readFileSync } from "node:fs";
import { fromHex } from "../src/cbor";
const fx = JSON.parse(readFileSync("../fixtures/0xhra_claim.json", "utf8"));
const proof = { did: fx.did, rkey: fx.rkey, ops: fx.plcOps.map(fromHex), commit: fromHex(fx.commit), nodes: fx.mstNodes.map(fromHex), record: fromHex(fx.record), text: fx.text };
console.log("proof from fixture: ops", proof.ops.length, "nodes", proof.nodes.length);
try {
  await startClaim(w, proof, (s) => console.log("  ·", s));
  console.log("UNEXPECTED: claim accepted");
} catch (e) {
  console.log("claim rejected as expected:", friendly(e));
}
const code = await claimCode(CONFIG.component, prof.did, await acct.getPublicKey());
console.log("code for this wallet:", code);
