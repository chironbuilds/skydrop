// Exercises worker/gate.ts end to end without Cloudflare: an in-memory store, a fake indexer, and REAL
// wallet signatures from the ootle wasm. The signed message is built by the wallet SDK's own function,
// so a byte-level mismatch between the wallet and this verifier would fail here.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { publicKeyFromSecretKey, schnorrSign } from "@tari-project/ootle-wasm";
import { handleGate, toHex, walletOwnershipMessage, type GateDeps } from "../worker/gate";
import { CONFIG } from "../src/config";
// @ts-expect-error plain JS from the wallet repo
import { buildWalletOwnershipMessage as sdkMessage } from "file:///C:/Users/harsh/tari-wallet-extension/node_modules/@chironbuilder/ootle-sdk/dist/ownershipProof.js";

const GROUP_ORDER = (1n << 252n) + 27742317777372353535851937790883648493n;
const secret = (): Uint8Array => {
  let n = 0n;
  for (const b of randomBytes(64)) n = ((n << 8n) | BigInt(b)) % GROUP_ORDER;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++, n >>= 8n) out[i] = Number(n & 0xffn);
  return out;
};

const DID = "did:plc:abcdefghijklmnopqrstuvwx";
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");

let now = 1_700_000_000_000;
let epoch = 100;
const kv = new Map<string, ArrayBuffer>();
let deposits: { sender: string; amount: number; created: number }[] = [];
let delivered: { sender: string; amount: number; created: number }[] = [];

CONFIG.escrow = "component_" + "e".repeat(64);
CONFIG.claim = "component_" + "c".repeat(64);
const OTHER_POLICY = { "@cbor": "tag", tag: 132, value: { "@cbor": "bytes", hex: "f".repeat(64) } };
const CLAIM_POLICY = { "@cbor": "tag", tag: 132, value: { "@cbor": "bytes", hex: "c".repeat(64) } };
let otherPolicyDeposits: { sender: string; amount: number; created: number }[] = [];

const deps: GateDeps = {
  store: {
    get: async (k) => kv.get(k) ?? null,
    put: async (k, v) => void kv.set(k, v),
  },
  now: () => now,
  random: (n) => new Uint8Array(randomBytes(n)),
  indexer: async (path) => {
    if (path.startsWith("epoch-manager/stats")) return { current_epoch: epoch };
    const wrap = (state: unknown[]) => ({ state: { up: { substate: { Component: { body: { state } } } } } });
    if (path === `substates/${CONFIG.escrow}`) {
      // Escrow state: deposits at index 7, each [sender, amount, refund, policy, metadata, created]
      const row = (policy: unknown) => (d: { sender: string; amount: number; created: number }) => [{ "@cbor": "bytes", hex: d.sender }, d.amount, 9999, policy, { "@cbor": "bytes", hex: "" }, d.created];
      const rows = [...deposits.map(row(CLAIM_POLICY)), ...otherPolicyDeposits.map(row(OTHER_POLICY))];
      return wrap([null, null, null, 1000, null, {}, 1, { [DID]: rows }, null, {}, {}]);
    }
    if (path === `substates/${CONFIG.claim}`) {
      // ClaimPolicy state: delivery log at index 8, each [sender, amount, epoch]
      const log = delivered.map((d) => [{ "@cbor": "bytes", hex: d.sender }, d.amount, d.created]);
      return wrap([null, null, {}, {}, {}, {}, null, {}, { [DID]: log }]);
    }
    throw new Error("unexpected " + path);
  },
};

const call = (path: string, method: string, body?: unknown) =>
  handleGate(new Request("https://skydrop.tari.mw" + path, { method, body: body === undefined ? undefined : JSON.stringify(body) }), deps).then(async (r) => ({
    status: r!.status,
    body: r!.headers.get("content-type")?.includes("json") ? await r!.json() : await r!.text(),
  })) as Promise<{ status: number; body: any }>;

const contentKey = randomBytes(32);
const create = (over: Record<string, unknown> = {}) =>
  call("/api/gate", "POST", { did: DID, price: "2000000", title: "Secret", ciphertext: b64(randomBytes(40)), iv: b64(randomBytes(12)), key: b64(contentKey), ...over });

function unlockBody(id: string, sk: Uint8Array, over: { ts?: number; ownerKey?: string; wallet?: string } = {}) {
  const pk = toHex(publicKeyFromSecretKey(sk));
  const ts = over.ts ?? now;
  const wallet = over.wallet ?? "otl_esm_testaddress";
  const message = sdkMessage(0x26, wallet, `skydrop-unlock:v1:${id}:${ts}`) as Uint8Array;
  const sig = schnorrSign(sk, message);
  return { ownerKey: over.ownerKey ?? pk, walletAddress: wallet, publicNonce: toHex(sig.public_nonce), signature: toHex(sig.signature), ts, pk };
}

let passed = 0;
const ok = (name: string) => console.log(`[ok] ${name}`) || passed++;

// the verifier's own message builder agrees with the wallet SDK's
assert.deepEqual(walletOwnershipMessage(0x26, "otl_esm_x", "c"), sdkMessage(0x26, "otl_esm_x", "c"));
ok("message builder is byte-identical to the wallet SDK's");

// creating
{
  for (const bad of [{ did: "did:web:x.com" }, { price: "10" }, { price: "999999999999" }, { title: "" }, { title: "x".repeat(81) }, { iv: b64(randomBytes(8)) }, { key: b64(randomBytes(16)) }, { ciphertext: "" }]) {
    assert.equal((await create(bad)).status, 400, JSON.stringify(bad).slice(0, 40));
  }
  ok("rejects malformed gates");
}

const created = await create();
assert.equal(created.status, 200);
const id: string = created.body.id;
assert.match(id, /^[0-9a-f]{32}$/);

{
  const meta = await call(`/api/gate/${id}`, "GET");
  assert.equal(meta.status, 200);
  assert.equal(meta.body.did, DID);
  assert.equal(meta.body.price, "2000000");
  assert.equal("key" in meta.body, false);
  assert.equal(JSON.stringify(meta.body).includes(b64(contentKey)), false);
  ok("public metadata never contains the key");
  assert.equal((await call("/api/gate/" + "0".repeat(32), "GET")).status, 404);
  assert.equal((await call("/api/gate/not-an-id", "GET")).status, 404);
  ok("unknown or malformed ids are 404");
  const page = await call(`/u/${id}`, "GET");
  assert.equal(page.status, 200);
  assert.match(page.body, /Secret/);
  ok("landing page renders");
}

const viewer = secret();
const viewerPk = toHex(publicKeyFromSecretKey(viewer));

{
  now += 1000;
  const r = await call(`/api/unlock/${id}`, "POST", unlockBody(id, viewer));
  assert.equal(r.status, 402);
  ok("no payment -> 402");
}
{
  deposits = [{ sender: toHex(publicKeyFromSecretKey(secret())), amount: 5_000_000, created: 120 }];
  const r = await call(`/api/unlock/${id}`, "POST", unlockBody(id, viewer));
  assert.equal(r.status, 402);
  ok("someone else's payment doesn't unlock for this wallet");
}
{
  deposits = [{ sender: viewerPk, amount: 1_999_999, created: 120 }];
  assert.equal((await call(`/api/unlock/${id}`, "POST", unlockBody(id, viewer))).status, 402);
  ok("underpayment -> 402");
}
{
  deposits = [{ sender: viewerPk, amount: 5_000_000, created: 99 }];
  assert.equal((await call(`/api/unlock/${id}`, "POST", unlockBody(id, viewer))).status, 402);
  ok("a payment made before the post was locked doesn't count");
}
{
  deposits = [{ sender: viewerPk, amount: 5_000_000, created: 120 }];
  const stranger = secret();
  // a stranger quotes the payer's public key but signs with their own secret
  const forged = unlockBody(id, stranger, { ownerKey: viewerPk });
  assert.equal((await call(`/api/unlock/${id}`, "POST", forged)).status, 401);
  ok("a stranger can't borrow someone else's payment (signature must match the paying key)");
}
{
  const stale = unlockBody(id, viewer, { ts: now - 10 * 60_000 });
  assert.equal((await call(`/api/unlock/${id}`, "POST", stale)).status, 400);
  ok("old signatures are refused");
}
{
  const garbage = { ...unlockBody(id, viewer), signature: "00".repeat(32) };
  assert.equal((await call(`/api/unlock/${id}`, "POST", garbage)).status, 401);
  ok("garbage signature -> 401");
}
{
  const r = await call(`/api/unlock/${id}`, "POST", unlockBody(id, viewer));
  assert.equal(r.status, 200);
  assert.equal(r.body.key, b64(contentKey));
  ok("paid + signed by the payer -> key released");
}
{
  deposits = []; // the creator claimed the tip, so the deposit is gone from the escrow
  now += 60_000;
  const r = await call(`/api/unlock/${id}`, "POST", unlockBody(id, viewer));
  assert.equal(r.status, 200);
  ok("stays unlocked after the creator claims the deposit (payment remembered)");
}
{
  const other = secret();
  deposits = [];
  assert.equal((await call(`/api/unlock/${id}`, "POST", unlockBody(id, other))).status, 402);
  ok("a different wallet still can't");
}
{
  // Two posts locked by the same author; one tip that covers either price may unlock only one of them.
  const second = (await create({ title: "Second" })).body.id as string;
  const third = (await create({ title: "Third" })).body.id as string;
  const payer = secret();
  const payerPk = toHex(publicKeyFromSecretKey(payer));
  deposits = [{ sender: payerPk, amount: 5_000_000, created: 120 }];
  now += 1000;
  assert.equal((await call(`/api/unlock/${second}`, "POST", unlockBody(second, payer))).status, 200);
  assert.equal((await call(`/api/unlock/${third}`, "POST", unlockBody(third, payer))).status, 402);
  ok("one payment unlocks one post, not every post the author locked before it");
  // a second, equal payment in the same epoch is a separate payment
  deposits.push({ sender: payerPk, amount: 5_000_000, created: 120 });
  assert.equal((await call(`/api/unlock/${third}`, "POST", unlockBody(third, payer))).status, 200);
  ok("a second equal payment unlocks a second post");
}
{
  // A gift delivered straight to the author's linked wallet counts too; one under another policy doesn't.
  const fourth = (await create({ title: "Fourth" })).body.id as string;
  const fifth = (await create({ title: "Fifth" })).body.id as string;
  const payer = secret();
  const payerPk = toHex(publicKeyFromSecretKey(payer));
  deposits = [];
  otherPolicyDeposits = [{ sender: payerPk, amount: 5_000_000, created: 130 }];
  now += 1000;
  assert.equal((await call(`/api/unlock/${fourth}`, "POST", unlockBody(fourth, payer))).status, 402);
  ok("a deposit governed by another policy doesn't count");
  delivered = [{ sender: payerPk, amount: 5_000_000, created: 130 }];
  assert.equal((await call(`/api/unlock/${fifth}`, "POST", unlockBody(fifth, payer))).status, 200);
  ok("a gift delivered straight to the linked wallet counts");
}

console.log(`\n${passed} checks passed`);
