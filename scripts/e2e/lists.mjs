// Allocation lists end to end: the real worker running locally, the real test campaign on the chain, both built sites.
// Takes the list test campaign's address, from `live-campaign.ts create-list`.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import puppeteer from "puppeteer-core";

const WORKER = "http://localhost:5201";
const CREATOR = "http://localhost:5196";
const SKYDROP = "http://localhost:5199/quests.html";
const OUT = "./shots/";
const dir = "./";
let failed = 0;
const check = (ok, what, extra = "") => { console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${!ok && extra ? ` :: ${extra}` : ""}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the service itself, at a real size -----------------------------------------------------------------------------
console.log("The worker");
for (let i = 0; i < 60; i++) { if (await fetch(`${WORKER}/api/list/${"0".repeat(64)}`).then(() => true).catch(() => false)) break; await sleep(1000); }
const many = (n, tag) => Array.from({ length: n }, (_, i) => ({ did: `did:plc:${tag}${String(i).padStart(23, "a")}`, amount: String(1000 + i) }));
for (const [n, tag] of [[2000, "b"], [20000, "c"]]) {
  const t = Date.now();
  const r = await fetch(`${WORKER}/api/list`, { method: "POST", body: JSON.stringify(many(n, tag)) });
  const j = await r.json();
  check(r.status === 200 && /^[0-9a-f]{64}$/.test(j.root ?? ""), `stores ${n} accounts`, JSON.stringify(j));
  console.log(`       took ${Date.now() - t} ms`);
  const back = await fetch(`${WORKER}/api/list/${j.root}`);
  check(back.status === 200 && (await back.json()).length === n && back.headers.get("access-control-allow-origin") === "*", "reads them back from any site");
}
check((await fetch(`${WORKER}/api/list`, { method: "POST", body: JSON.stringify(many(20001, "d")) })).status === 400, "refuses a longer list");
check((await fetch(`${WORKER}/api/list/nope`)).status === 404, "an unknown address isn't found");
check((await fetch(`${WORKER}/quests.html`)).status === 200, "the site itself is still served");

// ---- the sites -----------------------------------------------------------------------------------------------------
const COMPONENT = process.argv[2];
const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new", args: ["--no-sandbox"] });
const live = Buffer.from(JSON.stringify({ v: 1, name: "", rules: [], component: COMPONENT })).toString("base64url");

/** A page whose calls to skydrop.tari.mw reach the local worker. `tamper` swaps what comes back, to prove it's checked. */
async function open(tamper) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  p.errors = [];
  p.saved = 0;
  p.on("pageerror", (e) => p.errors.push(e.message));
  await p.setRequestInterception(true);
  p.on("request", async (r) => {
    const u = r.url();
    if (!u.startsWith("https://skydrop.tari.mw/api/list")) return r.continue();
    if (r.method() === "POST") p.saved++;
    if (tamper && r.method() === "GET") return r.respond({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(tamper) });
    const res = await fetch(u.replace("https://skydrop.tari.mw", WORKER), { method: r.method(), body: r.method() === "POST" ? r.postData() : undefined });
    r.respond({ status: res.status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: await res.text() });
  });
  return p;
}
const text = (p) => p.evaluate(() => document.body.innerText);
const waitText = async (p, s, ms = 30000) => p.waitForFunction((x) => document.body.innerText.includes(x), { timeout: ms }, s).then(() => true).catch(() => false);

const REAL = [{ did: "did:plc:z72i7hdynmk6r22z27h6tvur", amount: "70000" }, { did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaab", amount: "30000" }];
console.log("Creator's page");
{
  const p = await open();
  await p.goto(`${CREATOR}/c/${COMPONENT}`, { waitUntil: "domcontentloaded" });
  check(await waitText(p, "The allocation list can't be found."), "with no list anywhere, it says so");
  await p.browserContext().close();
}
{
  const p = await open([{ did: "did:plc:someoneelse", amount: "999" }]);
  await p.goto(`${CREATOR}/c/${COMPONENT}`, { waitUntil: "domcontentloaded" });
  check(await waitText(p, "The allocation list can't be found."), "a list that doesn't match the contract counts as missing");
  await p.browserContext().close();
}
{
  const p = await open();
  await p.goto(CREATOR, { waitUntil: "domcontentloaded" });
  await p.evaluate((c, l) => localStorage.setItem("atp-live-allocations", JSON.stringify({ [c]: l })), COMPONENT, REAL);
  await p.goto(`${CREATOR}/c/${COMPONENT}`, { waitUntil: "domcontentloaded" });
  check(await waitText(p, "2 accounts share 0.1 tTARI."), "the browser that launched it saves it again");
  check(p.saved === 1, "by uploading it once", String(p.saved));
  check((await text(p)).includes("matches the fingerprint in the contract"), "and says it checked out");
  check((await text(p)).includes("Download it"), "and offers it");
  check(!(await text(p)).includes("doesn't cover the whole list"), "and the pool covers it");
  await p.screenshot({ path: `${OUT}list_creator.png`, fullPage: true });
  check(p.errors.length === 0, "no page errors", p.errors.join(" | "));
  await p.browserContext().close();
}
{
  const p = await open();
  await p.goto(`${CREATOR}/c/${COMPONENT}`, { waitUntil: "domcontentloaded" });
  check(await waitText(p, "2 accounts share 0.1 tTARI."), "any other browser now finds it");
  check(p.saved === 0, "without uploading anything");
  check(await p.evaluate(() => [...document.querySelectorAll("a")].some((a) => a.href.includes("/quests#add=") && a.href.length < 400)), "and its link is short");
  await p.browserContext().close();
}

console.log("Skydrop");
{
  const p = await open();
  await p.goto(`${SKYDROP}#add=${live}`, { waitUntil: "domcontentloaded" });
  const input = await p.waitForSelector('input[type="text"], input:not([type])', { timeout: 15000 });
  await input.type("bsky.app");
  await p.keyboard.press("Enter");
  const got = await p.waitForFunction(() => { try { return (JSON.parse(localStorage.getItem("skydrop-quests") ?? "[]")[0]?.spec?.allocations?.length ?? 0) === 2; } catch { return false; } }, { timeout: 40000 }).then(() => true).catch(() => false);
  check(got, "a short link fetches the list by its fingerprint");
  await sleep(1500);
  await p.screenshot({ path: `${OUT}list_skydrop.png`, fullPage: true });
  check(await waitText(p, "Ready to claim"), "a listed account can claim");
  check((await text(p)).includes("0.07 tTARI"), "its own listed amount");
  await p.screenshot({ path: `${OUT}list_skydrop.png`, fullPage: true });
  check(p.errors.length === 0, "no page errors", p.errors.join(" | "));
  await p.browserContext().close();
}
{
  const p = await open([{ did: "did:plc:someoneelse", amount: "999" }]);
  await p.goto(`${SKYDROP}#add=${live}`, { waitUntil: "domcontentloaded" });
  const input = await p.waitForSelector('input[type="text"], input:not([type])', { timeout: 15000 });
  await input.type("bsky.app");
  await p.keyboard.press("Enter");
  await sleep(9000);
  check(await p.evaluate(() => !JSON.parse(localStorage.getItem("skydrop-quests") ?? "[]")[0]?.spec?.allocations), "a list that doesn't match the contract is ignored");
  await p.browserContext().close();
}
await browser.close();
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
