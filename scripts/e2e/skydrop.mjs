// Skydrop's participant features end to end: the real worker running locally, real campaigns on the chain, real Bluesky data.
// A fake wallet stands in for Sapient, and one account's link record and history are borrowed from a throwaway identity.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";

const WORKER = "http://localhost:5201";
const INDEXER = "https://ootle-indexer-a.tari.com";
const BSKY = "did:plc:z72i7hdynmk6r22z27h6tvur";
const OTHER = "did:plc:aaaaaaaaaaaaaaaaaaaaaaab";
const LIST_A = "component_fbcba5e6b7765f830a9ac810068ec8b669967e8526a35f13c525a2f5544ff063";
const LIST_B = process.argv[2];
const BATCHED = "component_5a6a7ef00ea1c53c59630b624ae126cb634c4d577bbe8cf34032430364d59519";
const ADDRESS = "otl_esm_17tp85g0x8emsjs6tasrphwmkhkcaf9ch7xx6aj9p2a9nx58l4vva9jyffdc8vvaxu55ax3kzdmu6m2k23y640usryeqph63fj2l7vuqu9el5r";
const OUT = "./shots/";
let failed = 0;
const check = (ok, what, extra = "") => { console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${!ok && extra ? ` :: ${extra}` : ""}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (x) => createHash("sha256").update(x).digest("hex");

for (let i = 0; i < 60; i++) { if (await fetch(`${WORKER}/quests.html`).then((r) => r.ok).catch(() => false)) break; await sleep(1000); }
for (const list of [[{ did: BSKY, amount: "70000" }, { did: OTHER, amount: "30000" }], [{ did: BSKY, amount: "60000" }, { did: OTHER, amount: "30000" }]]) {
  const r = await fetch(`${WORKER}/api/list`, { method: "POST", body: JSON.stringify(list) });
  check(r.ok, "stores a test list");
}

// Who the batch test's linked identity was: its record and history get lent to @bsky.app below.
const evs = await (await fetch(`${INDEXER}/transactions/events?substate_id=${BATCHED}&limit=20`)).json();
const lender = (evs.events.map((e) => Buffer.from(e[1], "base64").toString("latin1").match(/did:plc:[a-z2-7]{24}/)?.[0]).find(Boolean));
check(!!lender, "found the linked test identity", JSON.stringify(evs).slice(0, 200));

console.log("Share links");
const openList = (await (await fetch(`${INDEXER}/transactions/events?topic=std.component.created&limit=1000`)).json());
const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new", args: ["--no-sandbox"] });
{
  const r = await fetch(`${WORKER}/q/${LIST_A}`);
  const html = await r.text();
  check(r.status === 200 && html.includes('og:title" content="Skydrop list test: see if you&#39;re on the list on Skydrop"'), "a crawler reads the campaign's real name", html.slice(0, 300));
  check(html.includes(`/q/${LIST_A}/card.png`) && html.includes("location.replace"), "with a picture, and people are sent on");
  const png = await fetch(`${WORKER}/q/${LIST_A}/card.png`);
  const bytes = Buffer.from(await png.arrayBuffer());
  check(png.status === 200 && png.headers.get("content-type") === "image/png" && bytes.length > 5000 && bytes[1] === 0x50, "the picture is drawn", `${png.status} ${bytes.length}`);
  writeFileSync(`${OUT}card.png`, bytes);
  check((await fetch(`${WORKER}/q/nonsense`)).status === 404, "a bad address isn't found");
  check((await fetch(`${WORKER}/q/component_${"0".repeat(64)}`)).status === 404, "nor one with no campaign");
  check((await fetch(`${WORKER}/q/component_${"0".repeat(64)}/card.png`)).status === 404, "nor its picture");
  check((await fetch(`${WORKER}/q/${LIST_A}`, { method: "POST" })).status === 404, "and it's read-only");
  check((await fetch(`${WORKER}/c/nothing.jpg`)).status === 404 && (await fetch(`${WORKER}/`)).status === 200, "the old routes still work");
}

async function open({ width = 1280, mobile = false, connected = false, lendLink = false, lendHistory = false } = {}) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport({ width, height: 900, isMobile: mobile, hasTouch: mobile });
  p.errors = [];
  p.on("pageerror", (e) => p.errors.push(e.message));
  await p.setRequestInterception(true);
  p.on("request", async (r) => {
    const u = r.url();
    try {
      // wrangler dev gives the worker the production address, so that address is served from the local build here.
      if (u.startsWith("https://skydrop.tari.mw/")) {
        const res = await fetch(u.replace("https://skydrop.tari.mw", WORKER));
        return r.respond({ status: res.status, contentType: res.headers.get("content-type") ?? "text/plain", headers: { "access-control-allow-origin": "*" }, body: Buffer.from(await res.arrayBuffer()) });
      }
      if (u === `${INDEXER}/transactions/feedface/result`) return r.respond({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ result: { Finalized: { final_decision: "Commit" } } }) });
      if ((lendLink || lendHistory) && u.startsWith(`${INDEXER}/substates/nft_`) && u.endsWith(`_uuid_${sha(BSKY)}`)) {
        const res = await fetch(u.replace(sha(BSKY), sha(lender)));
        return r.respond({ status: res.status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: await res.text() });
      }
      if (lendHistory && u.startsWith(`${INDEXER}/transactions/events`) && u.includes("campaign.claim")) {
        const j = await (await fetch(u)).json();
        // Same length, so the encoded event is still well formed.
        for (const e of j.events) e[1] = Buffer.from(Buffer.from(e[1], "base64").toString("latin1").split(lender).join(BSKY), "latin1").toString("base64");
        return r.respond({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(j) });
      }
    } catch (e) {
      console.log("intercept failed", u, e.message);
    }
    return r.continue();
  });
  await p.evaluateOnNewDocument((addr, on) => {
    window.__calls = [];
    window.__dryFail = false;
    const account = "component_1111111111111111111111111111111111111111111111111111111111111111";
    const handler = async ({ method, params }) => {
      window.__calls.push({ method, params });
      switch (method) {
        case "tari_getAccounts": return on ? [account] : [];
        case "tari_requestAccounts": return [account];
        case "tari_getWalletAddress": return addr;
        case "tari_getNetwork": return "esmeralda";
        case "tari_getBalances": return [{ resourceAddress: "resource_0101010101010101010101010101010101010101010101010101010101010101", amount: "12500000" }];
        case "tari_createTransactionRequest": return { requestId: "r1" };
        case "tari_getTransactionRequest": return { status: "approved" };
        case "tari_submitTransactionRequest": return { transactionId: "feedface" };
        case "tari_signAndSubmitTransaction": if (window.__dryFail) { window.__dryFail = false; throw new Error('[{"ExecutionFailure":{"message":"At instruction #1: Template error: the pool is exhausted"}}]'); } return { result: {} };
        default: throw new Error(`mock: ${method}`);
      }
    };
    window.tari = { info: { name: "Sapient" }, request: handler };
    window.tariProviders = [window.tari];
  }, ADDRESS, connected);
  return p;
}
const text = (p) => p.evaluate(() => document.body.innerText);
const waitText = async (p, s, ms = 45000) => p.waitForFunction((x) => document.body.innerText.includes(x), { timeout: ms }, s).then(() => true).catch(() => false);
const enter = async (p, handle) => {
  const input = await p.waitForSelector(".qform input");
  await input.click({ clickCount: 3 });
  await input.type(handle);
  await p.keyboard.press("Enter");
};
const shot = (p, name) => p.screenshot({ path: `${OUT}${name}.png`, fullPage: true });
const clickText = (p, t) => p.evaluate((x) => { const b = [...document.querySelectorAll("button,summary,a")].find((e) => e.textContent.trim().startsWith(x)); b?.click(); return !!b; }, t);

console.log("Arriving by a link");
{
  const p = await open({ width: 390, mobile: true });
  await p.goto(`${WORKER}/q/${LIST_A}?ref=${OTHER}`, { waitUntil: "domcontentloaded" });
  await p.waitForFunction(() => location.pathname.startsWith("/quests") && !location.hash, { timeout: 15000 }).catch(() => {});
  check(!p.url().includes("#"), "lands on the page with the address clean", p.url());
  check(await waitText(p, "Skydrop list test"), "shows the campaign it came for");
  check(await waitText(p, "Enter your Bluesky handle to see where you stand"), "and says what to do next");
  check((await p.$(".qarrive")) !== null && await p.evaluate(() => document.querySelector(".qarrive").getBoundingClientRect().top < document.querySelector(".qform").getBoundingClientRect().top), "above the form");
  check(!(await text(p)).includes("You were invited"), "an invite that could not pay is not mentioned");
  check(await waitText(p, "Closes in"), "with how long is left");
  await shot(p, "s1_arrive_phone");
  await enter(p, "bsky.app");
  check(await p.waitForFunction(() => !document.querySelector(".qarrive"), { timeout: 20000 }).then(() => true).catch(() => false), "the box goes once there's a handle");
  check(await p.waitForFunction(() => document.querySelector(".qcard.qflash"), { timeout: 45000 }).then(() => true).catch(() => false), "and it takes them to the card");
  await p.browserContext().close();
}

console.log("Open campaigns");
{
  const p = await open();
  const t0 = Date.now();
  await p.goto(`${WORKER}/quests.html`, { waitUntil: "domcontentloaded" });
  await waitText(p, "Open campaigns");
  check(!(await text(p)).includes("Skydrop list test"), "nobody sees a list campaign before saying who they are");
  await enter(p, "bsky.app");
  check(await waitText(p, "You already qualify for"), "it finds the campaigns this account already qualifies for", (await text(p)).slice(0, 300));
  check(await waitText(p, "Ready to claim"), "and puts them on the list");
  await p.waitForFunction(() => document.querySelectorAll(".qcard.won").length >= 2, { timeout: 45000 }).catch(() => {});
  console.log(`       took ${Date.now() - t0} ms`);
  const body = await text(p);
  check(body.includes("0.13 tTARI"), "with the total ready", body.slice(0, 600));
  check(body.includes("Closes in") && /Closing soon/i.test(body), "each shows its deadline");
  check(await waitText(p, "Collect 2 together"), "and they can be collected together");
  await sleep(4000);
  await shot(p, "s2_ready");
  check(p.errors.length === 0, "no page errors", p.errors.join(" | "));

  // Removing one keeps it off, but it's still there to find.
  const before = await p.$$eval(".qcard.won", (c) => c.length);
  await p.evaluate(() => [...document.querySelector(".qcard.won").querySelectorAll("button")].find((b) => b.textContent === "Remove").click());
  await sleep(300);
  check((await p.$$eval(".qcard.won", (c) => c.length)) === before - 1, "removing one takes it off");
  await p.reload({ waitUntil: "domcontentloaded" });
  check(await waitText(p, "You're on its list"), "after a reload it isn't added back, but shows under open campaigns");
  check((await p.$$eval(".qcard.won", (c) => c.length)) === before - 1, "and stays off the list");
  await p.browserContext().close();
}
{
  const p = await open();
  await p.goto(`${WORKER}/quests.html`, { waitUntil: "domcontentloaded" });
  await enter(p, "atproto.com");
  await waitText(p, "In progress", 30000);
  await sleep(6000);
  const body = await text(p);
  check(!body.includes("Skydrop list test") && !body.includes("You're on its list"), "someone not on a list doesn't see it");
  await p.browserContext().close();
}

console.log("Collecting together");
{
  const p = await open({ lendLink: true });
  await p.goto(`${WORKER}/quests.html`, { waitUntil: "domcontentloaded" });
  await enter(p, "bsky.app");
  check(await waitText(p, "Collect 2 together"), "the button is there");
  await p.waitForFunction(() => document.querySelector(".qform button")?.textContent === "Refresh", { timeout: 60000 }).catch(() => {});
  await clickText(p, "Collect 2 together");
  check(await waitText(p, "Collect 0.13 tTARI"), "with a linked wallet, no post is needed", (await text(p)).slice(0, 800));
  check((await text(p)).includes("paid to"), "and it says the rewards go to the linked wallet");
  await shot(p, "s3_batch");
  await p.evaluate(() => { window.__dryFail = true; });
  await clickText(p, "Collect 0.13 tTARI");
  check(await waitText(p, "These can't all go through together"), "a refused dry run says so");
  check((await text(p)).includes("Nothing was spent"), "and that it cost nothing");
  check(!(await p.evaluate(() => window.__calls.some((c) => c.method === "tari_createTransactionRequest"))), "and nothing goes to the wallet to sign");
  await p.evaluate(() => { const b = [...document.querySelectorAll(".qbatch button")].find((x) => x.textContent === "Not now"); b.click(); });
  await sleep(200);
  await clickText(p, "Collect 2 together");
  await waitText(p, "Collect 0.13 tTARI");
  await clickText(p, "Collect 0.13 tTARI");
  check(await waitText(p, "Collected 0.13 tTARI from 2 campaigns."), "it goes through", (await text(p)).slice(0, 500));
  const sent = await p.evaluate(() => window.__calls.find((c) => c.method === "tari_createTransactionRequest")?.params);
  const claims = (sent?.instructions ?? []).filter((i) => i.CallMethod?.method === "claim_linked");
  check(claims.length === 2, "one transaction with both claims", JSON.stringify(sent ?? {}).slice(0, 300));
  const ids = (sent?.inputs ?? []).map((x) => x.substate_id);
  check(new Set(ids).size === ids.length && ids.includes(LIST_A) && ids.includes(LIST_B), "naming each thing it touches once");
  check((await p.evaluate(() => window.__calls.filter((c) => c.method === "tari_submitTransactionRequest").length)) === 1, "with one approval");
  check(p.errors.length === 0, "no page errors", p.errors.join(" | "));
  await p.browserContext().close();
}
{
  const p = await open({ connected: true });
  await p.goto(`${WORKER}/quests.html`, { waitUntil: "domcontentloaded" });
  await enter(p, "bsky.app");
  await waitText(p, "Collect 2 together");
  await p.waitForFunction(() => document.querySelector(".qform button")?.textContent === "Refresh", { timeout: 60000 }).catch(() => {});
  await clickText(p, "Collect 2 together");
  check(await waitText(p, "One post covers these 2 campaigns"), "without a link, one post covers them all", (await text(p)).slice(0, 800));
  const post = await p.$eval(".qbatch pre", (e) => e.textContent);
  check((post.match(/tari-quest:[0-9a-f]{32}/g) ?? []).length === 2 && post.length <= 300, "it carries both codes and fits", post);
  await clickText(p, "I've posted it");
  check(await waitText(p, "That post isn't showing yet"), "pressing too early says so");
  await shot(p, "s4_batch_post");
  check(p.errors.length === 0, "no page errors", p.errors.join(" | "));
  await p.browserContext().close();
}

console.log("History");
{
  const p = await open({ lendHistory: true });
  await p.goto(`${WORKER}/quests.html`, { waitUntil: "domcontentloaded" });
  await enter(p, "bsky.app");
  check(await waitText(p, "Your payments"), "payments show up from the chain", (await text(p)).slice(0, 500));
  await p.waitForFunction(() => document.querySelector(".qform button")?.textContent === "Refresh", { timeout: 90000 }).catch(() => {});
  await p.evaluate(() => { document.querySelector(".qhist").open = true; });
  const hist = await p.$eval(".qhist", (e) => e.innerText);
  check(hist.includes("0.03 tTARI") && hist.includes("Skydrop batch test"), "with amounts and names", hist);
  check(await p.$eval(".qhist a", (a) => /^https:\/\/explorer\.tari\.mw\/tx\/[0-9a-f]{64}$/.test(a.href)), "and a link to each transaction");
  const fin = await p.$(".qdone");
  check(fin !== null && !(await p.$eval(".qdone", (d) => d.open)), "finished campaigns are folded away");
  await shot(p, "s5_history");
  check(p.errors.length === 0, "no page errors", p.errors.join(" | "));
  await p.browserContext().close();
}
await browser.close();
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
