// Runs the Campaign contract for real on Esmeralda, using the site's own instruction builders and state readers and the
// same SDK calls the Sapient wallet makes. The claimant is a throwaway identity made here, so no Bluesky account is
// needed: the contract only checks signatures. It spends testnet funds from the publisher wallet.
//
//   cd web-atproto
//   npx tsx ../scripts/live-campaign.ts create            # funds a tiny campaign, prints its address
//   npx tsx ../scripts/live-campaign.ts read <component>
//   npx tsx ../scripts/live-campaign.ts claim <component> # a new identity claims it, then a second claim must fail
//   npx tsx ../scripts/live-campaign.ts topup <component>
//   npx tsx ../scripts/live-campaign.ts close <component> # only works after the close epoch
//
// PUBLISH_DIR defaults to ~/rcv-publish, the folder holding publisher.json and the SDK.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";
import { claimCode, fromHex, fromMicro, newSpec, type Spec } from "../web-atproto/src/lib/campaign";
import { DEPLOYMENT } from "../web-atproto/src/data/deployment";
import { keyFromAddress } from "../web-atproto/src/lib/wallet";
import { claimInputs, claimInstruction, closeInstructions, createInstruction, currentEpoch, FUNDS_WORKSPACE, hasRegistryRecord, openAccountInstruction, readCampaign, readReceipt, TARI_RESOURCE, topUpInstruction, waitForOutcome, type RecordProof } from "../web-atproto/src/lib/chain";

const dir = process.env.PUBLISH_DIR ?? join(homedir(), "rcv-publish");
const req = createRequire(join(dir, "noop.js"));
const load = (name: string): Promise<any> => import(pathToFileURL(req.resolve(name)).href);
const sdk = await load("@chironbuilder/ootle-sdk");
const { secp256k1 } = await load("@noble/curves/secp256k1.js");
const sha256 = (data: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(data).digest());

sdk.configureOotleStorage(sdk.inMemoryAdapter());
const { entropy } = JSON.parse(readFileSync(join(dir, "publisher.json"), "utf8"));
const account = sdk.OotleAccount.fromSeed(sdk.fromHex(entropy), 0, "esmeralda");
const accountAddress: string = await account.getComponentAddress();
const walletKey = keyFromAddress(await account.getWalletAddress());

const [action, component] = process.argv.slice(2);

// ---- a throwaway atproto identity --------------------------------------------------------------------------------
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
function base32(data: Uint8Array): string {
  let out = "", acc = 0, bits = 0;
  for (const b of data) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) { bits -= 5; out += B32[(acc >> bits) & 31]; acc &= (1 << bits) - 1; }
  }
  if (bits) out += B32[(acc << (5 - bits)) & 31];
  return out;
}
function base58(data: Uint8Array): string {
  const T = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const digits: number[] = [];
  for (const byte of data) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) { carry += digits[i]! << 8; digits[i] = carry % 58; carry = Math.floor(carry / 58); }
    while (carry) { digits.push(carry % 58); carry = Math.floor(carry / 58); }
  }
  return digits.reverse().map((d) => T[d]).join("");
}
const b64url = (b: Uint8Array): string => Buffer.from(b).toString("base64url");
const sign = (key: Uint8Array, msg: Uint8Array): Uint8Array => secp256k1.sign(sha256(msg), key, { lowS: true }).toCompactRawBytes();
const didKey = (key: Uint8Array): string => `did:key:z${base58(Uint8Array.from([0xe7, 0x01, ...secp256k1.getPublicKey(key, true)]))}`;
const cidOf = (bytes: Uint8Array): CID => CID.createV1(0x71, Digest.create(0x12, sha256(bytes)));
function tid(micros: bigint): string {
  const A = "234567abcdefghijklmnopqrstuvwxyz";
  const v = micros << 10n;
  let s = "";
  for (let i = 12n; i >= 0n; i--) s += A[Number((v >> (5n * i)) & 31n)];
  return s;
}

function makeIdentity() {
  const key = secp256k1.utils.randomPrivateKey() as Uint8Array;
  const body: Record<string, unknown> = { type: "plc_operation", prev: null, services: {}, alsoKnownAs: ["at://throwaway.test"], rotationKeys: [didKey(key)], verificationMethods: { atproto: didKey(key) } };
  const signed = dagCbor.encode({ ...body, sig: b64url(sign(key, dagCbor.encode(body))) });
  const did = `did:plc:${base32(sha256(signed)).slice(0, 24)}`;
  let clock = BigInt(Date.now()) * 1000n;
  const prove = (collection: string, rkey: string, value: Record<string, unknown>): RecordProof => {
    const record = dagCbor.encode(value);
    const k = `${collection}/${rkey}`;
    const other = dagCbor.encode({ text: "unrelated" });
    const otherKey = `${collection}/3zzzzzzzzzzzz`;
    let p = 0;
    while (k[p] === otherKey[p]) p++;
    const te = new TextEncoder();
    const node = dagCbor.encode({ l: null, e: [
      { k: te.encode(k), p: 0, t: null, v: cidOf(record) },
      { k: te.encode(otherKey).slice(p), p, t: null, v: cidOf(other) },
    ] });
    clock += 1000n;
    const unsigned = { did, rev: tid(clock), data: cidOf(node), prev: null, version: 3 };
    const commit = dagCbor.encode({ ...unsigned, sig: sign(key, dagCbor.encode(unsigned)) });
    return { commit, nodes: [node], record, rkey };
  };
  return { did, ops: [signed], prove };
}

// ---- running ------------------------------------------------------------------------------------------------------
const show = (c: Awaited<ReturnType<typeof readCampaign>>) =>
  console.log(JSON.stringify({ ...c, reward: fromMicro(c.reward), bonus: fromMicro(c.bonus), paid: fromMicro(c.paid), balance: fromMicro(c.balance), rules: c.rules }, null, 1));

const spent = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
  const before = await balance();
  const out = await run();
  console.log(`${label}: wallet moved ${fromMicro(before - (await balance()))} tTARI`);
  return out;
};
async function balance(): Promise<bigint> {
  const all: { resourceAddress: string; amount: string }[] = await account.getBalances();
  return BigInt(all.find((b) => b.resourceAddress === TARI_RESOURCE)?.amount ?? 0);
}

async function outcome(transactionId: string) {
  const o = await waitForOutcome(transactionId);
  console.log("transaction", transactionId, o.state, o.state === "rejected" ? o.reason : "");
  return o;
}

const TARGET = "at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/app.bsky.feed.post/3kaaaaaaaaaaa";

if (action === "create") {
  const spec: Spec = { ...newSpec(), name: "Skydrop live test", about: "A contract test. Nothing to see.", rules: [{ kind: 0, target: TARGET }], reward: "50000", budget: "200000", days: 3 / 24 };
  const epoch = await currentEpoch();
  const follow = createInstruction(spec, epoch, walletKey);
  const res: { transactionId: string } = await spent("create", () => account.withdrawStealthAndExecute(TARI_RESOURCE, BigInt(spec.budget), FUNDS_WORKSPACE, [follow], [DEPLOYMENT.linkRegistry], 2_000_000n));
  const o = await outcome(res.transactionId);
  if (o.state !== "accepted") process.exit(1);
  console.log("components touched", o.components);
  for (const c of o.components) {
    const read = await readCampaign(c).catch(() => null);
    if (read) { console.log("CAMPAIGN", c); show(read); }
  }
} else if (action === "read") {
  show(await readCampaign(component!));
} else if (action === "claim") {
  const c = await readCampaign(component!);
  const me = makeIdentity();
  console.log("identity", me.did, "has record:", await hasRegistryRecord(me.did));
  const code = await claimCode(c.component, me.did, fromHex(walletKey), 0);
  const like = me.prove("app.bsky.feed.like", "3kbbbbbbbbbbb", { $type: "app.bsky.feed.like", subject: { uri: TARGET, cid: "bafy" }, createdAt: new Date().toISOString() });
  const post = me.prove("app.bsky.feed.post", "3kccccccccccc", { $type: "app.bsky.feed.post", text: `Claiming. ${code}`, createdAt: new Date().toISOString() });
  const proofs = { did: me.did, ops: me.ops, proofs: [like], vouchOps: [], code: post, amount: 0n, path: [] };
  const claim = claimInstruction(c.component, proofs, walletKey, accountAddress);
  const instructions = [openAccountInstruction(me.did), claim];
  const inputs = await claimInputs(c, [me.did], null);
  console.log("declared inputs", inputs.length);
  console.log("claim transaction bytes", JSON.stringify(instructions).length / 2);
  const dry = await account.execute(instructions, { dryRun: true, maxFee: 1_000_000n, inputs });
  console.log("dry run keys", Object.keys(dry ?? {}));
  const res: any = await spent("claim", () => account.execute(instructions, { maxFee: 1_000_000n, inputs }));
  await outcome(res.transactionId ?? res.transaction_id);
  console.log("has record now:", await hasRegistryRecord(me.did));
  console.log("receipt", await readReceipt(c, me.did));
  show(await readCampaign(c.component));
  // the receipt must stop a second claim
  const second = await account.execute([claim], { dryRun: true, maxFee: 1_000_000n }).then((r: unknown) => JSON.stringify(r, (_, x) => (typeof x === "bigint" ? x.toString() : x)).slice(0, 300)).catch((e: Error) => `refused: ${e.message.slice(0, 300)}`);
  console.log("second claim:", second);
} else if (action === "topup") {
  const res: { transactionId: string } = await spent("top up", () => account.withdrawStealthAndExecute(TARI_RESOURCE, 50_000n, FUNDS_WORKSPACE, [topUpInstruction(component!)], [component!], 1_000_000n));
  await outcome(res.transactionId);
  show(await readCampaign(component!));
} else if (action === "close") {
  const res: any = await spent("close", () => account.execute(closeInstructions(component!, accountAddress), { maxFee: 1_000_000n }));
  await outcome(res.transactionId ?? res.transaction_id);
  show(await readCampaign(component!));
} else {
  console.log("account", accountAddress, "balance", fromMicro(await balance()), "epoch", await currentEpoch());
}
process.exit(0);
