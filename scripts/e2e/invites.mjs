// Invites in a real browser, against the real referral test campaign. Only the invite limit and the viewer's receipt are overridden.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import puppeteer from "puppeteer-core";

const CREATOR = process.argv[2] || "http://localhost:5196";
const SKYDROP = process.argv[3] || "http://localhost:5199/quests.html";
const LANG_KEY = process.argv[4] || "skydrop.lang";
const INDEXER = "https://ootle-indexer-a.tari.com";
const CAMPAIGN = "component_18b98e24d3b51dc5a6288f065b649fea41ff260e2b74ebe28886d9f8badab133";
const RECEIPTS = "18b64107e00ed599e2da7138faaa488338f57cdc75e139fc7ee737a2b18cc1ca";
const REFERRER = "did:plc:52yjtwdzw4cpifjtvfnrnnvm";
const BSKY = "did:plc:z72i7hdynmk6r22z27h6tvur";
const OUT = new URL("./prod-shots/", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
mkdirSync(OUT, { recursive: true });
const sha = (x) => createHash("sha256").update(x).digest("hex");
const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new", args: ["--no-sandbox"] });
let failed = 0;
const check = (c, name, extra = "") => { console.log(`${c ? "  ok  " : " FAIL "} ${name}${extra ? ` (${extra})` : ""}`); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const raw = await (await fetch(`${INDEXER}/substates/${CAMPAIGN}`)).json();
const hex = Buffer.from(raw.state.up.substate, "base64").toString("hex");
const marker = "194e200119";
check(hex.split(marker).length === 2, "found the invite limit in the real contract state");
const limit5 = { state: { up: { substate: Buffer.from(hex.replace(marker, "194e200519"), "hex").toString("base64") } } };
const receipt = await (await fetch(`${INDEXER}/substates/nft_${RECEIPTS}_uuid_${sha(REFERRER)}`)).json();
check(!!receipt?.state?.up?.substate, "fetched the referrer's real receipt");
const mine = `/substates/nft_${RECEIPTS}_uuid_${sha(BSKY)}`;
const qk = `/substates/${CAMPAIGN}`;
const live = readFileSync(new URL("./live-link.txt", import.meta.url), "utf8").trim();

async function open(routes, width = 1280) {
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
  await page.evaluateOnNewDocument(() => {
    window.__copied = [];
    try {
      Object.defineProperty(navigator, "clipboard", { value: { writeText: async (t) => { window.__copied.push(t); } } });
    } catch { /* keep the browser's own */ }
  });
  return page;
}
const waitText = async (page, needle, ms = 30000, sel = "body") => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if ((await page.$eval(sel, (e) => e.textContent).catch(() => "")).includes(needle)) return true;
    await sleep(250);
  }
  return false;
};
const text = (p) => p.$eval("body", (e) => e.textContent);
const clean = async (p) => p.evaluate(() => { localStorage.clear(); });
const visit = async (routes, ref, handle = "bsky.app", width) => {
  const p = await open(routes, width);
  await p.goto(SKYDROP, { waitUntil: "domcontentloaded" });
  await clean(p);
  await p.goto("about:blank");
  await p.goto(`${SKYDROP}#add=${live}${ref ? `&ref=${ref}` : ""}`, { waitUntil: "networkidle2" });
  if (handle) {
    await p.type("input[aria-label='Your Bluesky handle']", handle);
    await p.keyboard.press("Enter");
  }
  return p;
};
const refs = (p) => p.evaluate(() => localStorage.getItem("skydrop-refs"));
const press = (p, label) => p.evaluate((l) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === l).click(), label);

console.log("Following an invite");
{
  const p = await visit({ [qk]: limit5, [mine]: null }, REFERRER);
  check(await waitText(p, "You were invited."), "the invite is shown once it's confirmed it would pay");
  check((await text(p)).includes("They get 0.02 tTARI from the campaign's pool when you collect. Your reward stays the same."), "and says who pays and that the reward is unchanged");
  check((await refs(p))?.includes(REFERRER), "it's remembered");
  check(!p.url().includes("ref="), "and the address is left clean", p.url());
  await p.screenshot({ path: `${OUT}invite_following.png`, fullPage: true });
  await press(p, "Remove invite");
  check(await waitText(p, "Once you've collected, invite friends and earn 0.02 tTARI each, up to 5."), "removing it leaves the offer instead");
  check(!(await refs(p))?.includes(REFERRER), "and forgets it");
  check(p.errors.length === 0, "no page errors", p.errors.join("|").slice(0, 200));
  await p.close();
}
{
  const p = await visit({ [qk]: limit5, [mine]: null }, encodeURIComponent(REFERRER));
  check(await waitText(p, "You were invited."), "a link with its colons encoded by a messaging app still works");
  await p.close();
}

console.log("Invites that wouldn't pay");
{
  const p = await visit({ [mine]: null }, REFERRER);
  check(await waitText(p, "Once you've collected"), "a referrer out of invites (real state) isn't shown as inviting you");
  check(!(await text(p)).includes("You were invited"), "so nobody's told a bonus will be paid");
  await p.close();
  const q = await visit({ [qk]: limit5, [mine]: null }, BSKY);
  check(await waitText(q, "Once you've collected"), "your own invite doesn't count");
  check(!(await text(q)).includes("You were invited"), "and isn't described as one");
  await q.close();
  const r = await visit({ [qk]: limit5, [mine]: null }, "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa");
  check(await waitText(r, "Once you've collected"), "someone who never collected can't invite");
  await r.close();
  const s = await visit({ [qk]: limit5, [mine]: null }, "javascript:alert(1)");
  check(await waitText(s, "Once you've collected"), "a nonsense invite still adds the campaign");
  check(!((await refs(s)) ?? "").includes("javascript"), "and isn't stored");
  check(s.errors.length === 0, "no page errors");
  await s.close();
}

console.log("After collecting");
{
  const p = await visit({ [qk]: limit5, [mine]: receipt });
  check(await waitText(p, "Invite friends."), "offers an invite link");
  const t = await text(p);
  check(t.includes("You get 0.02 tTARI for each new person who collects through your link, up to 5."), "says what it earns");
  check(t.includes("1 of 5 invites used, 0.02 tTARI earned."), "and how many are used");
  check(t.includes("including invite bonuses"), "the total collected includes bonuses");
  check(!(await p.evaluate(() => [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Share"))), "with just the one share button");
  check(!t.includes("Not done yet"), "a finished campaign doesn't ask for its steps again");
  check(t.includes("Add another campaign"), "and the summary doesn't say to add a first one");
  await press(p, "Share invite link");
  await sleep(200);
  const url = (await p.evaluate(() => window.__copied))[0] ?? "";
  check(url.includes(`?ref=${encodeURIComponent(BSKY)}`) && url.includes("/q/component_"), "the link names this account", url.slice(-60));
  await p.screenshot({ path: `${OUT}invite_mine.png`, fullPage: true });
  await p.close();
  const f = await visit({ [mine]: receipt });
  check(await waitText(f, "1 of 1 invite used, 0.02 tTARI earned."), "with every invite used it shows the tally");
  check(!(await text(f)).includes("Share invite link"), "and no link to share");
  check(await f.evaluate(() => [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Share")), "only the plain share, which earns nothing");
  await f.close();
  const phone = await visit({ [qk]: limit5, [mine]: receipt }, null, "bsky.app", 390);
  check(await waitText(phone, "Invite friends."), "works on a phone");
  check(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "with no sideways scrolling");
  await phone.screenshot({ path: `${OUT}invite_phone.png`, fullPage: true });
  await phone.close();
}

console.log("Other pages");
{
  const p = await open(null);
  await p.goto(SKYDROP, { waitUntil: "domcontentloaded" });
  await clean(p);
  await p.goto("about:blank");
  await p.goto(SKYDROP, { waitUntil: "networkidle2" });
  check(await waitText(p, "+0.02 per invite", 40000), "open campaigns show the bonus");
  await p.close();
  const c = await open(null);
  await c.goto(`${CREATOR}/c/${CAMPAIGN}`, { waitUntil: "networkidle2" });
  check(await waitText(c, "Inviting someone earns 0.02 tTARI, up to 1 per person."), "the creator's page states the bonus");
  check(/Enough for at least \d+ more claims?, bonuses included\./.test(await text(c)), "and counts it against the pool");
  await c.close();
}
{
  const z = await open({ [qk]: limit5, [mine]: receipt });
  await z.goto(SKYDROP, { waitUntil: "domcontentloaded" });
  await clean(z);
  await z.evaluate((k) => localStorage.setItem(k, "zh"), LANG_KEY);
  await z.goto("about:blank");
  await z.goto(`${SKYDROP}#add=${live}`, { waitUntil: "networkidle2" });
  await z.type("input[aria-label]", "bsky.app");
  await z.keyboard.press("Enter");
  check(await waitText(z, "已使用 1/5 个邀请"), "translated into Chinese");
  check(!(await text(z)).includes("Share invite link"), "including its button");
  await z.close();
}
await browser.close();
console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
