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
//   npx tsx ../scripts/live-campaign.ts matrix            # allocations, either/or, vouches, several steps, extend
//   npx tsx ../scripts/live-campaign.ts matrix-later      # a second round and a take-back, an epoch or more afterwards
//
// PUBLISH_DIR defaults to ~/rcv-publish, the folder holding publisher.json and the SDK.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";
import { bindCode, buildAllocationTree, claimCode, claimFee, fromHex, fromMicro, newSpec, toHex, type Spec } from "../web-atproto/src/lib/campaign";
import { DEPLOYMENT } from "../web-atproto/src/data/deployment";
import { keyFromAddress } from "../web-atproto/src/lib/wallet";
import { asInputs, explainChainError, bindInstruction, claimRoundInstruction, extendInstruction, claimInputs, claimInstruction, claimLinkedInstruction, linkInputs, readLink, closeInstructions, createInstruction, currentEpoch, FUNDS_WORKSPACE, hasRegistryRecord, openAccountInstruction, readCampaign, readReceipt, readSubstate, TARI_RESOURCE, topUpInstruction, usableReferrer, waitForOutcome, type RecordProof } from "../web-atproto/src/lib/chain";

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

function makeIdentity(key: Uint8Array = secp256k1.utils.randomPrivateKey()) {
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
  // Several records in one commit, the way a real repo proves them: the contract checks that commit's signature once.
  const proveMany = (items: { collection: string; rkey: string; value: Record<string, unknown> }[]): RecordProof[] => {
    const te = new TextEncoder();
    const built = items.map((x) => ({ ...x, record: dagCbor.encode(x.value), full: te.encode(`${x.collection}/${x.rkey}`) }));
    const sorted = [...built].sort((a, b) => Buffer.compare(a.full, b.full));
    const entries = sorted.map((x, i) => {
      const prev = sorted[i - 1]?.full;
      let p = 0;
      while (prev && p < prev.length && p < x.full.length && prev[p] === x.full[p]) p++;
      return { k: x.full.slice(p), p, t: null, v: cidOf(x.record) };
    });
    const node = dagCbor.encode({ l: null, e: entries });
    clock += 1000n;
    const unsigned = { did, rev: tid(clock), data: cidOf(node), prev: null, version: 3 };
    const commit = dagCbor.encode({ ...unsigned, sig: sign(key, dagCbor.encode(unsigned)) });
    return built.map((x) => ({ commit, nodes: [node], record: x.record, rkey: x.rkey }));
  };
  return { did, key, ops: [signed], prove, proveMany };
}

// ---- running ------------------------------------------------------------------------------------------------------
const show = (c: Awaited<ReturnType<typeof readCampaign>>) =>
  console.log(JSON.stringify({ ...c, reward: fromMicro(c.reward), bonus: fromMicro(c.bonus), paid: fromMicro(c.paid), balance: fromMicro(c.balance), rules: c.rules }, null, 1));

const spent = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
  const before = await balance();
  const out = await run();
  const moved = before - (await balance());
  console.log(`${label}: wallet ${moved < 0n ? "gained" : "spent"} ${fromMicro(moved < 0n ? -moved : moved)} tTARI`);
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
} else if (action === "referral") {
  // A second wallet's account is the referrer, so the bonus lands in an account the claimant's wallet knows nothing about.
  const other = sdk.OotleAccount.fromSeed(sdk.fromHex(entropy), 1, "esmeralda");
  const otherAddress: string = await other.getComponentAddress();
  if (!(await readSubstate(otherAddress))) {
    await account.send(await other.getWalletAddress(), TARI_RESOURCE, 100_000n, 1_000_000n);
    console.log("made the referrer's account", otherAddress);
  }
  let c = await readCampaign(component!);
  const referrer = makeIdentity();
  const firstClaim = async (who: ReturnType<typeof makeIdentity>, pays: string, ref: string | null) => {
    const code = await claimCode(c.component, who.did, fromHex(walletKey), 0);
    const like = who.prove("app.bsky.feed.like", "3kbbbbbbbbbbb", { $type: "app.bsky.feed.like", subject: { uri: TARGET, cid: "bafy" }, createdAt: new Date().toISOString() });
    const post = who.prove("app.bsky.feed.post", "3kccccccccccc", { $type: "app.bsky.feed.post", text: `Claiming. ${code}`, createdAt: new Date().toISOString() });
    const proofs = { did: who.did, ops: who.ops, proofs: [like], vouchOps: [], code: post, amount: 0n, path: [] };
    c = await readCampaign(c.component);
    const named = await usableReferrer(c, who.did, ref, c.reward);
    const instructions = [openAccountInstruction(who.did), claimInstruction(c.component, proofs, walletKey, pays, ref)];
    return { named, instructions, inputs: await claimInputs(c, [who.did], null, named) };
  };
  const send = async (label: string, plan: Awaited<ReturnType<typeof firstClaim>>) => {
    const res: any = await spent(label, () => account.execute(plan.instructions, { maxFee: 1_000_000n, inputs: plan.inputs }));
    return outcome(res.transactionId ?? res.transaction_id);
  };
  const dry = async (plan: Awaited<ReturnType<typeof firstClaim>>) => {
    const out = await account.execute(plan.instructions, { dryRun: true, maxFee: 1_000_000n, inputs: plan.inputs }).then((r: unknown) => JSON.stringify(r, (_, x) => (typeof x === "bigint" ? x.toString() : x))).catch((e: Error) => `refused: ${e.message}`);
    return out.slice(0, 400);
  };

  const stranger = makeIdentity();
  console.log("usable before they've claimed:", await usableReferrer(c, stranger.did, referrer.did, c.reward));
  await send("referrer's own claim", await firstClaim(referrer, otherAddress, null));
  c = await readCampaign(c.component);
  console.log("receipt", await readReceipt(c, referrer.did));
  console.log("self referral usable:", await usableReferrer(c, referrer.did, referrer.did, c.reward));

  const before = await other.getBalances();
  const plan = await firstClaim(stranger, accountAddress, referrer.did);
  console.log("usable after they've claimed:", plan.named, "declared inputs", plan.inputs.length);
  await send("claim with a referrer", plan);
  console.log("referrer's balance before", before, "after", await other.getBalances());
  c = await readCampaign(c.component);
  console.log("receipt after", await readReceipt(c, referrer.did));

  const third = makeIdentity();
  const over = await firstClaim(third, accountAddress, referrer.did);
  console.log("usable over the limit:", over.named);
  console.log("over the limit, dry run:", await dry(over));
  show(await readCampaign(c.component));
} else if (action === "link") {
  // Links throwaway identities, then claims with no claim post: once with the linked wallet sending its own claim, and
  // once with a different wallet sending it. The payout must go to the linked account either way.
  const c = await readCampaign(component!);
  const other = sdk.OotleAccount.fromSeed(sdk.fromHex(entropy), 1, "esmeralda");
  const otherAddress: string = await other.getComponentAddress();
  const otherKey = keyFromAddress(await other.getWalletAddress());
  const tari = async (a: any) => (await a.getBalances()).find((b: any) => b.resourceAddress === TARI_RESOURCE)?.amount;
  for (const [label, address, key, sender] of [["own wallet", accountAddress, walletKey, account], ["another wallet", otherAddress, otherKey, account]] as const) {
    console.log(`--- linked to ${label}`);
    const me = makeIdentity();
    console.log("link before:", await readLink(me.did, c.epoch, c.linkRegistry));
    const code = await bindCode(c.linkRegistry, me.did, address, fromHex(key));
    const post = me.prove("app.bsky.feed.post", "3kddddddddddd", { $type: "app.bsky.feed.post", text: `Linking my wallet. ${code}`, createdAt: new Date().toISOString() });
    const ins = [openAccountInstruction(me.did), bindInstruction(c.linkRegistry, me.did, address, key, me.ops, post)];
    const linkIn = await linkInputs(c.linkRegistry, me.did, address);
    const res: any = await spent("link", () => sender.execute(ins, { maxFee: 1_000_000n, inputs: linkIn }));
    if ((await outcome(res.transactionId ?? res.transaction_id)).state !== "accepted") process.exit(1);
    const epoch = await currentEpoch();
    const link = await readLink(me.did, epoch, c.linkRegistry);
    console.log("link after:", link);
    const like = me.prove("app.bsky.feed.like", "3kbbbbbbbbbbb", { $type: "app.bsky.feed.like", subject: { uri: TARGET, cid: "bafy" }, createdAt: new Date().toISOString() });
    const fresh = await readCampaign(c.component);
    const inputs = await claimInputs(fresh, [me.did], null, null, link!.active);
    const before = await tari(other);
    const res2: any = await spent("linked claim", () => sender.execute([claimLinkedInstruction(c.component, { did: me.did, ops: me.ops, proofs: [like], vouchOps: [], amount: 0n, path: [] })], { maxFee: 1_000_000n, inputs }));
    await outcome(res2.transactionId ?? res2.transaction_id);
    console.log("receipt", await readReceipt(fresh, me.did));
    console.log("second wallet", before, "->", await tari(other));
  }
} else if (action === "matrix" || action === "matrix-later") {
  // Everything the sites can build that hadn't yet run on the network. It keeps its throwaway identities and campaigns
  // in a file, because a second round has to wait for the next epoch.
  const STATE = process.env.LIVE_STATE ?? join(tmpdir(), "skydrop-live-matrix.json");
  const other = sdk.OotleAccount.fromSeed(sdk.fromHex(entropy), 1, "esmeralda");
  const otherAddress: string = await other.getComponentAddress();
  const tari = async (a: any): Promise<bigint> => BigInt((await a.getBalances()).find((b: any) => b.resourceAddress === TARI_RESOURCE)?.amount ?? 0);
  const text = (r: unknown): string => JSON.stringify(r, (_, x) => (typeof x === "bigint" ? x.toString() : x));
  const dryRun = (instructions: unknown[], inputs: unknown[]) => account.execute(instructions, { dryRun: true, maxFee: 2_000_000n, inputs }).then((r: unknown) => `passed ${text(r).slice(0, 160)}`).catch((e: Error) => `refused: ${e.message.slice(0, 300)}`);
  const send = async (label: string, instructions: unknown[], inputs: unknown[]) => {
    const res: any = await spent(label, () => account.execute(instructions, { maxFee: 2_000_000n, inputs }));
    return outcome(res.transactionId ?? res.transaction_id);
  };
  const now = () => new Date().toISOString();
  const like = { collection: "app.bsky.feed.like", rkey: "3kbbbbbbbbbbb", value: { $type: "app.bsky.feed.like", subject: { uri: TARGET, cid: "bafy" }, createdAt: now() } };
  const repost = { collection: "app.bsky.feed.repost", rkey: "3kbbbbbbbbbbc", value: { $type: "app.bsky.feed.repost", subject: { uri: TARGET, cid: "bafy" }, createdAt: now() } };
  const FOLLOW_TARGET = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
  const follow = { collection: "app.bsky.graph.follow", rkey: "3kbbbbbbbbbbd", value: { $type: "app.bsky.graph.follow", subject: FOLLOW_TARGET, createdAt: now() } };
  const post = (rkey: string, code: string) => ({ collection: "app.bsky.feed.post", rkey, value: { $type: "app.bsky.feed.post", text: `Claiming. ${code}`, createdAt: now() } });
  const report = (label: string, estimate: bigint, reward: bigint, before: bigint, after: bigint) => console.log(`${label}: fee ${fromMicro(reward + before - after)} tTARI, the sites estimate ${fromMicro(estimate)}`);

  if (action === "matrix") {
    const who = makeIdentity();
    const voucher = makeIdentity();
    const listed = makeIdentity();
    const list = `at://${voucher.did}/app.bsky.graph.list/3kaaaaaaaaaaa`;
    const launch = async (label: string, spec: Spec): Promise<string> => {
      const res: { transactionId: string } = await spent(`create ${label}`, async () => account.withdrawStealthAndExecute(TARI_RESOURCE, BigInt(spec.budget), FUNDS_WORKSPACE, [createInstruction(spec, await currentEpoch(), walletKey)], [DEPLOYMENT.linkRegistry], 2_000_000n));
      const o = await outcome(res.transactionId);
      if (o.state !== "accepted") throw new Error(`creating ${label} failed`);
      for (const x of o.components) if (await readCampaign(x).catch(() => null)) { console.log(label, x); return x; }
      throw new Error(`${label} wasn't found`);
    };
    const about = "A contract test. Nothing to see.";
    const tree = await buildAllocationTree([{ did: who.did, amount: "70000" }, { did: listed.did, amount: "30000" }]);
    const components = {
      steps: await launch("three steps", { ...newSpec(), name: "Skydrop steps test", about, rules: [{ kind: 0, target: TARGET }, { kind: 1, target: TARGET }, { kind: 2, target: FOLLOW_TARGET }], reward: "60000", budget: "100000", days: 6 / 24 }),
      vouched: await launch("either/or, vouches, two rounds", { ...newSpec(), name: "Skydrop rounds test", about, rules: [{ kind: 0, target: TARGET }, { kind: 1, target: TARGET, or: true }, { kind: 7, target: voucher.did }, { kind: 6, target: list }], reward: "60000", budget: "150000", rounds: 2, roundDays: 1 / 24, days: 6 / 24 }),
      allocated: await launch("allocation list", { ...newSpec(), name: "Skydrop list test", about, rules: [{ kind: 0, target: TARGET }], reward: "0", root: tree.root, allocations: [{ did: who.did, amount: "70000" }, { did: listed.did, amount: "30000" }], budget: "100000", days: 2 / 24 }),
      closing: await launch("take-back", { ...newSpec(), name: "Skydrop close test", about, rules: [{ kind: 0, target: TARGET }], reward: "10000", budget: "20000", days: 1 / 24 }),
    };
    writeFileSync(STATE, JSON.stringify({ who: toHex(who.key), voucher: toHex(voucher.key), components }));
    console.log("saved", STATE);

    console.log("--- three steps from one commit");
    {
      const c = await readCampaign(components.steps);
      const code = await claimCode(c.component, who.did, fromHex(walletKey), 0);
      const proofs = who.proveMany([like, repost, follow, post("3kccccccccccc", code)]);
      const p = { did: who.did, ops: who.ops, proofs: proofs.slice(0, 3), vouchOps: [], code: proofs[3]!, amount: 0n, path: [] };
      const before = await tari(account);
      await send("claim", [openAccountInstruction(who.did), claimInstruction(c.component, p, walletKey, accountAddress)], await claimInputs(c, [who.did], null));
      report("three steps", claimFee(c.rules), c.reward, before, await tari(account));
    }

    console.log("--- an allocation list");
    {
      const c = await readCampaign(components.allocated);
      const mine = tree.proofs[who.did]!;
      const code = await claimCode(c.component, who.did, fromHex(walletKey), 0);
      const [l, codePost] = who.proveMany([like, post("3kccccccccccc", code)]);
      const p = { did: who.did, ops: who.ops, proofs: [l!], vouchOps: [], code: codePost!, amount: BigInt(mine.amount), path: mine.path };
      const inputs = await claimInputs(c, [who.did], null);
      console.log("claiming more than listed:", await dryRun([claimInstruction(c.component, { ...p, amount: 90000n }, walletKey, accountAddress)], inputs));
      const before = await tari(account);
      await send("claim", [claimInstruction(c.component, p, walletKey, accountAddress)], inputs);
      report("listed amount", claimFee(c.rules), 70000n, before, await tari(account));
      const r = await readCampaign(c.component);
      console.log("paid", fromMicro(r.paid), "left", fromMicro(r.balance));
    }

    console.log("--- extending");
    {
      const c = await readCampaign(components.allocated);
      const o = await send("extend", [extendInstruction(c.component, c.closeEpoch + 2)], asInputs([c.component]));
      const r = await readCampaign(c.component);
      console.log("close epoch", c.closeEpoch, "->", r.closeEpoch, o.state);
      console.log("moving it earlier:", await dryRun([extendInstruction(c.component, c.closeEpoch + 1)], asInputs([c.component])));
    }

    console.log("--- either/or and two vouches, linked to the other wallet");
    {
      const c = await readCampaign(components.vouched);
      const code = await bindCode(c.linkRegistry, who.did, otherAddress, fromHex(keyFromAddress(await other.getWalletAddress())));
      const bindPost = who.prove("app.bsky.feed.post", "3kddddddddddd", { $type: "app.bsky.feed.post", text: `Linking. ${code}`, createdAt: now() });
      const bound = await send("link", [bindInstruction(c.linkRegistry, who.did, otherAddress, keyFromAddress(await other.getWalletAddress()), who.ops, bindPost)], await linkInputs(c.linkRegistry, who.did, otherAddress));
      if (bound.state !== "accepted") process.exit(1);
      const link = await readLink(who.did, await currentEpoch(), c.linkRegistry);
      console.log("linked to", link?.active);
      const followedBy = voucher.prove("app.bsky.graph.follow", "3keeeeeeeeeee", { $type: "app.bsky.graph.follow", subject: who.did, createdAt: now() });
      const onList = voucher.prove("app.bsky.graph.listitem", "3kfffffffffff", { $type: "app.bsky.graph.listitem", subject: who.did, list, createdAt: now() });
      const [r] = who.proveMany([repost]);
      // The first either/or step is skipped, and the second one proven.
      const p = { did: who.did, ops: who.ops, proofs: [null, r!, followedBy, onList], vouchOps: [voucher.ops, voucher.ops], amount: 0n, path: [] };
      const inputs = await claimInputs(c, [who.did, voucher.did], null, null, otherAddress);
      const instructions = [openAccountInstruction(voucher.did), claimLinkedInstruction(c.component, p)];
      console.log("neither either/or step:", await dryRun([openAccountInstruction(voucher.did), claimLinkedInstruction(c.component, { ...p, proofs: [null, null, followedBy, onList] })], inputs));
      const before = await tari(account);
      const paidBefore = await tari(other);
      await send("claim", instructions, inputs);
      console.log(`either/or and two vouches: this wallet paid ${fromMicro(before - (await tari(account)))} tTARI, the sites estimate ${fromMicro(claimFee(c.rules))} less about 0.01 for a linked claim`);
      console.log("other wallet", paidBefore, "->", await tari(other));
      console.log("receipt", await readReceipt(c, who.did));
      show(await readCampaign(c.component));
    }
  } else {
    if (!existsSync(STATE)) throw new Error(`nothing saved at ${STATE}`);
    const saved = JSON.parse(readFileSync(STATE, "utf8"));
    const who = makeIdentity(fromHex(saved.who));
    const voucher = makeIdentity(fromHex(saved.voucher));
    const list = `at://${voucher.did}/app.bsky.graph.list/3kaaaaaaaaaaa`;

    console.log("--- round two, sent from a different wallet than the one paid");
    const c = await readCampaign(saved.components.vouched);
    const receipt = await readReceipt(c, who.did);
    console.log("epoch", c.epoch, "receipt", receipt);
    const code = await claimCode(c.component, who.did, fromHex(walletKey), 1);
    const followedBy = voucher.prove("app.bsky.graph.follow", "3keeeeeeeeeee", { $type: "app.bsky.graph.follow", subject: who.did, createdAt: now() });
    const onList = voucher.prove("app.bsky.graph.listitem", "3kfffffffffff", { $type: "app.bsky.graph.listitem", subject: who.did, list, createdAt: now() });
    const [l, codePost] = who.proveMany([like, post("3kgggggggggggg", code)]);
    const p = { did: who.did, ops: who.ops, proofs: [l!, null, followedBy, onList], vouchOps: [voucher.ops, voucher.ops], code: codePost!, amount: 0n, path: [] };
    const ins = [claimRoundInstruction(c.component, p, walletKey)];
    console.log("without the payout account declared:", await dryRun(ins, await claimInputs(c, [who.did, voucher.did], who.did)));
    const inputs = await claimInputs(c, [who.did, voucher.did], who.did, null, receipt!.account);
    console.log("with it declared:", await dryRun(ins, inputs));
    const before = await tari(account);
    const paidBefore = await tari(other);
    const o = await send("round two", ins, inputs);
    console.log(`round two: this wallet paid ${fromMicro(before - (await tari(account)))} tTARI, state ${o.state}`);
    console.log("other wallet", paidBefore, "->", await tari(other));
    console.log("receipt", await readReceipt(c, who.did));
    console.log("a third round:", await dryRun(ins, inputs));

    console.log("--- three steps from one commit, on a fresh account");
    {
      const steps = saved.components.steps as string;
      await spent("top up", () => account.withdrawStealthAndExecute(TARI_RESOURCE, 30_000n, FUNDS_WORKSPACE, [topUpInstruction(steps)], [steps], 1_000_000n));
      const c3 = await readCampaign(steps);
      const fresh = makeIdentity();
      const code3 = await claimCode(c3.component, fresh.did, fromHex(walletKey), 0);
      const proofs = fresh.proveMany([like, repost, follow, post("3kccccccccccc", code3)]);
      const p3 = { did: fresh.did, ops: fresh.ops, proofs: proofs.slice(0, 3), vouchOps: [], code: proofs[3]!, amount: 0n, path: [] };
      const b3 = await tari(account);
      await send("claim", [openAccountInstruction(fresh.did), claimInstruction(c3.component, p3, walletKey, accountAddress)], await claimInputs(c3, [fresh.did], null));
      report("three steps", claimFee(c3.rules), c3.reward, b3, await tari(account));
    }

    console.log("--- taking back, with the inputs the site declares");
    const z = await readCampaign(saved.components.closing);
    console.log("close epoch", z.closeEpoch, "now", z.epoch, "balance", fromMicro(z.balance));
    const closeIn = asInputs([z.component, z.vault]);
    console.log("dry run:", await dryRun(closeInstructions(z.component, accountAddress), closeIn));
    await send("close", closeInstructions(z.component, accountAddress), closeIn);
    console.log("left", fromMicro((await readCampaign(z.component)).balance));
  }
} else if (action === "rounds" || action === "rounds-later") {
  // Whether a later round passes the same dry run the site runs first, and what it says if it doesn't.
  const STATE = process.env.LIVE_STATE ?? join(tmpdir(), "skydrop-live-rounds.json");
  const other = sdk.OotleAccount.fromSeed(sdk.fromHex(entropy), 1, "esmeralda");
  const otherAddress: string = await other.getComponentAddress();
  const otherKey = keyFromAddress(await other.getWalletAddress());
  const now = () => new Date().toISOString();
  const like = { collection: "app.bsky.feed.like", rkey: "3kbbbbbbbbbbb", value: { $type: "app.bsky.feed.like", subject: { uri: TARGET, cid: "bafy" }, createdAt: now() } };
  const dry = async (label: string, instructions: unknown[], inputs: unknown[]) => {
    const said = await account.execute(instructions, { dryRun: true, maxFee: 2_000_000n, inputs }).then(() => "passed").catch((e: Error) => {
      const tail = e.message.slice(-400);
      return `refused: ${explainChainError(e.message)} || ${tail}`;
    });
    console.log(`${new Date().toISOString()} [epoch ${await currentEpoch()}] ${label}: ${said}`);
    return said === "passed";
  };
  if (action === "rounds") {
    const who = makeIdentity();
    const spec: Spec = { ...newSpec(), name: "Skydrop rounds test 2", about: "A contract test. Nothing to see.", rules: [{ kind: 0, target: TARGET }], reward: "30000", budget: "90000", rounds: 3, roundDays: 1 / 24, days: 8 / 24 };
    const res: { transactionId: string } = await spent("create", async () => account.withdrawStealthAndExecute(TARI_RESOURCE, BigInt(spec.budget), FUNDS_WORKSPACE, [createInstruction(spec, await currentEpoch(), walletKey)], [DEPLOYMENT.linkRegistry], 2_000_000n));
    const o = await outcome(res.transactionId);
    if (o.state !== "accepted") process.exit(1);
    let component2 = "";
    for (const x of o.components) if (await readCampaign(x).catch(() => null)) component2 = x;
    console.log("CAMPAIGN", component2);
    const c = await readCampaign(component2);
    const code = await bindCode(c.linkRegistry, who.did, otherAddress, fromHex(otherKey));
    const bindPost = who.prove("app.bsky.feed.post", "3kddddddddddd", { $type: "app.bsky.feed.post", text: `Linking. ${code}`, createdAt: now() });
    const bind: any = await spent("link", () => account.execute([openAccountInstruction(who.did), bindInstruction(c.linkRegistry, who.did, otherAddress, otherKey, who.ops, bindPost)], { maxFee: 1_000_000n, inputs: [] }));
    await outcome(bind.transactionId ?? bind.transaction_id);
    const [l] = who.proveMany([like]);
    const first: any = await spent("first claim", async () => account.execute([claimLinkedInstruction(c.component, { did: who.did, ops: who.ops, proofs: [l!], vouchOps: [], amount: 0n, path: [] })], { maxFee: 2_000_000n, inputs: await claimInputs(c, [who.did], null, null, otherAddress) }));
    await outcome(first.transactionId ?? first.transaction_id);
    writeFileSync(STATE, JSON.stringify({ who: toHex(who.key), component: component2 }));
    console.log("saved", STATE, await readReceipt(c, who.did));
  } else {
    const saved = JSON.parse(readFileSync(STATE, "utf8"));
    const who = makeIdentity(fromHex(saved.who));
    const c = await readCampaign(saved.component);
    const receipt = await readReceipt(c, who.did);
    console.log("epoch", c.epoch, "receipt", receipt);
    const round = receipt!.roundsPaid;
    const code = await claimCode(c.component, who.did, fromHex(walletKey), round);
    const [l, codePost] = who.proveMany([like, { collection: "app.bsky.feed.post", rkey: "3kgggggggggggg", value: { $type: "app.bsky.feed.post", text: `Claiming. ${code}`, createdAt: now() } }]);
    const ins = [claimRoundInstruction(c.component, { did: who.did, ops: who.ops, proofs: [l!], vouchOps: [], code: codePost!, amount: 0n, path: [] }, walletKey)];
    const without = await claimInputs(c, [who.did], who.did);
    const declared = await claimInputs(c, [who.did], who.did, null, receipt!.account);
    await dry("payout account not declared", ins, without);
    let ok = await dry("payout account declared", ins, declared);
    for (let i = 0; i < 12 && !ok; i++) {
      await new Promise((r) => setTimeout(r, 60_000));
      ok = await dry("payout account declared, again", ins, declared);
    }
    const before = await account.getBalances();
    const res: any = await spent(`round ${round + 1}`, () => account.execute(ins, { maxFee: 2_000_000n, inputs: declared }));
    await outcome(res.transactionId ?? res.transaction_id);
    console.log("balances before", before, "receipt", await readReceipt(c, who.did));
  }
} else if (action === "batch") {
  // Collecting from several campaigns in one transaction: through a link, and with one post carrying several codes.
  const ONE = 30_000n;
  const made: string[] = [];
  for (let i = 0; i < 9; i++) {
    const spec: Spec = { ...newSpec(), name: `Skydrop batch test ${i + 1}`, about: "A contract test. Nothing to see.", rules: [{ kind: 0, target: TARGET }], reward: ONE.toString(), budget: ONE.toString(), days: 3 / 24 };
    const res: { transactionId: string } = await account.withdrawStealthAndExecute(TARI_RESOURCE, ONE, FUNDS_WORKSPACE, [createInstruction(spec, await currentEpoch(), walletKey)], [DEPLOYMENT.linkRegistry], 2_000_000n);
    const o = await outcome(res.transactionId);
    if (o.state !== "accepted") process.exit(1);
    for (const x of o.components) if (await readCampaign(x).catch(() => null)) made.push(x);
  }
  console.log("campaigns", made);
  const camps = await Promise.all(made.map(readCampaign));
  const now = () => new Date().toISOString();
  const like = { collection: "app.bsky.feed.like", rkey: "3kbbbbbbbbbbb", value: { $type: "app.bsky.feed.like", subject: { uri: TARGET, cid: "bafy" }, createdAt: now() } };
  const union = (all: { substate_id: string; version: null }[][]) => asInputs(all.flat().map((x) => x.substate_id));
  const run = async (label: string, ins: unknown[], inputs: unknown[]) => {
    console.log(label, "instructions", ins.length, "bytes", JSON.stringify(ins).length);
    const res: any = await spent(label, () => account.execute(ins, { maxFee: 4_000_000n, inputs }));
    return outcome(res.transactionId ?? res.transaction_id);
  };

  // Through a link.
  const a = makeIdentity();
  const c0 = camps[0]!;
  const code = await bindCode(c0.linkRegistry, a.did, accountAddress, fromHex(walletKey));
  const bindPost = a.prove("app.bsky.feed.post", "3kddddddddddd", { $type: "app.bsky.feed.post", text: `Linking. ${code}`, createdAt: now() });
  await run("link", [openAccountInstruction(a.did), bindInstruction(c0.linkRegistry, a.did, accountAddress, walletKey, a.ops, bindPost)], await linkInputs(c0.linkRegistry, a.did, accountAddress));
  const [al] = a.proveMany([like]);
  const linked = (c: typeof c0) => claimLinkedInstruction(c.component, { did: a.did, ops: a.ops, proofs: [al!], vouchOps: [], amount: 0n, path: [] });
  await run("one linked claim", [linked(c0)], await claimInputs(c0, [a.did], null, null, accountAddress));
  const five = camps.slice(1, 6);
  const fiveInputs = union(await Promise.all(five.map((c) => claimInputs(c, [a.did], null, null, accountAddress))));
  await run("five linked claims", five.map(linked), fiveInputs);
  console.log("receipts", await Promise.all(five.map((c) => readReceipt(c, a.did).then((r) => r?.roundsPaid))));
  const again = await account.execute(five.map(linked), { dryRun: true, maxFee: 4_000_000n, inputs: fiveInputs }).then(() => "passed").catch((e: Error) => `refused: ${explainChainError(e.message)}`);
  console.log("the same batch again, dry run:", again);

  // One post, several codes.
  const b = makeIdentity();
  const three = camps.slice(6, 9);
  const codes = await Promise.all(three.map((c) => claimCode(c.component, b.did, fromHex(walletKey), 0)));
  const text = `Claiming my Skydrop rewards. ${codes.join(" ")}`;
  console.log("post length", text.length);
  const [bl, bp] = b.proveMany([like, { collection: "app.bsky.feed.post", rkey: "3kgggggggggggg", value: { $type: "app.bsky.feed.post", text, createdAt: now() } }]);
  const threeIns = three.map((c) => claimInstruction(c.component, { did: b.did, ops: b.ops, proofs: [bl!], vouchOps: [], code: bp!, amount: 0n, path: [] }, walletKey, accountAddress));
  const threeInputs = union(await Promise.all(three.map((c) => claimInputs(c, [b.did], null))));
  await run("three claims, one post", [openAccountInstruction(b.did), ...threeIns], threeInputs);
  console.log("receipts", await Promise.all(three.map((c) => readReceipt(c, b.did).then((r) => r?.roundsPaid))));
} else if (action === "fixes") {
  // The audit's referrer fix, on the deployed contracts. A linked claim names a referrer only if the linked wallet signs.
  const spec: Spec = { ...newSpec(), name: "Skydrop fixes test", about: "A contract test. Nothing to see.", rules: [{ kind: 0, target: TARGET }], reward: "20000", budget: "70000", bonus: "5000", maxReferrals: 5, days: 3 / 24 };
  const res: { transactionId: string } = await spent("create", async () => account.withdrawStealthAndExecute(TARI_RESOURCE, 70000n, FUNDS_WORKSPACE, [createInstruction(spec, await currentEpoch(), walletKey)], [DEPLOYMENT.linkRegistry], 500_000n));
  const o = await outcome(res.transactionId);
  if (o.state !== "accepted") process.exit(1);
  let camp = "";
  for (const x of o.components) if (await readCampaign(x).catch(() => null)) camp = x;
  console.log("CAMPAIGN", camp);
  const c = await readCampaign(camp);
  console.log("new template:", !c.legacy, "new registry:", c.linkRegistry === DEPLOYMENT.linkRegistry);
  const now = () => new Date().toISOString();
  const like = { collection: "app.bsky.feed.like", rkey: "3kbbbbbbbbbbb", value: { $type: "app.bsky.feed.like", subject: { uri: TARGET, cid: "bafy" }, createdAt: now() } };
  const send = async (label: string, ins: unknown[], inputs: unknown[]) => { const r: any = await spent(label, () => account.execute(ins, { maxFee: 500_000n, inputs })); return outcome(r.transactionId ?? r.transaction_id); };
  // Someone who has collected, so they can be named.
  const a = makeIdentity();
  const code = await claimCode(camp, a.did, fromHex(walletKey), 0);
  const [al, ap] = a.proveMany([like, { collection: "app.bsky.feed.post", rkey: "3kgggggggggggg", value: { $type: "app.bsky.feed.post", text: `Claiming. ${code}`, createdAt: now() } }]);
  await send("claim with a post", [openAccountInstruction(a.did), claimInstruction(camp, { did: a.did, ops: a.ops, proofs: [al!], vouchOps: [], code: ap!, amount: 0n, path: [] }, walletKey, accountAddress)], await claimInputs(c, [a.did], null));
  const referrer = await usableReferrer(await readCampaign(camp), "x", a.did, c.reward);
  const link = async (me: ReturnType<typeof makeIdentity>, address: string, key: string) => {
    const bc = await bindCode(c.linkRegistry, me.did, address, fromHex(key));
    const post = me.prove("app.bsky.feed.post", "3kddddddddddd", { $type: "app.bsky.feed.post", text: `Linking. ${bc}`, createdAt: now() });
    await send("link", [openAccountInstruction(me.did), bindInstruction(c.linkRegistry, me.did, address, key, me.ops, post)], await linkInputs(c.linkRegistry, me.did, address));
  };
  const claimFor = (me: ReturnType<typeof makeIdentity>, ref: string | null) => { const [l] = me.proveMany([like]); return claimLinkedInstruction(camp, { did: me.did, ops: me.ops, proofs: [l!], vouchOps: [], amount: 0n, path: [] }, ref); };
  // Linked to the other wallet, so this wallet isn't the owner.
  const other = sdk.OotleAccount.fromSeed(sdk.fromHex(entropy), 1, "esmeralda");
  const otherAddress: string = await other.getComponentAddress();
  const otherKey = keyFromAddress(await other.getWalletAddress());
  const b = makeIdentity();
  await link(b, otherAddress, otherKey);
  const bInputs = await claimInputs(await readCampaign(camp), [b.did], null, referrer, otherAddress);
  const stolen = await account.execute([claimFor(b, a.did)], { dryRun: true, maxFee: 500_000n, inputs: bInputs }).then(() => "PASSED", (e: Error) => `refused: ${e.message.slice(-180)}`);
  console.log("another wallet names a referrer, dry run:", stolen);
  await send("relayed linked claim, no referrer", [claimFor(b, null)], await claimInputs(await readCampaign(camp), [b.did], null, null, otherAddress));
  console.log("relayed receipt", await readReceipt(c, b.did));
  // Linked to this wallet, so it may.
  const d = makeIdentity();
  await link(d, accountAddress, walletKey);
  const before = (await readReceipt(c, a.did))?.referrals;
  await send("linked wallet claims, naming a referrer", [claimFor(d, a.did)], await claimInputs(await readCampaign(camp), [d.did], null, referrer, accountAddress));
  console.log("referrals", before, "->", (await readReceipt(c, a.did))?.referrals);
  console.log("balance left", fromMicro(await balance()));
} else if (action === "create-list") {
  // A campaign that pays only the accounts on a list, with no steps. `component` here is the list as did=amount,did=amount.
  const allocations = component!.split(",").map((x) => { const [did, amount] = x.split("="); return { did: did!, amount: amount! }; });
  const tree = await buildAllocationTree(allocations);
  const budget = allocations.reduce((n, a) => n + BigInt(a.amount), 0n);
  const spec: Spec = { ...newSpec(), name: "Skydrop list test", about: "A contract test. Nothing to see.", rules: [], reward: "0", root: tree.root, allocations, budget: budget.toString(), days: 1 };
  const res: { transactionId: string } = await spent("create", async () => account.withdrawStealthAndExecute(TARI_RESOURCE, budget, FUNDS_WORKSPACE, [createInstruction(spec, await currentEpoch(), walletKey)], [DEPLOYMENT.linkRegistry], 2_000_000n));
  const o = await outcome(res.transactionId);
  if (o.state !== "accepted") process.exit(1);
  for (const x of o.components) if (await readCampaign(x).catch(() => null)) console.log("CAMPAIGN", x);
} else if (action === "create-referral") {
  const spec: Spec = { ...newSpec(), name: "Skydrop referral test", about: "A contract test. Nothing to see.", rules: [{ kind: 0, target: TARGET }], reward: "50000", bonus: "20000", maxReferrals: 1, budget: "300000", days: 2 };
  const epoch = await currentEpoch();
  const res: { transactionId: string } = await spent("create", () => account.withdrawStealthAndExecute(TARI_RESOURCE, BigInt(spec.budget), FUNDS_WORKSPACE, [createInstruction(spec, epoch, walletKey)], [DEPLOYMENT.linkRegistry], 2_000_000n));
  const o = await outcome(res.transactionId);
  if (o.state !== "accepted") process.exit(1);
  for (const x of o.components) {
    const read = await readCampaign(x).catch(() => null);
    if (read) { console.log("CAMPAIGN", x); show(read); }
  }
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
