import { readFileSync } from "node:fs";
import { initStorage, openAccount, startClaimSponsored, tariBalance, friendly, readSponsorBalance, readEscrow } from "./shim";
import { fromHex, toHex } from "../src/cbor";
import { lookupProfile } from "../src/bsky";

initStorage();
const seed = toHex(crypto.getRandomValues(new Uint8Array(16)));
const acct = openAccount(seed); // never funded
const provider = await acct.getProvider();
console.log("unfunded wallet balance:", await tariBalance(acct));
console.log("sponsor vault:", await readSponsorBalance(provider));
const prof = await lookupProfile("0xhra.bsky.social");
console.log("escrow for", prof.handle, (await readEscrow(provider, prof.did)).deposits.length, "deposits");

const fx = JSON.parse(readFileSync("../fixtures/0xhra_claim.json", "utf8"));
const proof = { did: fx.did, rkey: fx.rkey, ops: fx.plcOps.map(fromHex), commit: fromHex(fx.commit), nodes: fx.mstNodes.map(fromHex), record: fromHex(fx.record), text: fx.text };
try {
  await startClaimSponsored(acct, proof, (s) => console.log("  ·", s));
  console.log("UNEXPECTED: accepted");
} catch (e) {
  console.log("rejected:", friendly(e));
  console.log("raw:", (e instanceof Error ? e.message : String(e)).slice(0, 300));
}
