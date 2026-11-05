/**
 * Checks the site's libraries outside a browser.
 *  - Claim codes and allocation hashes must equal values printed by the Rust contract's own test
 *    (cross_check_vectors_for_the_website in campaigns.rs), or real claims would silently fail.
 *  - The compiled verifier must accept real public Bluesky data and reject tampered data. Needs network.
 */
import type { Spec } from "../src/lib/campaign";
import { DEPLOYMENT } from "../src/data/deployment";
import { createInstruction, lit, phaseOf, readCampaign, readOutcome, specOf } from "../src/lib/chain";
import { settle } from "../src/lib/quests";
import { readFileSync } from "node:fs";
import { encodeOps, fetchProof, latestPost, parseAtUri, pdsOf, plcLog, toTarget } from "../src/lib/atproto";
import { compose } from "../src/lib/compose";
import { assess, totals } from "../src/lib/quests";
import { keyFromAddress } from "../src/lib/wallet";
import { groupsOf, requirementCount, requirementsMet } from "../src/lib/campaign";
import { LIVE_PLACEHOLDER, encodeLive } from "../src/lib/campaign";
import { allocationLeaf, buildAllocationTree, checkAllocation, claimCode, decodeSpec, encodeSpec, exposure, fromHex, fromMicro, newSpec, project, questName, summarize, toHex, toMicro, validate } from "../src/lib/campaign";
import { satisfies } from "../src/lib/check";
import { fieldStr, useWasmBytes, verifyChain, verifyRecord } from "../src/lib/verify";

const ADDRESS = "otl_esm_17tp85g0x8emsjs6tasrphwmkhkcaf9ch7xx6aj9p2a9nx58l4vva9jyffdc8vvaxu55ax3kzdmu6m2k23y640usryeqph63fj2l7vuqu9el5r"; // a public test address, with the key the SDK reports for it
const ADDRESS_KEY = "f2c27a21e63e7709434bec061bbb76bdb1d49717f18daec8a1574b3350ffab19";
let failed = 0;
function ok(cond: unknown, name: string, extra = ""): void {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.log(`  FAIL ${name} ${extra}`);
  }
}

console.log("Contract cross-check");
const COMPONENT = "component_da8cb9392cedc8eed595f27fd58fe322d39a8836f29939062d2af2a4be8f582d";
const DID = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const KEY = fromHex("c2a0394cab5ff3b6b51335386d8fb473cf03db714258bc17a10165783b3cf46c");
ok((await claimCode(COMPONENT, DID, KEY, 0)) === "tari-quest:c494068f8c9036322692eca6be4a3afc", "claim code, round 0");
ok((await claimCode(COMPONENT, DID, KEY, 1)) === "tari-quest:b8a9491c5262fe26ee9c022c980fc2a4", "claim code, round 1");
ok((await claimCode(COMPONENT, DID, KEY, 300)) === "tari-quest:34cf2037a41d05b694d21f0f11acefbb", "claim code, round 300 (two-byte round)");
ok(toHex(await allocationLeaf(DID, 1_000_000n)) === "75906aab2f1586e160757dcdc8057198423375fdc64931151a14f13a55472085", "allocation leaf");
const list = [
  { did: DID, amount: "1000000" },
  { did: "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb", amount: "2500000" },
  { did: "did:plc:cccccccccccccccccccccccc", amount: "7" },
];
const tree = await buildAllocationTree(list);
ok(tree.root === "c4a6dbaf8745d0bb2d06cb13f630d20a62b7827e43801bd1ac1067124a8c56df", "allocation root of three, matches the contract's hashing");

console.log("Allocation trees");
for (const n of [1, 2, 3, 4, 5, 8, 17, 100]) {
  const many = Array.from({ length: n }, (_, i) => ({ did: `did:plc:${String(i).padStart(24, "a")}`, amount: String(i + 1) }));
  const t = await buildAllocationTree(many);
  const all = await Promise.all(many.map((a) => checkAllocation(t.root, a.did, BigInt(a.amount), t.proofs[a.did]!.path)));
  ok(all.every(Boolean), `every proof verifies, ${n} entries`);
  ok(!(await checkAllocation(t.root, many[0]!.did, BigInt(many[0]!.amount) + 1n, t.proofs[many[0]!.did]!.path)), `a changed amount fails, ${n} entries`);
}
let threw = false;
try { await buildAllocationTree([list[0]!, list[0]!]); } catch { threw = true; }
ok(threw, "a duplicate account is refused");

console.log("Terms");
ok(toMicro("1.5") === 1_500_000n && fromMicro(1_500_000n) === "1.5", "amount round trip");
ok(fromMicro(toMicro("1234567.000001")) === "1,234,567.000001", "amount formatting");
threw = false;
try { toMicro("1.1234567"); } catch { threw = true; }
ok(threw, "too many decimals are refused");
const s = newSpec();
ok(validate(s).some((p) => p.level === "error"), "an empty campaign has errors");
s.name = "Test";
s.rules = [{ kind: 0, target: "at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/app.bsky.feed.post/3k" }];
ok(!validate(s).some((p) => p.level === "error"), "a simple campaign is valid");
ok(project(s).maxClaimants === 100n, "pool of 100 at 1 each covers 100 people");
ok(exposure(s).level === "High", "an open campaign is high risk");
ok(exposure({ ...s, rules: [{ kind: 7, target: DID }] }).level === "Low", "a vouch rule is low risk");
ok(exposure({ ...s, rounds: 4 }).level === "Medium", "rounds are medium risk");
const d = decodeSpec(encodeSpec({ ...s, name: "Üñí 🚀" }));
ok(d.name === "Üñí 🚀", "a spec survives the share link, unicode included");
threw = false;
try { decodeSpec(encodeSpec({ ...s, rules: [{ kind: 0, target: "javascript:alert(1)" }] })); } catch { threw = true; }
ok(threw, "a shared link with a bad target is refused");
threw = false;
try { decodeSpec("not-a-spec"); } catch { threw = true; }
ok(threw, "garbage in a link is refused");
ok(project({ ...s, reward: "1000000", budget: "10000000", bonus: "1000000", maxReferrals: 2 }).maxClaimants === 5n, "referral bonus reduces how many the pool covers");

console.log("Campaign sentences");
const P = "at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/app.bsky.feed.post/3k";
const P2 = "at://did:plc:bbbbbbbbbbbbbbbbbbbbbbbb/app.bsky.feed.post/3m";
ok(summarize([{ kind: 0, target: P }, { kind: 1, target: P }, { kind: 4, target: P }]) === "like, repost and comment on this post", "like, repost and comment");
ok(summarize([{ kind: 0, target: P }, { kind: 2, target: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa" }]) === "like this post and follow its author", "follow the post's author");
ok(summarize([{ kind: 0, target: P }, { kind: 4, target: P2 }]) === "like post 1 and comment on post 2", "different posts");
ok(summarize([{ kind: 2, target: "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb" }]) === "follow an account", "follow alone");
ok(questName([0, 1, 4]) === "Like, repost and comment quest", "generated name");
ok(questName([0, 0, 0]) === "3-step quest", "generated name, repeated steps");
const P3 = "at://did:plc:cccccccccccccccccccccccc/app.bsky.feed.post/3n";
ok(summarize([{ kind: 0, target: P }, { kind: 0, target: P2 }, { kind: 0, target: P3 }]) === "like post 1, like post 2 and like post 3", "like post x, y and z");
ok(validate({ ...s, rules: [{ kind: 0, target: P }, { kind: 0, target: P }] }).some((p) => p.level === "warn" && p.text.includes("identical")), "identical steps get a warning");

console.log("Either/or and wording");
const ors = [{ kind: 2 as const, target: DID }, { kind: 0 as const, target: P }, { kind: 1 as const, target: P2, or: true }, { kind: 4 as const, target: P3, or: true }];
ok(groupsOf(ors).join() === "0,1,1,1", "or joins a step to the one before it");
ok(groupsOf([{ kind: 0, target: P, or: true }, { kind: 1, target: P }]).join() === "0,0", "or on the first step means nothing");
ok(groupsOf([{ kind: 0, target: P }, { kind: 1, target: P, or: true }, { kind: 2, target: DID }, { kind: 4, target: P }, { kind: 5, target: P, or: true }]).join() === "1,1,0,2,2", "two separate groups");
ok(requirementCount(ors) === 2, "a group counts once");
ok(requirementsMet(ors, [true, false, true, false]) === 2, "one of the group is enough");
ok(requirementsMet(ors, [false, false, false, false]) === 0, "nothing met");
ok(summarize([{ kind: 0, target: P }, { kind: 1, target: P2, or: true }]) === "like post 1 or repost post 2", "either/or sentence");
ok(summarize([{ kind: 4, target: P, text: "gm" }]) === "comment on this post saying “gm”", "wording sentence");
ok(validate({ ...s, rules: [{ kind: 0, target: P, text: "x" }] }).some((p) => p.level === "error"), "wording on a like is refused");

console.log("Describing a campaign in words");
const A = "https://bsky.app/profile/a.com/post/3aa", B = "https://bsky.app/profile/b.com/post/3bb", C = "https://bsky.app/profile/c.com/post/3cc";
const shape = (t: string) => compose(t).steps.map((x) => `${x.kind}${x.or ? "|" : ""}:${x.raw}${x.text ? `~${x.text}` : ""}`).join(" ");
ok(shape(`Like, repost and comment on ${A}`) === `0:${A} 1:${A} 4:${A}`, "like, repost and comment on one post");
ok(shape(`like ${A} like ${B} like ${C}`) === `0:${A} 0:${B} 0:${C}`, "like post x, like post y, like post z");
ok(shape(`${A} like and retweet`) === `0:${A} 1:${A}`, "verbs after the link, retweet as repost");
ok(shape(`like ${A} or repost ${B}`) === `0:${A} 1|:${B}`, "either/or");
ok(shape(`comment "gm #Ootle" on ${A}`) === `4:${A}~gm #Ootle`, "quoted wording attaches to the comment");
ok(shape(`follow @alice.com and like ${A}`) === `2:alice.com 0:${A}`, "follow a named account");
ok(shape(`like ${A} and follow`) === `0:${A} 2:${A}`, "a bare follow is resolved against the post");
ok(shape(`post "hello world"`) === "3:hello world", "a post with required text");
const money = compose(`like ${A}, 5 tTARI each, pool 500, for 7 days, 4 rounds every 7 days`);
ok(money.reward === "5" && money.budget === "500" && money.days === 7 && money.rounds === 4 && money.roundDays === 7, "reward, pool, window and rounds", JSON.stringify(money));
ok(compose("nothing useful here").steps.length === 0, "no steps from unrelated text");
ok(compose("like and repost").notes.length > 0, "steps with no link say so");

console.log("A participant's standing");
const quest = { ...newSpec(), name: "Q", reward: "2000000", budget: "100000000", rules: [{ kind: 0 as const, target: P }, { kind: 1 as const, target: P }] };
const yes = { status: "met" as const, detail: "" };
const no = { status: "unmet" as const, detail: "not yet" };
const oops = { status: "error" as const, detail: "down" };
ok(assess(quest, DID, [yes, yes]).state === "ready", "all done: ready");
ok(assess(quest, DID, [yes, no]).state === "progress" && assess(quest, DID, [yes, no]).headline === "1 step left.", "one left: in progress");
ok(assess(quest, DID, [yes, oops]).state === "unknown", "a check that failed isn't reported as done or undone");
const eitherQ = { ...quest, rules: [{ kind: 0 as const, target: P }, { kind: 1 as const, target: P, or: true }] };
ok(assess(eitherQ, DID, [no, yes]).state === "ready", "either/or: one is enough");
ok(assess(eitherQ, DID, [no, yes]).steps[0]!.covered, "the other option is marked not needed");
ok(assess(eitherQ, DID, [no, no]).state === "progress", "either/or: neither is in progress");
const listQ = { ...quest, rules: [{ kind: 6 as const, target: "at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/app.bsky.graph.list/3k" }] };
ok(assess(listQ, DID, [no]).state === "blocked", "only a voucher can fix it: blocked");
const mixQ = { ...quest, rules: [{ kind: 6 as const, target: "at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/app.bsky.graph.list/3k" }, { kind: 0 as const, target: P, or: true }] };
ok(assess(mixQ, DID, [no, no]).state === "progress", "a voucher or an action: the action still helps");
const allocQ = { ...quest, rules: [], allocations: [{ did: DID, amount: "7000000" }], root: "ab" };
ok(assess(allocQ, DID, []).state === "ready" && assess(allocQ, DID, []).perRound === 7000000n, "on the list: own amount");
ok(assess(allocQ, "did:plc:zzzzzzzzzzzzzzzzzzzzzzzz", []).state === "blocked", "not on the list: blocked");
const roundQ = { ...quest, rounds: 4 };
ok(assess(roundQ, DID, [yes, yes]).fullAmount === 8000000n, "rounds multiply the full amount");
const tt = totals([assess(quest, DID, [yes, yes]), assess(roundQ, DID, [yes, yes]), assess(quest, DID, [yes, no]), assess(listQ, DID, [no])]);
ok(tt.readyNow === 4000000n && tt.toEarn === 8000000n && tt.readyCount === 2 && tt.progressCount === 1 && tt.blockedCount === 1, "totals add up", JSON.stringify({ ...tt, readyNow: String(tt.readyNow), toEarn: String(tt.toEarn), collected: String(tt.collected) }));

console.log("Wallet addresses");
ok(keyFromAddress(ADDRESS) === ADDRESS_KEY, "address decodes to the SDK's public key");
let bad = false;
try { keyFromAddress(`${ADDRESS.slice(0, -1)}${ADDRESS.endsWith("q") ? "p" : "q"}`); } catch { bad = true; }
ok(bad, "a typo in an address is caught");
bad = false;
try { keyFromAddress("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"); } catch { bad = true; }
ok(bad, "another chain's address is refused");

console.log("Verifier against live Bluesky data");
useWasmBytes(readFileSync(new URL("../public/atp_verify.wasm", import.meta.url)));
const post = await latestPost("bsky.app");
if (!post) throw new Error("couldn't load a live post");
const at = parseAtUri(post.uri)!;
const log = await plcLog(at.did);
const ops = encodeOps(log);
const chain = await verifyChain(at.did, ops);
ok(chain.ok, `real identity chain (${ops.length} ops)`);
if (!chain.ok) process.exit(1);
const proof = await fetchProof(pdsOf(log), at.did, at.collection, at.rkey);
const rec = await verifyRecord(at.did, chain, proof, at.collection, at.rkey);
ok(rec.ok, "real post proof");
ok((await fieldStr(proof.record, ["text"])) === post.text, "signed text equals what the AppView shows");
const flip = (b: Uint8Array) => { const c = b.slice(); c[c.length >> 1]! ^= 1; return c; };
ok(!(await verifyRecord(at.did, chain, { ...proof, record: flip(proof.record) }, at.collection, at.rkey)).ok, "tampered record is rejected");
ok(!(await verifyRecord(at.did, chain, { ...proof, commit: flip(proof.commit) }, at.collection, at.rkey)).ok, "tampered commit is rejected");
ok(!(await verifyRecord("did:plc:ewvi7nxzyoun6zhxrhs64oiz", chain, proof, at.collection, at.rkey)).ok, "another account's DID is rejected");
ok(!(await verifyRecord(at.did, chain, proof, at.collection, "3kaaaaaaaaaaa")).ok, "another record key is rejected");
if (proof.nodes.length) ok(!(await verifyRecord(at.did, chain, { ...proof, nodes: proof.nodes.slice(1) }, at.collection, at.rkey)).ok, "a missing tree node is rejected");
ok(!(await verifyChain("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", ops)).ok, "chain under the wrong DID is rejected");
ok(await satisfies({ kind: 3, target: post.text.slice(0, 5) || " " }, proof.record, at.did) || !post.text, "post-contains rule reads signed text");
ok(!(await satisfies({ kind: 3, target: "\u0000never in any post" }, proof.record, at.did)), "post-contains rule refuses absent text");
ok((await toTarget(`https://bsky.app/profile/bsky.app/post/${at.rkey}`, "post")) === post.uri, "a bsky.app link resolves to the exact at:// target");

console.log("Talking to the contract");
{
  const COMPONENT_ADDR = "component_91ee41196af2f9598f29a102f34c3467d7dc04d6e425ab2ec4d1b314563f94f9";
  // Real bytes recorded from Esmeralda on 2026-11-06.
  const SUBSTATE = "8200818285582040d3f8b2cbb33fc5110ee8fe05c8a66d9238898f08c1a8ba96b3568809a93b7282008082a08200804191820080819771536b7964726f70206c697665207465737478204120636f6e747261637420746573742e204e6f7468696e6720746f207365652e5820f2c27a21e63e7709434bec061bbb76bdb1d49717f18daec8a1574b3350ffab19d88458209105ef345b1d8150f4640222f0fef12dfff24a7327882c47be60be57cdb05006d883582091fdb97ba4f9dff26404eadc3edd7f2076dc25f09ef7ddec8553a04609f1e48dd884582091f4585a5cfadf26b83de60cc5cac57e01b60a73092c24dd1462f0d133ea386dd8805820aba7f01482dfc95a2c84ca120a96959923f34e95e7715bb96dd805e2c3726371810081784661743a2f2f6469643a706c633a6161616161616161616161616161616161616161616161612f6170702e62736b792e666565642e706f73742f336b616161616161616161616181008160810019c3504001000000193251193254000000";
  const VAULT = "82028182820383d883582001010101010101010101010101010101010101010101010101010101010101011a00030d400000";
  const b64 = (hex: string) => Buffer.from(hex, "hex").toString("base64");
  const realFetch = globalThis.fetch;
  const routes: Record<string, unknown> = {
    [`/substates/${COMPONENT_ADDR}`]: { state: { up: { substate: b64(SUBSTATE) } } },
    "/substates/vault_9105ef345b1d8150f4640222f0fef12dfff24a7327882c47be60be57cdb05006": { state: { up: { substate: b64(VAULT) } } },
    "/health": { current_epoch: 12881 },
    "/transactions/rejected/result": { result: { Finalized: { final_decision: "Commit", abort_details: "Execution failure: the campaign has closed", execution_result: "" } } },
    "/transactions/waiting/result": { result: "Pending" },
    "/transactions/accepted/result": { result: { Finalized: { final_decision: "Commit", abort_details: null, execution_result: Buffer.from(Uint8Array.of(0x81, 0xd8, 0x80, 0x58, 0x20, ...new Uint8Array(32).fill(7))).toString("base64") } } },
  };
  globalThis.fetch = (async (url: string) => {
    const path = String(url).replace(DEPLOYMENT.indexer, "");
    return path in routes ? new Response(JSON.stringify(routes[path]), { status: 200 }) : new Response("{}", { status: 404 });
  }) as typeof fetch;

  ok(lit(5n).Literal === "05" && lit(1099511627776n).Literal === "1b0000010000000000", "amounts encode like the SDK's");
  const made = createInstruction({ ...newSpec(), name: "A", rules: [{ kind: 0, target: "at://did:plc:a/app.bsky.feed.post/3k" }, { kind: 1, target: "at://did:plc:a/app.bsky.feed.post/3k", or: true }] }, 100, "f2c27a21e63e7709434bec061bbb76bdb1d49717f18daec8a1574b3350ffab19") as { CallFunction: { address: string; function: string; args: { Literal?: string; Workspace?: { id: number } }[] } };
  const argv = made.CallFunction.args;
  ok(made.CallFunction.function === "create" && argv.length === 18, "create takes all 18 arguments", String(argv.length));
  ok(!made.CallFunction.address.startsWith("template_"), "the template address has no prefix");
  ok(argv[3]!.Literal === `d8805820${DEPLOYMENT.linkRegistry.slice(10)}`, "the registry is a tagged component address");
  ok(argv[8]!.Literal === "820101", "either/or steps share a group");
  ok(argv[17]!.Workspace?.id === 1, "funds come from the slot the wallet leaves them in");
  ok(argv[15]!.Literal === lit(100).Literal, "it opens now");

  const live = await readCampaign(COMPONENT_ADDR);
  ok(live.name === "Skydrop live test" && live.info === "A contract test. Nothing to see.", "reads the name and description");
  ok(live.funder === "f2c27a21e63e7709434bec061bbb76bdb1d49717f18daec8a1574b3350ffab19", "reads the funder");
  ok(live.rules.length === 1 && live.rules[0]!.kind === 0 && live.rules[0]!.target.endsWith("/3kaaaaaaaaaaa"), "reads the rules");
  ok(live.reward === 50000n && live.balance === 200000n && live.rounds === 1, "reads the reward and pool");
  ok(live.openEpoch === 12881 && live.closeEpoch === 12884 && phaseOf(live) === "open", "reads the window");
  ok(live.linkRegistry === DEPLOYMENT.linkRegistry, "reads the registry");
  ok(specOf(live).reward === "50000" && specOf(live).name === "Skydrop live test", "turns chain state into terms");
  const link = decodeSpec(encodeLive(COMPONENT_ADDR, [{ did: "did:plc:a", amount: "5" }]));
  ok(link.component === COMPONENT_ADDR && link.allocations?.length === 1, "a live link carries the address and allocation list");
  const lying = decodeSpec(encodeSpec({ ...newSpec(), name: "A lie", reward: "999000000", budget: "1", component: COMPONENT_ADDR }));
  ok(lying.name === LIVE_PLACEHOLDER && lying.reward !== "999000000", "terms in a live link are ignored, and can't make it fail");
  ok(((): boolean => { try { decodeSpec(encodeSpec({ ...newSpec(), name: "x", component: "component_nope" })); return false; } catch { return true; } })(), "a live link with a bad address is refused");

  routes[`/substates/${COMPONENT_ADDR}`] = { state: { up: { substate: b64(SUBSTATE.replace("40d3f8b2", "deadbeef")) } } };
  ok(await readCampaign(COMPONENT_ADDR).then(() => false, (e: Error) => /isn't a campaign/.test(e.message)), "refuses a component from another template");
  ok(await readCampaign("component_nope").then(() => false, () => true), "refuses a malformed address");

  const rejected = await readOutcome("rejected");
  ok(rejected.state === "rejected" && rejected.reason === "This campaign has closed.", "a final transaction that failed counts as failed", JSON.stringify(rejected));
  ok((await readOutcome("waiting")).state === "pending", "an unfinished transaction is pending");
  const accepted = await readOutcome("accepted");
  ok(accepted.state === "accepted" && accepted.components[0] === `component_${"07".repeat(32)}`, "a good transaction names its components", JSON.stringify(accepted));

  globalThis.fetch = realFetch;
}

console.log("What's left to collect");
{
  const spec: Spec = { ...newSpec(), name: "R", rules: [{ kind: 2, target: "did:plc:x" }], reward: "1000000", rounds: 3 };
  const a = assess(spec, "did:plc:me", [{ status: "met", detail: "" }]);
  const facts = { roundsPaid: 0, rounds: 3, phase: "open" as const, waitEpochs: 0, waitText: "soon", funded: true };
  ok(settle(a, facts).state === "ready", "unclaimed and open: ready");
  const one = settle(a, { ...facts, roundsPaid: 1, waitEpochs: 5 });
  ok(one.state === "waiting" && one.paid === 1000000n, "paid once, next round not open: waiting");
  ok(settle(a, { ...facts, roundsPaid: 1 }).state === "ready", "next round open: ready again");
  ok(settle(a, { ...facts, roundsPaid: 3 }).state === "claimed", "every round paid: finished");
  ok(settle(a, { ...facts, phase: "closed" }).state === "over", "closed: over");
  ok(settle(a, { ...facts, funded: false }).state === "over", "pool empty: over");
  ok(settle(a, { ...facts, phase: "upcoming", waitEpochs: 3 }).state === "waiting", "not open yet: waiting");
  const t = totals([one, settle(a, { ...facts, roundsPaid: 1 })]);
  ok(t.collected === 2000000n && t.readyNow === 1000000n && t.toEarn === 3000000n, "totals: collected, ready and still possible", String(t.toEarn));
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
