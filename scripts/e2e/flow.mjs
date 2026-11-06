// Fund and claim in a real browser, against a mock wallet. Chain reads use bytes recorded from the real test campaign,
// so nothing here spends anything. The mock is the wallet's RPC surface, not the real extension.
import { createHash } from "node:crypto";
import puppeteer from "puppeteer-core";

const CREATOR = process.argv[2] || "http://localhost:5196";
const SKYDROP = process.argv[3] || "http://localhost:5198/quests.html";
const INDEXER = "https://ootle-indexer-a.tari.com";
const DEPLOY_REGISTRY = "component_5825a4a3f5c5703a051f46e3c390b62165e8b3029e9148f39f2a54ebe12c2918";
const OUT = new URL("./prod-shots/", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new", args: ["--no-sandbox"] });
let failed = 0;
const check = (c, name, extra = "") => { console.log(`${c ? "  ok  " : " FAIL "} ${name}${extra ? ` (${extra})` : ""}`); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ADDRESS = "otl_esm_17tp85g0x8emsjs6tasrphwmkhkcaf9ch7xx6aj9p2a9nx58l4vva9jyffdc8vvaxu55ax3kzdmu6m2k23y640usryeqph63fj2l7vuqu9el5r";
const KEY = "f2c27a21e63e7709434bec061bbb76bdb1d49717f18daec8a1574b3350ffab19";
const COMPONENT = "component_91ee41196af2f9598f29a102f34c3467d7dc04d6e425ab2ec4d1b314563f94f9";
const VAULT_ID = "vault_9105ef345b1d8150f4640222f0fef12dfff24a7327882c47be60be57cdb05006";
const RECEIPTS = "91fdb97ba4f9dff26404eadc3edd7f2076dc25f09ef7ddec8553a04609f1e48d";
const SUBSTATE = "8200818285582040d3f8b2cbb33fc5110ee8fe05c8a66d9238898f08c1a8ba96b3568809a93b7282008082a08200804191820080819771536b7964726f70206c697665207465737478204120636f6e747261637420746573742e204e6f7468696e6720746f207365652e5820f2c27a21e63e7709434bec061bbb76bdb1d49717f18daec8a1574b3350ffab19d88458209105ef345b1d8150f4640222f0fef12dfff24a7327882c47be60be57cdb05006d883582091fdb97ba4f9dff26404eadc3edd7f2076dc25f09ef7ddec8553a04609f1e48dd884582091f4585a5cfadf26b83de60cc5cac57e01b60a73092c24dd1462f0d133ea386dd8805820aba7f01482dfc95a2c84ca120a96959923f34e95e7715bb96dd805e2c3726371810081784661743a2f2f6469643a706c633a6161616161616161616161616161616161616161616161612f6170702e62736b792e666565642e706f73742f336b616161616161616161616181008160810019c3504001000000193251193254000000";
const VAULT = "82028182820383d883582001010101010101010101010101010101010101010101010101010101010101011a00030d400000";
const b64 = (hex) => Buffer.from(hex, "hex").toString("base64");
const sha = (x) => createHash("sha256").update(x).digest();
const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

const OLD_RULE = "810081784661743a2f2f6469643a706c633a6161616161616161616161616161616161616161616161612f6170702e62736b792e666565642e706f73742f336b616161616161616161616181008160810019c350";
function withPostRule(words) {
  const text = Buffer.from(words);
  if (text.length >= 24) throw new Error("test text too long");
  const item = Buffer.concat([Buffer.from([0x60 | text.length]), text]).toString("hex");
  if (!SUBSTATE.includes(OLD_RULE)) throw new Error("recorded layout changed");
  return SUBSTATE.replace(OLD_RULE, `810381${item}81008160810019c350`);
}

/** Answers indexer reads from `routes`. Anything else goes to the real network. */
async function openPage(routes, connected = true, width = 1280) {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 1000 });
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const u = req.url();
    if (u.startsWith(INDEXER)) {
      const path = u.slice(INDEXER.length).split("?")[0];
      if (routes && path in routes) {
        const v = routes[path];
        return req.respond({ status: v === null ? 404 : 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(v ?? {}) });
      }
    }
    return req.continue();
  });
  await page.evaluateOnNewDocument((addr, on) => {
    window.__calls = [];
    window.__approve = "approved";
    const handler = async ({ method, params }) => {
      window.__calls.push({ method, params });
      switch (method) {
        case "tari_getAccounts": return on ? ["component_60af8d885a000f52cbde41475c426f7ee8beb270cfb7687238b2c97bcd03b311"] : [];
        case "tari_requestAccounts": return ["component_60af8d885a000f52cbde41475c426f7ee8beb270cfb7687238b2c97bcd03b311"];
        case "tari_getWalletAddress": return addr;
        case "tari_getNetwork": return "esmeralda";
        case "tari_getBalances": return [{ resourceAddress: "resource_0101010101010101010101010101010101010101010101010101010101010101", amount: "12500000" }];
        case "tari_createTransactionRequest": return { requestId: "r1" };
        case "tari_getTransactionRequest": return { status: window.__approve };
        case "tari_submitTransactionRequest": return { transactionId: "feedface" };
        case "tari_signAndSubmitTransaction": if (window.__dryFail) { window.__dryFail = false; throw new Error("that referrer has used all its referrals"); } return { result: {} };
        default: throw new Error(`mock: ${method}`);
      }
    };
    window.tari = { info: { name: "Sapient" }, request: handler };
    window.tariProviders = [window.tari];
  }, ADDRESS, connected);
  return page;
}
const m_type = async (pg, text) => {
  await pg.$eval("input[aria-label='Your Bluesky handle']", (e) => { e.value = ""; });
  await pg.type("input[aria-label='Your Bluesky handle']", text);
};
const text = (page, sel = "main") => page.$eval(sel, (e) => e.textContent);
const clickByText = async (page, label) => {
  const ok = await page.evaluate((l) => { const b = [...document.querySelectorAll("button,a.btn")].find((x) => x.textContent.includes(l) && !x.disabled); if (b) b.click(); return !!b; }, label);
  if (!ok) throw new Error(`no button "${label}"`);
};
const waitText = async (page, needle, ms = 25000, sel = "body") => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if ((await page.$eval(sel, (e) => e.textContent).catch(() => "")).includes(needle)) return true;
    await sleep(250);
  }
  return false;
};

const CHAIN = {
  [`/substates/${COMPONENT}`]: { state: { up: { substate: b64(SUBSTATE) } } },
  [`/substates/${VAULT_ID}`]: { state: { up: { substate: b64(VAULT) } } },
  "/health": { current_epoch: 12881, status: "ok", version: "0.49.1" },
};
const accepted = { result: { Finalized: { final_decision: "Commit", abort_details: null, execution_result: b64(`81d8805820${COMPONENT.slice(10)}`) } } };
const rejected = { result: { Finalized: { final_decision: "Commit", abort_details: "Execution failure: the campaign has closed", execution_result: "" } } };

const BSKY = "did:plc:z72i7hdynmk6r22z27h6tvur";
const feed = (await (await fetch(`https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${BSKY}&limit=40&filter=posts_no_replies`)).json()).feed.filter((f) => f.post.author.did === BSKY);
const words = feed.map((f) => f.post.record.text.split(/\s+/)[0]).find((w) => w && w.length >= 3 && w.length < 20 && /^[\x20-\x7e]+$/.test(w));
const post = `at://${BSKY}/app.bsky.feed.post/${feed[0].post.uri.split("/").pop()}`;
const spec = { v: 1, name: "Launch test", about: "", rules: [{ kind: 0, target: post }], reward: "1000000", budget: "5000000", rounds: 1, roundDays: 7, bonus: "0", maxReferrals: 0, startsInDays: 0, days: 14 };

console.log("Launching from the builder");
{
  const page = await openPage({ ...CHAIN, "/transactions/feedface/result": accepted });
  await page.goto(`${CREATOR}/campaigns/new#${enc(spec)}`, { waitUntil: "networkidle2" });
  check(await waitText(page, "Fund and launch: 5 tTARI"), "the builder offers to fund it, for the right amount");
  await page.screenshot({ path: `${OUT}flow_launch.png`, fullPage: true });
  await clickByText(page, "Fund and launch");
  await page.waitForFunction(() => location.pathname.startsWith("/c/component_"), { timeout: 25000 }).catch(() => {});
  check(page.url().includes(`/c/${COMPONENT}`), "after approval it lands on the live campaign", page.url());
  await page.close();

  // a second page to inspect exactly what was asked of the wallet: the first one navigated away
  const p2 = await openPage({ ...CHAIN, "/transactions/feedface/result": rejected });
  await p2.goto(`${CREATOR}/campaigns/new#${enc(spec)}`, { waitUntil: "networkidle2" });
  await waitText(p2, "Fund and launch");
  await clickByText(p2, "Fund and launch");
  check(await waitText(p2, "This campaign has closed."), "a refused transaction is reported as refused, in plain words");
  check(!p2.url().includes("/c/component_"), "and doesn't pretend it launched");
  const req = (await p2.evaluate(() => window.__calls)).find((c) => c.method === "tari_createTransactionRequest")?.params;
  const f = req?.followUpInstructions?.[0]?.CallFunction;
  check(req?.kind === "withdrawStealthAndExecute" && req.amount === "5000000", "the wallet is asked to move exactly the pool");
  check(f?.function === "create" && f.args.length === 18, "with a create call holding every argument");
  check(req?.relatedComponents?.length === 1 && req.relatedComponents[0].startsWith("component_"), "and the registry declared as an input");
  await p2.evaluate(() => { window.__approve = "rejected"; });
  await clickByText(p2, "Fund and launch");
  check(await waitText(p2, "You declined"), "declining in the wallet is reported");
  check(p2.errors.length === 0, "no page errors", p2.errors.join(" | ").slice(0, 200));
  await p2.close();
}

console.log("The live campaign page");
{
  const page = await openPage(CHAIN);
  await page.goto(`${CREATOR}/c/${COMPONENT}`, { waitUntil: "networkidle2" });
  check(await waitText(page, "Skydrop live test"), "shows the name from the contract");
  const t = await text(page);
  check(t.includes("0.2 tTARI") && t.includes("0.05 tTARI"), "shows the pool and reward");
  check(t.includes("Manage your campaign"), "the funder gets the controls");
  check(t.includes("Available once it closes"), "and is told funds stay locked until it closes");
  check(await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.startsWith("Take back"))?.disabled), "the take-back button is disabled while open");
  await page.screenshot({ path: `${OUT}flow_live.png`, fullPage: true });
  await page.close();

  const stranger = await openPage(CHAIN, false);
  await stranger.goto(`${CREATOR}/c/${COMPONENT}`, { waitUntil: "networkidle2" });
  await waitText(stranger, "Skydrop live test");
  check(!(await text(stranger)).includes("Manage your campaign"), "someone else doesn't see the controls");
  await stranger.close();

  const fake = await openPage({ [`/substates/${COMPONENT}`]: { state: { up: { substate: b64(SUBSTATE.replace("40d3f8b2", "deadbeef")) } } } });
  await fake.goto(`${CREATOR}/c/${COMPONENT}`, { waitUntil: "networkidle2" });
  check(await waitText(fake, "isn't a campaign made with this contract"), "a look-alike contract is refused");
  await fake.close();

  const phone = await openPage(CHAIN, true, 375);
  await phone.goto(`${CREATOR}/c/${COMPONENT}`, { waitUntil: "networkidle2" });
  await waitText(phone, "Skydrop live test");
  check((await phone.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0, "no sideways scroll on a phone");
  await phone.screenshot({ path: `${OUT}flow_live_phone.png`, fullPage: true });
  await phone.close();
}

console.log("My campaigns, from the real network");
{
  const page = await openPage(null);
  await page.goto(`${CREATOR}/me`, { waitUntil: "networkidle2" });
  check(await waitText(page, "Skydrop live test", 40000), "lists the campaign this wallet really funded");
  await page.close();
}

console.log("Claiming on Skydrop");
{
  const did = BSKY;
  const nft = `/substates/nft_${RECEIPTS}_uuid_${sha(did).toString("hex")}`;
  const qk = `/substates/${COMPONENT}`;
  const live = { ...CHAIN, [qk]: { state: { up: { substate: b64(withPostRule(words)) } } }, [nft]: null };
  const link = (o) => `${SKYDROP}#add=${enc(o)}`;
  const shown = { ...spec, name: "A lie in the link", reward: "999000000", component: COMPONENT };
  const page = await openPage(live);
  await page.goto(link(shown), { waitUntil: "networkidle2" });
  await m_type(page, "bsky.app");
  await page.keyboard.press("Enter");
  check(await waitText(page, "Ready to claim", 40000), "a met step shows as ready");
  const t = await text(page);
  check(t.includes("Skydrop live test") && !t.includes("A lie in the link"), "the name comes from the chain, not the link");
  check(!t.includes("Preview"), "a live campaign is never labelled a preview");
  check(t.includes("0.05 tTARI") && !t.includes("999"), "and so does the reward");
  await page.screenshot({ path: `${OUT}flow_ready.png`, fullPage: true });
  await clickByText(page, "Collect 0.05");
  check(await waitText(page, "tari-quest:", 40000), "collecting asks for the post that ties it to the wallet");
  const body = await text(page);
  const code = body.match(/tari-quest:[0-9a-f]{32}/)?.[0];
  const expected = `tari-quest:${sha(Buffer.concat([Buffer.from(`tari-campaign:v1:${COMPONENT}:${did}:`), Buffer.from(KEY, "hex"), Buffer.from(":"), Buffer.from([0, 0])])).subarray(0, 16).toString("hex")}`;
  check(code === expected, "the code matches the contract's formula", code);
  check(await page.evaluate(() => [...document.querySelectorAll("a")].some((a) => a.href.includes("bsky.app/intent/compose") && a.href.includes("tari-quest"))), "with a link to post it");
  check(await page.$eval(".qclaim pre", (e) => e.scrollWidth <= e.clientWidth), "the whole post is readable, with nothing cut off");
  await page.screenshot({ path: `${OUT}flow_post.png`, fullPage: true });
  await clickByText(page, "I've posted it");
  check(await waitText(page, "I've posted it"), "if the post isn't there yet it keeps asking, without spending");
  check(!(await page.evaluate(() => window.__calls.some((c) => c.method === "tari_createTransactionRequest"))), "nothing has been sent to the wallet");
  check(page.errors.length === 0, "no page errors", page.errors.join(" | ").slice(0, 200));
  await page.close();

  // A real receipt, as minted by the live test.
  const realDid = "did:plc:7aomkseowdwpqev24us5xtmw";
  const rid = `/substates/nft_${RECEIPTS}_uuid_${sha(realDid).toString("hex")}`;
  const raw = await (await fetch(INDEXER + rid)).json();
  check(!!raw?.state?.up?.substate, "fetched the real receipt to test with");
  const paid = await openPage({ ...live, [nft]: raw });
  await paid.goto(`${SKYDROP}#add=${enc(shown)}`, { waitUntil: "networkidle2" });
  await m_type(paid, "bsky.app");
  await paid.keyboard.press("Enter");
  check(await waitText(paid, "Finished", 40000), "once paid it moves to Finished");
  const pt = await text(paid);
  check(pt.includes("Collected") && pt.includes("You've collected everything"), "and says what was collected");
  check(!pt.includes("Collect 0.05"), "and can't be collected twice");
  check(await paid.$eval(".qstamp", (e) => e.textContent === "Collected").catch(() => false), "and is stamped as collected");
  await paid.screenshot({ path: `${OUT}flow_done.png`, fullPage: true });
  await paid.close();

  const tracked = await openPage({ ...live, [qk]: { state: { up: { substate: b64(withPostRule(words).replace("193254", "193252")) } } }, "/health": { current_epoch: 12999 } });
  await tracked.goto(`${SKYDROP}#add=${enc(shown)}`, { waitUntil: "networkidle2" });
  await m_type(tracked, "bsky.app");
  await tracked.keyboard.press("Enter");
  check(await waitText(tracked, "has closed", 40000), "a closed campaign says so");
  check(!(await text(tracked)).includes("Collect 0.05"), "and offers nothing to collect");
  await tracked.close();
}

console.log("Linked wallets and invites, through to the transaction");
{
  const REG_RECORDS = "ab2f7be5c40fb5da3263bcaab4213417785bee253e43e96f46449e3871fcf096";
  const REF_RECEIPTS = "18b64107e00ed599e2da7138faaa488338f57cdc75e139fc7ee737a2b18cc1ca";
  const REF = "did:plc:52yjtwdzw4cpifjtvfnrnnvm";
  const OTHER_ACCOUNT = "217fc26410d1d2d6bd1cb18a36f4268ae6a2792348e5e93429642ca59265af4b";
  const OWN_ACCOUNT = "60af8d885a000f52cbde41475c426f7ee8beb270cfb7687238b2c97bcd03b311";
  const recordId = (d) => `/substates/nft_${REG_RECORDS}_uuid_${sha(d).toString("hex")}`;
  // The old campaign claims through its own registry. The page's "wallet linked" line reads the current one.
  const newReg = await (await fetch(`${INDEXER}/substates/${DEPLOY_REGISTRY}`)).json();
  const NEW_RECORDS = Buffer.from(newReg.state.up.substate, "base64").toString("hex").match(/8800d8835820([0-9a-f]{64})/)[1];
  const newId = (d) => `/substates/nft_${NEW_RECORDS}_uuid_${sha(d).toString("hex")}`;
  const realRecord = await (await fetch(`${INDEXER}/substates/nft_${REG_RECORDS}_uuid_76b7e206467ac13ea33fdfd642ea2158056a77cccf7838e9088c336937a21c24`)).json();
  const realReceipt = await (await fetch(`${INDEXER}/substates/nft_${REF_RECEIPTS}_uuid_${sha(REF).toString("hex")}`)).json();
  check(!!realRecord?.state?.up?.substate && !!realReceipt?.state?.up?.substate, "fetched a real link record and a real receipt to test with");
  const recordHex = Buffer.from(realRecord.state.up.substate, "base64").toString("hex");
  const ownRecord = { state: { up: { substate: b64(recordHex.replace(OTHER_ACCOUNT, OWN_ACCOUNT)) } } };
  // The same link, owned by the key of the wallet connected here, which is the only key that may name an inviter.
  const keys = [...recordHex.matchAll(/5820([0-9a-f]{64})/g)].map((m) => m[1]);
  const keyedRecord = { state: { up: { substate: b64(recordHex.split(keys[2]).join(KEY)) } } };
  const terms = "19c3504001000000193251193254";
  const base = withPostRule(words);
  if (!base.includes(terms)) throw new Error("recorded terms changed");
  const withBonus = base.replace(terms, "19c35040010"+"0194e2005193251193fff");
  const routes = { ...CHAIN, "/health": { current_epoch: 12900, status: "ok" }, [`/substates/${COMPONENT}`]: { state: { up: { substate: b64(withBonus) } } }, [`/substates/nft_${RECEIPTS}_uuid_${sha(BSKY).toString("hex")}`]: null, [`/substates/nft_${RECEIPTS}_uuid_${sha(REF).toString("hex")}`]: realReceipt, [recordId(BSKY)]: realRecord, [newId(BSKY)]: realRecord, "/transactions/feedface/result": accepted, "/transactions/events": { events: [] } };
  const live = Buffer.from(JSON.stringify({ v: 1, name: "", rules: [], component: COMPONENT })).toString("base64url");
  const visit = async (r, ref) => {
    const p = await openPage(r);
    await p.goto(SKYDROP, { waitUntil: "domcontentloaded" });
    await p.evaluate(() => localStorage.clear());
    await p.goto("about:blank");
    await p.goto(`${SKYDROP}#add=${live}${ref ? `&ref=${ref}` : ""}`, { waitUntil: "networkidle2" });
    await m_type(p, "bsky.app");
    await p.keyboard.press("Enter");
    return p;
  };

  const owned = { ...routes, [recordId(BSKY)]: keyedRecord, [newId(BSKY)]: keyedRecord };
  const p = await visit(owned, REF);
  check(await waitText(p, "Wallet linked.", 40000), "a linked account is told so");
  check(await waitText(p, "Link the connected wallet instead"), "and offered the connected wallet when it's a different one");
  check(await waitText(p, "Ready to claim"), "the campaign is ready");
  check(await waitText(p, "You were invited."), "and shows the invite");
  check(!(await text(p)).includes("Post once"), "the progress has no post stage");
  await clickByText(p, "Collect 0.05");
  check(await waitText(p, "Your wallet is linked, so no post is needed.", 40000), "collecting needs no post");
  check(!(await text(p)).includes("tari-quest:"), "and shows no claim code");
  check((await text(p)).includes(`It pays your linked wallet, component_21`), "it says the payout goes to the linked wallet, not the connected one");
  check((await text(p)).includes("They get 0.02 tTARI from the campaign's pool when you collect. Your reward stays the same."), "and that the inviter's bonus isn't taken from the reward");
  check((await text(p)).split("from the campaign's pool").length === 2, "and says it only once");
  check((await text(p)).includes("network fee of about 0.03 tTARI"), "with the lower fee a linked claim really costs");
  await p.screenshot({ path: `${OUT}link_ready.png`, fullPage: true });

  // Someone used the inviter's last invite just now: checking costs nothing, so the claim goes on without it.
  await p.evaluate(() => { window.__dryFail = true; });
  await p.evaluate(() => [...document.querySelectorAll(".qclaim button")].find((b) => b.textContent.startsWith("Collect")).click());
  check(await waitText(p, "That invite can't be used any more."), "an invite that fails its check is dropped, with a note");
  check(await waitText(p, "Your wallet is linked, so no post is needed."), "and the claim is offered again");
  await sleep(500);
  check(!(await text(p)).includes("You were invited"), "without the invite");
  check(!(await p.evaluate(() => window.__calls.some((c) => c.method === "tari_createTransactionRequest"))), "nothing was sent for that attempt");
  check(!(await p.evaluate(() => localStorage.getItem("skydrop-refs") ?? "")).includes(REF), "and it's forgotten");
  await p.close();

  // Another wallet can still send the claim, as a relayer would, but it can't name the inviter.
  const relay = await visit(routes, REF);
  await waitText(relay, "Ready to claim", 40000);
  await waitText(relay, "You were invited.");
  await clickByText(relay, "Collect 0.05");
  await waitText(relay, "Your wallet is linked, so no post is needed.", 40000);
  check((await text(relay)).includes("Your invite only counts if the linked wallet sends this claim."), "another wallet is told the invite won't count");
  await relay.evaluate(() => [...document.querySelectorAll(".qclaim button")].find((b) => b.textContent.startsWith("Collect")).click());
  check(await waitText(relay, "Collected 0.05 tTARI", 40000), "and its claim goes through");
  const relayed = JSON.stringify(await relay.evaluate(() => window.__calls.find((c) => c.method === "tari_createTransactionRequest")?.params));
  check(relayed.includes("claim_linked") && !relayed.includes(`nft_${RECEIPTS}_uuid_${sha(REF).toString("hex")}`), "without naming the inviter");
  await relay.close();

  const q = await visit(owned, REF);
  await waitText(q, "Ready to claim", 40000);
  await waitText(q, "You were invited.");
  await clickByText(q, "Collect 0.05");
  await waitText(q, "Your wallet is linked, so no post is needed.", 40000);
  await q.evaluate(() => [...document.querySelectorAll(".qclaim button")].find((b) => b.textContent.startsWith("Collect")).click());
  check(await waitText(q, "Collected 0.05 tTARI", 40000), "a linked claim goes through");
  const req = await q.evaluate(() => window.__calls.find((c) => c.method === "tari_createTransactionRequest")?.params);
  const sent = JSON.stringify(req);
  check(sent.includes("claim_linked"), "using claim_linked");
  check(!sent.includes('"claim"'), "not the post-based claim");
  check(sent.includes(`component_${OTHER_ACCOUNT}`), "declaring the linked account as an input");
  check(sent.includes(`nft_${RECEIPTS}_uuid_${sha(REF).toString("hex")}`), "and the inviter's receipt");
  check(sent.includes(`nft_${REG_RECORDS}_uuid_${sha(BSKY).toString("hex")}`), "and this account's link record");
  check(q.errors.length === 0, "no page errors", q.errors.join(" | ").slice(0, 200));
  await q.close();

  const r = await visit(routes, null);
  await waitText(r, "Ready to claim", 40000);
  await clickByText(r, "Collect 0.05");
  await waitText(r, "Your wallet is linked, so no post is needed.", 40000);
  await clickByText(r, "Pay this wallet instead");
  check(await waitText(r, "tari-quest:", 40000), "someone can still choose the connected wallet, with a post");
  await r.close();

  const own = await visit({ ...routes, [recordId(BSKY)]: ownRecord, [newId(BSKY)]: ownRecord }, null);
  check(await waitText(own, "Wallet linked.", 40000), "linked to the connected wallet");
  check(!(await text(own)).includes("Link the connected wallet instead"), "there's nothing to switch");
  await waitText(own, "Ready to claim", 40000);
  await clickByText(own, "Collect 0.05");
  await waitText(own, "Your wallet is linked, so no post is needed.", 40000);
  check(!(await text(own)).includes("It pays your linked wallet"), "and no warning about where it goes");
  await own.close();

  const none = await visit({ ...routes, [recordId(BSKY)]: null, [newId(BSKY)]: null }, null);
  check(await waitText(none, "Skip the post.", 40000), "an unlinked account is offered a link");
  await clickByText(none, "Link a wallet");
  check(await waitText(none, "tari-bind:", 40000), "linking asks for a post");
  const code = (await text(none)).match(/tari-bind:[0-9a-f]{32}/)?.[0];
  const expected = `tari-bind:${sha(Buffer.concat([Buffer.from(`tari-bsky-bind:v1:${DEPLOY_REGISTRY}:${BSKY}:component_${OWN_ACCOUNT}:`), Buffer.from(KEY, "hex")])).subarray(0, 16).toString("hex")}`;
  check(code === expected, "with the code the contract expects", code);
  check((await text(none)).includes("The link is public"), "and says the link is public");
  await none.screenshot({ path: `${OUT}link_post.png`, fullPage: true });
  await none.setViewport({ width: 390, height: 844 });
  await sleep(200);
  check(await none.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "linking fits a phone with no sideways scrolling");
  await none.screenshot({ path: `${OUT}link_phone.png`, fullPage: true });
  await none.setViewport({ width: 1280, height: 1000 });
  await clickByText(none, "I've posted it");
  check(await waitText(none, "tari-bind:", 30000), "if the post isn't there it keeps asking, without spending");
  check(!(await none.evaluate(() => window.__calls.some((c) => c.method === "tari_createTransactionRequest"))), "nothing has been sent");
  await clickByText(none, "Not now");
  check(await waitText(none, "Skip the post."), "and someone can back out");
  await clickByText(none, "Collect 0.05");
  check(await waitText(none, "Link your wallet to skip this", 40000), "the claim's post step offers the link too");
  check(none.errors.length === 0, "no page errors", none.errors.join(" | ").slice(0, 200));
  await none.close();
}

console.log("Finding campaigns");
{
  const cborText = (s) => { const b = Buffer.from(s); return Buffer.concat([Buffer.from(b.length < 24 ? [0x60 | b.length] : [0x78, b.length]), b]).toString("hex"); };
  const TEMPLATE = "40d3f8b2cbb33fc5110ee8fe05c8a66d9238898f08c1a8ba96b3568809a93b72";
  const claim = `8482008${"1"}d8805820${COMPONENT.slice(10)}5820${TEMPLATE}${cborText("Campaign.campaign.claim")}d881a2${cborText("did")}${cborText(BSKY)}${cborText("round")}${cborText("0")}`;
  const routes = { ...CHAIN, [`/substates/nft_${RECEIPTS}_uuid_${sha(BSKY).toString("hex")}`]: null, "/transactions/events": { events: [["feedface", b64(claim.replace(Buffer.from(BSKY).toString("hex"), Buffer.from("did:plc:zzzzzzzzzzzzzzzzzzzzzzzz").toString("hex")))]] } };
  const fresh = async (pg, url) => {
    await pg.goto(SKYDROP, { waitUntil: "domcontentloaded" });
    await pg.evaluate(() => localStorage.clear());
    await pg.goto("about:blank");
    await pg.goto(url, { waitUntil: "networkidle2" });
  };
  const page = await openPage(routes);
  await fresh(page, SKYDROP);
  check(await waitText(page, "Open campaigns"), "shows open campaigns with an empty list");
  check(await waitText(page, "Skydrop live test"), "read from the chain");
  check(await waitText(page, "after the network fee"), "shows what a reward is worth after the fee");
  await clickByText(page, "Add to my quests");
  check(await waitText(page, "Added “Skydrop live test”", 8000, ".qtoast"), "adding it says so where you can see it");
  check(await waitText(page, "Skydrop live test", 8000, ".qcard h3"), "it moves to your list");
  await clickByText(page, "Remove");
  check(await waitText(page, "Undo", 4000, ".qtoast"), "removing one offers an undo");
  await clickByText(page, "Undo");
  check(await waitText(page, "Skydrop live test", 4000, ".qcard h3"), "and the undo brings it back");
  await m_type(page, "alice");
  await page.keyboard.press("Enter");
  check(await waitText(page, "alice.bsky.social", 15000, ".who"), "a bare name is taken as name.bsky.social");
  await clickByText(page, "Not you?");
  check((await page.$eval("input[aria-label='Your Bluesky handle']", (e) => e.value)) === "", "and “Not you?” clears it");
  await page.close();

  routes["/transactions/events"] = { events: [["feedface", b64(claim)]] };
  const mine = await openPage(routes);
  await fresh(mine, SKYDROP);
  await m_type(mine, "bsky.app");
  await mine.keyboard.press("Enter");
  check(await waitText(mine, "you've collected from", 30000, ".qtoast"), "finds campaigns you've collected from, with nothing added by hand");
  check(await waitText(mine, "Skydrop live test", 30000), "and tracks them");
  check(mine.errors.length === 0, "no page errors", mine.errors.join(" | ").slice(0, 200));
  await mine.close();

  // back from Bluesky: it checks again by itself
  const live2 = { ...CHAIN, [`/substates/nft_${RECEIPTS}_uuid_${sha(BSKY).toString("hex")}`]: null, "/transactions/events": { events: [] } };
  const back = await openPage(live2);
  await fresh(back, `${SKYDROP}#add=${enc({ v: 1, name: "", rules: [], component: COMPONENT })}`);
  await m_type(back, "bsky.app");
  await back.keyboard.press("Enter");
  check(await waitText(back, "Not done yet", 30000), "an unmet step says so plainly");
  check(await back.$(".qflow li.now") !== null, "and the three-step bar shows where you are");
  let reads = 0;
  back.on("request", (r) => { if (r.url().includes(`/substates/${COMPONENT}`)) reads++; });
  await sleep(13000);
  await back.evaluate(() => window.dispatchEvent(new Event("focus")));
  await sleep(2500);
  check(reads > 0, "coming back to the tab checks again, with nothing to press", String(reads));
  await m_type(back, "nobody-here-zzqq.bsky.social");
  check(await back.$eval(".qform button", (b) => b.textContent === "Show my quests"), "typing a new handle changes the button from Refresh");
  await back.keyboard.press("Enter");
  check(await waitText(back, "No Bluesky account", 15000), "an unknown handle says so");
  check(!(await text(back)).includes("Not done yet"), "and doesn't leave the last account's progress on screen");
  await back.close();

  const phone = await openPage(CHAIN, false, 375);
  await phone.goto(SKYDROP.replace(/\/quests(\.html)?$/, "/"), { waitUntil: "networkidle2" });
  check(await waitText(phone, "Get rewarded"), "the home page leads with rewards");
  check((await phone.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0, "with no sideways scroll on a phone");
  check(!(await phone.evaluate(() => [...document.querySelectorAll("a")].some((a) => a.getAttribute("href") === "#/send"))), "and no link to a form that can't finish");
  await m_type(phone, "bsky.app");
  await phone.keyboard.press("Enter");
  await phone.waitForFunction(() => location.pathname.startsWith("/quests"), { timeout: 15000 }).catch(() => {});
  check(await waitText(phone, "@bsky.app", 20000), "and its form goes straight to your quests");
  await phone.close();

  console.log("Suggestions, the fee, language and theme");
  const sug = await openPage(CHAIN, false);
  await sug.goto(`${SKYDROP.replace(/\/quests(\.html)?$/, "/")}`, { waitUntil: "networkidle2" });
  await sug.waitForSelector("input[aria-label='Your Bluesky handle']", { timeout: 20000 });
  await sug.type("input[aria-label='Your Bluesky handle']", "bsky.ap");
  check(await sug.waitForSelector(".suggestitem", { timeout: 8000 }).then(() => true, () => false), "typing suggests real accounts");
  check(await sug.$eval("input[aria-label='Your Bluesky handle']", (e) => e.getAttribute("aria-expanded") === "true" && e.getAttribute("role") === "combobox"), "and says so to screen readers");
  await sug.keyboard.press("ArrowDown");
  check(await sug.$eval("input[aria-label='Your Bluesky handle']", (e) => !!document.getElementById(e.getAttribute("aria-activedescendant") ?? "")), "arrow keys move through them");
  await sug.keyboard.press("Escape");
  check(await sug.$eval(".suggest", (e) => e.hidden), "Escape closes them");
  await sug.close();

  const pickIt = await openPage(CHAIN, false);
  await pickIt.goto(SKYDROP, { waitUntil: "networkidle2" });
  await m_type(pickIt, "bsky.ap");
  await pickIt.waitForSelector(".suggestitem", { timeout: 8000 });
  const first = await pickIt.$eval(".suggestitem small", (e) => e.textContent.slice(1));
  await (await pickIt.$(".suggestitem")).click();
  check(await waitText(pickIt, `@${first}`, 15000, ".who"), "choosing one shows that account");
  await pickIt.close();

  const theme = await openPage(CHAIN, false);
  await theme.goto(SKYDROP, { waitUntil: "networkidle2" });
  await theme.select("select[aria-label='Theme']", "dark");
  check(await theme.evaluate(() => document.documentElement.dataset.theme === "dark" && localStorage.getItem("skydrop.theme") === "dark"), "the theme can be chosen on the quests page");
  await theme.reload({ waitUntil: "networkidle2" });
  check(await theme.evaluate(() => document.documentElement.dataset.theme === "dark"), "and stays chosen");
  await theme.select("select[aria-label='Theme']", "auto");
  await theme.select("select[aria-label='Language']", "zh").catch(() => {});
  await theme.waitForNavigation({ waitUntil: "networkidle2", timeout: 8000 }).catch(() => {});
  check(await waitText(theme, "你已赚到的和还差的", 8000, "main"), "and the page can be read in Chinese");
  await theme.evaluate(() => localStorage.removeItem("skydrop.lang"));
  await theme.screenshot({ path: `${OUT}flow_zh.png`, fullPage: true });
  await theme.close();

  console.log("The builder on a phone");
  const wiz = await browser.newPage();
  await wiz.setViewport({ width: 390, height: 800, hasTouch: true, isMobile: true });
  await wiz.goto(`${CREATOR}/campaigns/new#${enc({ ...spec, name: "Wizard test" })}`, { waitUntil: "networkidle2" });
  const seen = async (s) => wiz.$eval(s, (e) => e.getBoundingClientRect().height > 0).catch(() => false);
  check((await seen(".wizbar")) && (await seen(".wiz1")) && !(await seen(".wiz2")) && !(await seen(".side")), "it starts on one short step");
  check((await wiz.evaluate(() => document.documentElement.scrollHeight)) < 2600, "much shorter than the whole form", String(await wiz.evaluate(() => document.documentElement.scrollHeight)));
  await wiz.screenshot({ path: `${OUT}flow_wiz1.png`, fullPage: true });
  await clickByText(wiz, "Next: Reward");
  check((await seen(".wiz2")) && !(await seen(".wiz1")), "Next moves to the reward");
  check(await wiz.$eval(".wizbar button[aria-current='step']", (e) => e.textContent.includes("Reward")), "and the progress bar follows");
  await wiz.screenshot({ path: `${OUT}flow_wiz2.png`, fullPage: true });
  await clickByText(wiz, "Next: Name");
  await clickByText(wiz, "Next: Launch");
  check(await seen(".side"), "the last step shows the preview and launch");
  check(await waitText(wiz, "Launch", 3000, ".launchbar"), "with the launch button in reach");
  check((await wiz.$$eval(".side h2, .side h3", (x) => x.filter((e) => e.textContent === "Launch it").length)) === 1, "and one Launch heading, not two");
  await wiz.screenshot({ path: `${OUT}flow_wiz4.png`, fullPage: true });
  await clickByText(wiz, "Back");
  check(await seen(".wiz3"), "Back goes back");
  check((await wiz.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0, "no sideways scroll");
  await wiz.close();
  const wide = await browser.newPage();
  await wide.setViewport({ width: 1280, height: 900 });
  await wide.goto(`${CREATOR}/campaigns/new#${enc({ ...spec, name: "Wizard test" })}`, { waitUntil: "networkidle2" });
  check(await wide.$eval(".wiz2", (e) => e.getBoundingClientRect().height > 0) && await wide.$eval(".side", (e) => e.getBoundingClientRect().height > 0) && await wide.$eval(".wizbar", (e) => e.getBoundingClientRect().height === 0), "a wide screen still sees everything at once");
  await wide.close();

  const gift = await openPage(CHAIN, false);
  await gift.goto(`${SKYDROP.replace(/\/quests(\.html)?$/, "/")}#/send`, { waitUntil: "networkidle2" });
  check(await waitText(gift, "Gifts aren't running"), "an old gift link explains itself up front");
  check(!(await gift.$("input")), "with no form that can only fail at the end");
  await gift.close();
}

await browser.close();
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
