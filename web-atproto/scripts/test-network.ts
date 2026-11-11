// The automatic move to mainnet. Run with: npx tsx scripts/test-network.ts
import assert from "node:assert/strict";

const g = globalThis as Record<string, unknown>;
g.__SKYDROP_NETWORK__ = "auto";
g.__LAUNCH_MS__ = 1000;

const { DEPLOYMENT } = await import("../src/data/deployment");
const { onMainnet, resetNetworkState } = await import("./../worker/network");

const answering = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const never = (async () => { throw new Error("should not be asked"); }) as unknown as typeof fetch;
const down = (async () => { throw new Error("523"); }) as unknown as typeof fetch;
const MAINNET = { network: "mainnet", network_byte: 0 };

assert.equal(await onMainnet(999, never), false, "waits for launch without asking the indexer");
assert.equal(DEPLOYMENT.walletNetwork, "esmeralda");

assert.equal(await onMainnet(1000, down), false, "stays put if the indexer is down at launch");
assert.equal(await onMainnet(2000, never), false, "does not re-ask within 15 s");
assert.equal(await onMainnet(20_000, answering(MAINNET, 523)), false, "an error status is not live");
assert.equal(await onMainnet(40_000, answering({ network_byte: 38 })), false, "a testnet answer is not mainnet");
assert.equal(DEPLOYMENT.isMainnet, false);

assert.equal(await onMainnet(60_000, answering(MAINNET)), true, "moves once mainnet answers");
assert.equal(DEPLOYMENT.walletNetwork, "mainnet");
assert.equal(DEPLOYMENT.unit, "TARI");
assert.equal(DEPLOYMENT.legacy.length, 0);
assert.equal(await onMainnet(60_001, never), true, "and stays moved without asking again");

resetNetworkState();
console.log("network switch: all passed");
