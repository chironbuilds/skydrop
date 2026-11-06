import puppeteer from "puppeteer-core";
const BASE = process.argv[2] || "http://localhost:5198/quests.html";
const OUT = new URL("./prod-shots/", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new", args: ["--no-sandbox"] });
let failed = 0;
const check = (c, name, extra = "") => { console.log(`${c ? "  ok  " : " FAIL "} ${name}${extra ? ` (${extra})` : ""}`); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BSKY = "did:plc:z72i7hdynmk6r22z27h6tvur";
const feed = (await (await fetch(`https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${BSKY}&limit=40&filter=posts_no_replies`)).json()).feed.filter((f) => f.post.author.did === BSKY);
const words = feed[0].post.record.text.split(/\s+/).slice(0, 2).join(" ");
const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const base = { v: 1, about: "", reward: "2500000", budget: "50000000", rounds: 1, roundDays: 7, bonus: "0", maxReferrals: 0, startsInDays: 0, days: 5 };

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 1000 });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error" && !/fonts\.g|favicon/.test(m.text()) && !m.location()?.url?.includes("/substates/nft_") && !m.location()?.url?.includes("/api/list/") && !m.text().includes("/api/list/")) errors.push(m.text()); }); // an NFT that doesn't exist yet is an expected 404

await page.goto(BASE, { waitUntil: "networkidle2" });
check((await page.$eval("main", (e) => e.textContent)).includes("No quests yet"), "empty state explains itself");
await page.screenshot({ path: `${OUT}q_empty.png` });

// campaign links: done, in progress, either/or, voucher-only, on a list
const done = enc({ ...base, name: "Done quest", rules: [{ kind: 3, target: words }] });
const todo = enc({ ...base, name: "To-do quest", reward: "1000000", rounds: 3, rules: [{ kind: 3, target: words }, { kind: 3, target: "never-in-any-post-zzqq" }] });
const either = enc({ ...base, name: "Either quest", reward: "500000", rules: [{ kind: 3, target: "never-in-any-post-zzqq" }, { kind: 3, target: words, or: true }] });
const vouch = enc({ ...base, name: "Voucher quest", rules: [{ kind: 8, target: BSKY }] });
const listed = enc({ ...base, name: "Listed quest", rules: [], root: "ab".repeat(32), allocations: [{ did: BSKY, amount: "7000000" }] });
const notListed = enc({ ...base, name: "Not listed quest", rules: [], root: "cd".repeat(32), allocations: [{ did: "did:plc:zzzzzzzzzzzzzzzzzzzzzzzz", amount: "7000000" }] });

await page.goto(`${BASE}#add=${done}`, { waitUntil: "networkidle2" });
await sleep(100);
check(!page.url().includes("#add="), "the link's hash is cleaned up");
check((await page.$eval("main", (e) => e.textContent)).includes("Done quest"), "opening a campaign link adds it");
for (const [link, name] of [[`https://atproto.tari.mw/c/preview#${todo}`, "To-do"], [`https://skydrop.tari.mw/quests#add=${either}`, "Either"], [vouch, "Voucher"], [listed, "Listed"], [notListed, "Not listed"]]) {
  await page.type(".qadd input", link);
  await page.$$eval(".qadd button", (b) => b[0].click());
  await sleep(120);
  check((await page.$eval("main", (e) => e.textContent)).includes(`Added “${name} quest”`), `pasting a link adds ${name}`);
}
await page.type(".qadd input", "https://example.com/nonsense");
await page.$$eval(".qadd button", (b) => b[0].click());
await sleep(60);
check((await page.$eval(".qadd", (e) => e.textContent)).includes("doesn't look like a campaign"), "a bad link is refused");
await page.$eval(".qadd input", (e) => { e.value = ""; });
await page.type(".qadd input", done);
await page.$$eval(".qadd button", (b) => b[0].click());
await sleep(60);
check((await page.$eval(".qadd", (e) => e.textContent)).includes("already on your list"), "adding twice doesn't duplicate");

await page.type(".qform input", "bsky.app");
await page.$eval(".qform button", (b) => b.click());
await page.waitForFunction(() => document.querySelector(".qform button")?.textContent === "Refresh", { timeout: 90000 });
await sleep(200);
const sections = await page.$$eval(".qsection", (s) => s.map((x) => ({ title: x.querySelector("h2").firstChild.textContent, names: [...x.querySelectorAll("h3")].map((h) => h.textContent) })));
console.log("       ", JSON.stringify(sections));
const sec = (t) => sections.find((s) => s.title === t)?.names ?? [];
check(["Done quest", "Either quest", "Listed quest"].every((n) => sec("Ready to claim").includes(n)), "ready: all met, either/or met, on a list");
check(sec("In progress").includes("To-do quest"), "in progress: one step left");
check(sec("Needs someone else").includes("Voucher quest") && sec("Needs someone else").includes("Not listed quest"), "needs someone else: voucher, not on the list");
const tiles = await page.$$eval(".qtile", (t) => t.map((x) => x.textContent));
console.log("       ", tiles.join(" | "));
check(tiles[0].includes("10 tTARI") && tiles[0].includes("3 campaigns"), "ready total: 2.5 + 0.5 + 7", tiles[0]);
check(tiles[1].includes("3 tTARI") && tiles[1].includes("1 in progress"), "still to earn: 1 × 3 rounds", tiles[1]);
check(tiles[2].includes("6") && tiles[2].includes("2 you can't"), "tracking count", tiles[2]);
const todoCard = await page.$$eval(".qcard", (c) => c.find((x) => x.textContent.includes("To-do quest")).textContent);
check(todoCard.includes("1 step left") && todoCard.includes("Write the post"), "what's left comes with a way to do it");
const eitherCard = await page.$$eval(".qcard", (c) => c.find((x) => x.textContent.includes("Either quest")).textContent);
check(eitherCard.includes("Not needed"), "the unused either/or option says it isn't needed");
check((await page.$$eval(".qcard", (c) => c.find((x) => x.textContent.includes("Done quest")).textContent)).includes("Nothing to collect"), "ready previews say plainly there is nothing to collect");
check((await page.$eval("main", (e) => e.textContent)).includes("Testnet only"), "the testnet notice shows");
await page.screenshot({ path: `${OUT}q_board.png`, fullPage: true });

// comes back after a reload, with the handle remembered
await page.reload({ waitUntil: "networkidle2" });
await page.waitForFunction(() => document.querySelector(".qform button")?.textContent === "Refresh", { timeout: 90000 });
check((await page.$$eval(".qcard", (c) => c.length)) === 6, "list and handle survive a reload");
check((await page.$eval(".who", (e) => e.textContent)).includes("@bsky.app"), "shows who it's checking");
// remove
await page.$$eval(".qcard", (c) => c.find((x) => x.textContent.includes("Listed quest") && !x.textContent.includes("Not listed")).querySelector(".linkbtn").click());
await sleep(120);
check((await page.$$eval(".qcard", (c) => c.length)) === 5, "a campaign can be removed");
check((await page.$$eval(".qtile", (t) => t[0].textContent)).includes("3 tTARI"), "totals follow");

// another handle: bad input is handled
await page.$eval(".qform input", (e) => { e.value = ""; });
await page.type(".qform input", "not a handle!");
await page.$eval(".qform button", (b) => b.click());
await sleep(300);
check((await page.$eval(".who", (e) => e.textContent)).includes("doesn't look like"), "a bad handle gets a clear message");

// hostile text stays text
const evil = enc({ ...base, name: "<img src=x onerror=window.pwned=1>", about: "<script>window.pwned=1</script>", rules: [{ kind: 3, target: "<b>x</b>" }] });
await page.goto(`${BASE}#add=${evil}`, { waitUntil: "networkidle2" });
await sleep(200);
check(!(await page.evaluate(() => window.pwned)), "HTML in a campaign isn't executed");
check(await page.$$eval("h3", (h) => h.some((x) => x.textContent.includes("<img"))), "...and shows as plain text");
const js = enc({ ...base, name: "JS link", rules: [{ kind: 0, target: "javascript:alert(1)" }] });
await page.goto(`${BASE}#add=${js}`, { waitUntil: "networkidle2" });
await sleep(100);
check((await page.$eval(".qadd", (e) => e.textContent)).includes("couldn't be read"), "a dangerous target is refused");
check(errors.length === 0, "no errors", errors.join(" | ").slice(0, 400));

// layouts
for (const [w, h, dark, tag] of [[390, 844, false, "phone"], [1280, 1000, true, "dark"]]) {
  const p = await browser.newPage();
  await p.setViewport({ width: w, height: h });
  await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }]);
  await p.goto(BASE, { waitUntil: "networkidle2" });
  await p.waitForFunction(() => document.querySelector(".qform button")?.textContent === "Refresh" || document.querySelector(".fielderr"), { timeout: 90000 }).catch(() => {});
  await sleep(200);
  const over = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(over <= 0, `${tag}: no sideways scroll`, over > 0 ? `${over}px` : "");
  await p.screenshot({ path: `${OUT}q_${tag}.png`, fullPage: true });
  await p.close();
}

await browser.close();
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
