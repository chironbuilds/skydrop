import puppeteer from "puppeteer-core";

const BASE = process.argv[2] || "http://localhost:5196";
const OUT = new URL("./prod-shots/", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new", args: ["--no-sandbox"] });
let failed = 0;
const check = (c, name, extra = "") => { console.log(`${c ? "  ok  " : " FAIL "} ${name}${extra ? ` (${extra})` : ""}`); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(width = 1280, height = 900, dark = false) {
  const page = await browser.newPage();
  await page.setViewport({ width, height });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }]);
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/fonts\.g|favicon|ERR_BLOCKED/.test(m.text() + (m.location()?.url ?? ""))) page.errors.push(`${m.text()} @ ${m.location()?.url ?? ""}`); });
  return page;
}
const go = async (page, path) => { await page.goto(BASE + path, { waitUntil: "networkidle2", timeout: 45000 }); await sleep(150); };
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);

const ROUTES = ["/", "/me", "/campaigns", "/campaigns/new", "/campaigns/new?do=0,1,4", "/campaigns/new?playbook=retro", "/campaigns/new?playbook=ambassadors", "/verify", "/use-cases", "/docs", "/docs/campaign", "/docs/architecture", "/docs/integrate", "/docs/security", "/docs/skydrop", "/status", "/nope"];

console.log("Every page, three layouts");
for (const [w, h, dark, tag] of [[1280, 900, false, "desk"], [375, 760, false, "phone"], [1280, 900, true, "dark"]]) {
  const page = await open(w, h, dark);
  for (const r of ROUTES) {
    await go(page, r);
    const over = await overflow(page);
    const name = r.replace(/[^a-z0-9]+/gi, "_") || "home";
    await page.screenshot({ path: `${OUT}${tag}${name}.png`, fullPage: true });
    check(over <= 0, `${tag} ${r} no sideways scroll`, over > 0 ? `${over}px` : "");
    check(page.errors.length === 0, `${tag} ${r} no errors`, page.errors.join(" | ").slice(0, 300));
    page.errors.length = 0;
  }
  await page.close();
}

console.log("Internal links resolve");
{
  const page = await open();
  const seen = new Set();
  for (const r of ["/", "/campaigns", "/docs", "/docs/integrate", "/docs/security", "/status", "/use-cases"]) {
    await go(page, r);
    for (const href of await page.$$eval("a[href^='/']", (as) => as.map((a) => a.getAttribute("href")))) seen.add(href);
  }
  for (const href of seen) {
    await go(page, href);
    const nf = await page.$eval("main", (m) => /doesn't exist/.test(m.textContent));
    check(!nf, `link ${href}`);
  }
  await page.close();
}

console.log("Drag-and-drop board");
{
  const BSKY = "did:plc:z72i7hdynmk6r22z27h6tvur";
  const feed = await (await fetch(`https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${BSKY}&limit=40&filter=posts_no_replies`)).json();
  const mine = feed.feed.filter((f) => f.post.author.did === BSKY).map((f) => `https://bsky.app/profile/bsky.app/post/${f.post.uri.split("/").pop()}`);
  check(mine.length >= 3, "found three real posts to use", String(mine.length));
  const page = await open();
  await go(page, "/campaigns/new");
  const steps = () => page.$$eval(".stephead strong", (x) => x.map((e) => e.textContent));
  const sentence = () => page.$eval(".sentence", (e) => e.textContent);
  const centre = async (sel, i = 0) => { const els = await page.$$(sel); const b = await els[i].boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };
  const paletteBtn = async (label) => { const all = await page.$$(".paltile"); for (const b of all) if ((await b.evaluate((e) => e.textContent)).includes(label)) return b; };
  const drag = async ([x1, y1], [x2, y2]) => { await page.mouse.move(x1, y1); await page.mouse.down(); await page.mouse.move(x1 + 10, y1 + 10, { steps: 2 }); await page.mouse.move(x2, y2, { steps: 8 }); await page.mouse.up(); await sleep(120); };
  const dragPalette = async (label, to) => { const b = await (await paletteBtn(label)).boundingBox(); await drag([b.x + b.width / 2, b.y + b.height / 2], to); };

  check((await page.$eval(".board", (e) => e.textContent)).includes("Drag a step here"), "empty board explains itself");
  // drag from the palette onto the empty board
  await dragPalette("Like", await centre(".board"));
  check((await steps()).join() === "Like a post", "dragging Like adds a step", (await steps()).join());
  // dragging and dropping outside the board adds nothing
  await dragPalette("Repost", [5, 5]);
  check((await steps()).length === 1, "dropping outside the board adds nothing");
  // press without dragging adds to the end
  await (await paletteBtn("Like")).click();
  await sleep(80);
  check((await steps()).length === 2, "pressing a tile adds a step");
  await (await paletteBtn("Like")).click();
  await sleep(80);

  // like post X, like post Y, like post Z: each with its own link
  const inputs = () => page.$$(".stepbox > input");
  for (let i = 0; i < 3; i++) {
    const box = (await inputs())[i];
    await box.click({ clickCount: 3 });
    await box.type(mine[i]);
    await page.keyboard.press("Tab");
    await page.waitForFunction((n) => document.querySelectorAll(".postcard").length >= n, { timeout: 15000 }, i + 1);
    await sleep(120);
  }
  check((await sentence()).includes("like post 1, like post 2 and like post 3"), "like post X, Y and Z", await sentence());
  check(await page.$eval("input[maxlength='64']", (e) => e.value === "3-step quest"), "named automatically");
  check(!(await page.$eval(".side", (e) => e.textContent.includes("Before this can launch"))), "three-post campaign is valid");
  await page.screenshot({ path: `${OUT}flow_board_xyz.png`, fullPage: true });

  // drop a Comment between steps 1 and 2 with the drag target on the gap
  const r2 = await (await page.$$(".stepbox"))[1].boundingBox();
  await page.evaluate((y) => scrollBy(0, y - 300), r2.y);
  await sleep(100);
  const gap = (await (await page.$$(".stepbox"))[1].boundingBox());
  const pal = await (await paletteBtn("Comment")).boundingBox();
  await drag([pal.x + pal.width / 2, Math.max(pal.y + pal.height / 2, 2)], [gap.x + 100, gap.y + 4]);
  const afterDrop = await steps();
  check(afterDrop[1] === "Reply to a post" && afterDrop.length === 4, "dropping between steps inserts there", afterDrop.join());
  await page.evaluate(() => scrollTo(0, 0));

  // reorder with the grip: move step 4 to the top
  await page.setViewport({ width: 1280, height: 1700 });
  await sleep(200);
  const before = await page.$$eval(".stepbox > input", (x) => x.map((e) => e.value));
  const grips = await page.$$(".grip");
  const g = await grips[3].boundingBox();
  const first = await (await page.$$(".stepbox"))[0].boundingBox();
  if (g.y < 760) {
    await drag([g.x + g.width / 2, g.y + g.height / 2], [first.x + 100, first.y + 4]);
    const afterMove = await page.$$eval(".stepbox > input", (x) => x.map((e) => e.value));
    check(afterMove[0] === before[3] && afterMove.length === 4, "dragging the grip reorders and keeps the link");
  } else {
    await page.evaluate((y) => scrollBy(0, y), g.y - 500);
    await sleep(120);
    const g2 = await (await page.$$(".grip"))[3].boundingBox();
    const f2 = await (await page.$$(".stepbox"))[0].boundingBox();
    await drag([g2.x + g2.width / 2, g2.y + g2.height / 2], [f2.x + 100, f2.y + 4]);
    const afterMove = await page.$$eval(".stepbox > input", (x) => x.map((e) => e.value));
    check(afterMove[0] === before[3] && afterMove.length === 4, "dragging the grip reorders and keeps the link");
    await page.evaluate(() => scrollTo(0, 0));
  }
  // holding near the top edge scrolls the page during a drag
  await page.setViewport({ width: 1280, height: 560 });
  await page.evaluate(() => scrollTo(0, 500));
  await sleep(100);
  await (await page.$$(".grip"))[1].evaluate((e) => e.scrollIntoView({ block: "center" }));
  await sleep(100);
  const gr = await (await page.$$(".grip"))[1].boundingBox();
  const y0 = await page.evaluate(() => scrollY);
  await page.mouse.move(gr.x + 8, gr.y + 8); await page.mouse.down(); await page.mouse.move(gr.x + 20, gr.y + 20, { steps: 2 }); await page.mouse.move(gr.x + 40, 80, { steps: 4 });
  await sleep(350);
  const y1 = await page.evaluate(() => scrollY);
  await page.mouse.move(5, 5, { steps: 2 }); await page.mouse.up();
  check(y1 < y0, "resting near the edge auto-scrolls", `${y0} -> ${y1}`);
  await page.setViewport({ width: 1280, height: 1700 });
  await page.evaluate(() => scrollTo(0, 0));
  await sleep(150);
  // buttons do the same without a mouse
  const order1 = await steps();
  await page.$$eval("button[aria-label='Move step 1 down']", (b) => b[0].click());
  await sleep(100);
  const order2 = await steps();
  check(order2[0] === order1[1] && order2[1] === order1[0], "move-down button works");
  // keyboard: Enter on a palette tile adds a step, exactly once
  const n = (await steps()).length;
  await (await paletteBtn("Follow")).focus();
  await page.keyboard.press("Enter");
  await sleep(120);
  check((await steps()).length === n + 1, "keyboard adds a step exactly once");
  check((await sentence()).includes("follow"), "follow joins the sentence", await sentence());
  // the maximum of eight
  for (let i = 0; i < 6; i++) { const b = await paletteBtn("Post text"); if (await b.evaluate((e) => !e.disabled)) { await b.click(); await sleep(50); } }
  check((await steps()).length === 8, "stops at eight steps");
  check(await (await paletteBtn("Like")).evaluate((e) => e.disabled), "palette disables at the limit");
  // removing
  for (let i = 0; i < 3; i++) { await page.$$eval("button[aria-label^='Remove step']", (b) => b[b.length - 1].click()); await sleep(60); }
  check((await steps()).length === 5, "steps can be removed");
  check(!(await page.$eval(".side", (e) => e.textContent.includes("Before this can launch"))), "filled steps stay valid");
  await (await paletteBtn("Post text")).click();
  await sleep(80);
  check(await page.$eval(".side", (e) => e.textContent.includes("Before this can launch")), "a blank step blocks launch");
  await page.close();

  // template: pasting once fills the other steps of a like/repost/comment quest
  const t = await open();
  await go(t, "/campaigns");
  await t.$$eval("a.quick", (as) => as.find((a) => a.textContent.includes("Like, repost + comment")).click());
  await sleep(300);
  check(t.url().includes("do=0,1,4"), "template opens the builder");
  const box = (await t.$$(".stepbox > input"))[0];
  await box.type(mine[0]);
  await t.keyboard.press("Tab");
  await t.waitForFunction(() => document.querySelectorAll(".postcard").length === 3, { timeout: 15000 });
  check(true, "one paste fills all three steps");
  const sent = await t.$eval(".sentence", (e) => e.textContent);
  check(sent.includes("like, repost and comment on this post"), "like, repost and comment", sent);
  check(await t.$eval("input[maxlength='64']", (e) => e.value === "Like, repost and comment quest"), "template named automatically");
  await t.screenshot({ path: `${OUT}flow_board_lrc.png`, fullPage: true });
  await t.$$eval("a.btn", (a) => a.find((x) => x.textContent.includes("Preview the claim")).click());
  await sleep(600);
  check(t.url().includes("/c/preview#"), "preview opens");
  await t.waitForSelector(".postcard", { timeout: 15000 });
  await t.type("input[aria-label='Bluesky handle']", "bsky.app");
  await t.$$eval("button[type=submit]", (b) => b[0].click());
  await t.waitForFunction(() => document.querySelectorAll("form ~ .steps .stepcard").length === 4 && !document.querySelector("form ~ .steps .stepcard.run"), { timeout: 60000 });
  await sleep(200);
  const cards = await t.$$eval("form ~ .steps .stepcard", (c) => c.map((e) => `${e.className.includes("ok") ? "OK" : "NO"} ${e.querySelector("h3").textContent}: ${e.querySelector("p")?.textContent ?? ""}`));
  cards.forEach((c) => console.log("       ", c.slice(0, 130)));
  check(cards[0]?.startsWith("OK"), "identity log verified for a real account");
  await t.screenshot({ path: `${OUT}flow_claim.png`, fullPage: true });
  check(t.errors.length === 0, "no errors", t.errors.join(" | ").slice(0, 400));
  await t.close();

  // touch-sized board: buttons and tap-to-add still work, nothing overflows
  const m = await open(375, 760);
  await go(m, "/campaigns/new?do=0,0,1");
  check((await overflow(m)) <= 0, "phone: board fits without sideways scroll");
  await m.screenshot({ path: `${OUT}flow_board_phone.png`, fullPage: true });
  await m.close();
}

console.log("Eligibility: a rule a real account does meet");
{
  // bsky.app's own posts: use a text rule on its latest post text so this passes end to end
  const post = await (await fetch("https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=did:plc:z72i7hdynmk6r22z27h6tvur&limit=40&filter=posts_no_replies")).json();
  const p = post.feed.find((f) => f.post.author.did === "did:plc:z72i7hdynmk6r22z27h6tvur").post;
  const words = p.record.text.split(/\s+/).slice(0, 2).join(" ");
  const spec = { v: 1, name: "E2E", about: "", rules: [{ kind: 3, target: words }], reward: "1000000", budget: "5000000", rounds: 1, roundDays: 7, bonus: "0", maxReferrals: 0, startsInDays: 0, days: 3 };
  const enc = Buffer.from(JSON.stringify(spec)).toString("base64url");
  const page = await open();
  await go(page, `/c/preview#${enc}`);
  await page.type("input[aria-label='Bluesky handle']", "bsky.app");
  await page.$$eval("button[type=submit]", (b) => b[0].click());
  await page.waitForSelector(".note.ok", { timeout: 60000 });
  check(true, "qualifying account is told it qualifies");
  await page.type("input[aria-label='Wallet public key']", "c2a0394cab5ff3b6b51335386d8fb473cf03db714258bc17a10165783b3cf46c");
  await page.waitForFunction(() => [...document.querySelectorAll("pre")].some((e) => e.textContent.includes("tari-quest:")), { timeout: 5000 });
  check(true, "claim post text is generated");
  // malicious content in a shared link stays inert
  const evil = Buffer.from(JSON.stringify({ ...spec, name: "<img src=x onerror=window.pwned=1>", about: "<script>window.pwned=1</script>" })).toString("base64url");
  await go(page, `/c/preview#${enc}`);
  await page.goto(`${BASE}/c/preview#${evil}`);
  await page.reload({ waitUntil: "networkidle2" });
  await sleep(300);
  check(!(await page.evaluate(() => window.pwned)), "HTML in a shared link isn't executed");
  check(await page.$eval("main h1", (e) => e.textContent.includes("<img")), "...and shows as plain text");
  await page.close();
}

console.log("Live proof");
{
  const page = await open();
  await go(page, "/verify");
  await page.$$eval("button", (b) => b.find((x) => x.textContent.includes("latest post")).click());
  await page.waitForFunction(() => [...document.querySelectorAll(".stepcard h3")].some((e) => e.textContent.includes("could now trust")) || document.querySelector(".stepcard.fail"), { timeout: 60000 });
  check(!(await page.$(".stepcard.fail")), "a real post verifies step by step");
  for (const label of ["Change one bit of the record", "Change one bit of the commit", "Claim it's another account's", "Hide a key rotation"]) {
    const before = await page.$$eval(".stepcard", (c) => c.length);
    await page.$$eval("button", (b, l) => b.find((x) => x.textContent === l).click(), label);
    await page.waitForFunction((n) => document.querySelectorAll(".stepcard").length > n, { timeout: 8000 }, before);
    const text = await page.$$eval(".stepcard", (c) => c[c.length - 1].textContent);
    check(/Rejected/.test(text), `tamper: ${label}`, text.slice(0, 110));
  }
  await page.screenshot({ path: `${OUT}flow_verify.png`, fullPage: true });
  check(page.errors.length === 0, "no errors", page.errors.join(" | ").slice(0, 400));
  await page.close();
}

console.log("Home: a real proof runs in the hero");
{
  const page = await open();
  await go(page, "/");
  await page.waitForSelector(".livequote", { timeout: 40000 });
  const lines = await page.$$eval(".liveline.ok", (x) => x.length);
  check(lines === 5, "all five steps complete", String(lines));
  const feed = await (await fetch("https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=did:plc:z72i7hdynmk6r22z27h6tvur&limit=40&filter=posts_no_replies")).json();
  const real = feed.feed.find((f) => f.post.author.did === "did:plc:z72i7hdynmk6r22z27h6tvur").post.record.text;
  const q = await page.$eval(".livequote", (e) => e.textContent);
  check(q.includes(real.slice(0, 40)), "the quote is the real post's signed text", q.slice(0, 60));
  await page.$$eval(".livecard button", (b) => b[0].click());
  await sleep(50);
  await page.waitForSelector(".livequote", { timeout: 40000 });
  check(true, "run it again works");
  check(page.errors.length === 0, "no errors", page.errors.join(" | ").slice(0, 300));
  await page.screenshot({ path: `${OUT}new_home.png` });
  await page.close();
}

const REALPOSTS = (await (await fetch("https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=did:plc:z72i7hdynmk6r22z27h6tvur&limit=40&filter=posts_no_replies")).json()).feed.filter((f) => f.post.author.did === "did:plc:z72i7hdynmk6r22z27h6tvur").map((f) => `https://bsky.app/profile/bsky.app/post/${f.post.uri.split("/").pop()}`);

console.log("Describe it in words");
{
  const page = await open();
  await go(page, "/campaigns/new");
  const steps = () => page.$$eval(".stephead strong", (x) => x.map((e) => e.textContent));
  await page.type(".magic", `Like and repost ${REALPOSTS[0]}, comment "gm" on ${REALPOSTS[1]} or quote ${REALPOSTS[2]}, follow @bsky.app, 2 tTARI each, pool 40, for 10 days`);
  await page.$$eval(".magicbox button", (b) => b.find((x) => x.textContent === "Build it").click());
  await page.waitForFunction(() => document.querySelectorAll(".stepbox").length >= 5 && document.querySelectorAll(".postcard").length >= 4, { timeout: 25000 });
  await sleep(200);
  check((await steps()).join("|") === "Like a post|Repost a post|Reply to a post|Quote a post|Follow an account", "words become steps", (await steps()).join("|"));
  const sent = await page.$eval(".sentence", (e) => e.textContent);
  check(sent.includes("saying “gm”") && sent.includes(" or quote"), "the sentence shows wording and either/or", sent);
  check(await page.$$eval(".andline.or", (x) => x.length === 1), "the or shows on the board");
  check((await page.$eval(".side", (e) => e.textContent)).includes("20 people"), "reward and pool applied");
  check(!(await page.$eval(".side", (e) => e.textContent.includes("Before this can launch"))), "valid straight away");
  await page.screenshot({ path: `${OUT}new_builder.png`, fullPage: true });
  await page.close();
}

console.log("Board extras");
{
  const page = await open(1280, 1600);
  await go(page, "/campaigns/new");
  const n = () => page.$$eval(".stepbox", (x) => x.length);
  const pal = async (l) => { for (const b of await page.$$(".paltile")) if ((await b.evaluate((e) => e.textContent)).includes(l)) return b; };
  await (await pal("Comment")).click(); await sleep(60);
  await (await pal("Like")).click(); await sleep(60);
  // several links pasted into one step become one step each
  const box = (await page.$$(".stepbox > input"))[1];
  await box.click();
  await page.evaluate((t) => { const i = document.querySelectorAll(".stepbox > input")[1]; i.value = t; i.dispatchEvent(new Event("change")); }, `${REALPOSTS[0]} ${REALPOSTS[1]} ${REALPOSTS[2]}`);
  await page.waitForFunction(() => document.querySelectorAll(".stepbox").length === 4 && document.querySelectorAll(".postcard").length >= 3, { timeout: 20000 });
  check(true, "three pasted links make three like steps");
  // and / or switch
  await page.$$eval(".andline", (b) => b[0].click()); await sleep(80);
  check(await page.$$eval(".andline.or", (x) => x.length === 1), "clicking and makes it or");
  check((await page.$eval(".sentence", (e) => e.textContent)).includes(" or "), "sentence follows");
  // undo
  await page.$$eval("button", (b) => b.find((x) => x.textContent === "Undo").click()); await sleep(80);
  check(await page.$$eval(".andline.or", (x) => x.length === 0), "undo reverts it");
  // duplicate
  const before = await n();
  await page.$$eval("button[aria-label='Duplicate step 2']", (b) => b[0].click()); await sleep(80);
  check((await n()) === before + 1, "duplicate adds a step");
  await page.$$eval("button", (b) => b.find((x) => x.textContent === "Undo").click()); await sleep(80);
  check((await n()) === before, "undo removes it, links intact");
  // wording on a comment
  await page.type(".stepbox .field input", "gm");
  await sleep(80);
  check((await page.$eval(".sentence", (e) => e.textContent)).includes("saying “gm”"), "must-say joins the sentence");
  // what-if slider
  const slide = await page.$(".side input[type=range]");
  const t0 = await page.$eval(".whatifout", (e) => e.textContent);
  await slide.evaluate((e) => { e.value = "7"; e.dispatchEvent(new Event("input")); });
  await sleep(60);
  const t1 = await page.$eval(".whatifout", (e) => e.textContent);
  check(t1 !== t0 && t1.startsWith("7 people claim: 7 tTARI paid, 93 tTARI"), "what-if slider updates", t1);
  check(await page.$eval(".side .questcard svg", (e) => e.querySelectorAll("circle").length > 10), "quest art draws");
  await page.$eval("input[maxlength='64']", (e) => { e.value = "Autosave test"; e.dispatchEvent(new Event("input")); });
  await sleep(600);
  // autosave survives leaving the page
  await go(page, "/me");
  check((await page.$eval("main", (e) => e.textContent)).includes("Autosave test"), "the draft shows in My campaigns");
  await page.screenshot({ path: `${OUT}new_me.png`, fullPage: true });
  await page.$$eval("a.btn.primary", (a) => a.find((x) => x.textContent === "Keep editing").click());
  await sleep(600);
  await page.waitForSelector(".postcard", { timeout: 15000 });
  check((await n()) === before, "reopening restores every step");
  check(await page.$eval("input[maxlength='64']", (e) => e.value === "Autosave test"), "reopening restores the name");
  check(await page.$$eval(".stepbox .field input", (x) => x.some((e) => e.value === "gm")), "reopening restores the wording");
  // preview and either/or eligibility, then back to the builder as a template
  await page.$$eval("a.btn", (a) => a.find((x) => x.textContent.includes("Preview the claim")).click());
  await sleep(500);
  check(await page.$eval(".claimart svg", (e) => !!e), "claim page shows the art");
  await page.$$eval("a.btn", (a) => a.find((x) => x.textContent === "Use this as a template").click());
  await sleep(600);
  check((await n()) === before, "a preview opens back in the builder");
  // deleting asks first
  await go(page, "/me");
  const del = () => page.$$eval("button", (b) => b.find((x) => /Delete|Tap again/.test(x.textContent)).click());
  const count = () => page.$$eval(".questcard", (x) => x.length);
  const c0 = await count();
  await del(); await sleep(60);
  check((await count()) === c0, "first tap on delete only arms it");
  await del(); await sleep(60);
  check((await count()) === c0 - 1, "second tap deletes");
  check(page.errors.length === 0, "no errors", page.errors.join(" | ").slice(0, 300));
  await page.close();
}

console.log("Either/or on the claim page, against a real account");
{
  const feed = (await (await fetch("https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=did:plc:z72i7hdynmk6r22z27h6tvur&limit=40&filter=posts_no_replies")).json()).feed.filter((f) => f.post.author.did === "did:plc:z72i7hdynmk6r22z27h6tvur");
  const words = feed[0].post.record.text.split(/\s+/).slice(0, 2).join(" ");
  const base = { v: 1, name: "OrTest", about: "", reward: "1000000", budget: "5000000", rounds: 1, roundDays: 7, bonus: "0", maxReferrals: 0, startsInDays: 0, days: 3 };
  const enc = (rules) => Buffer.from(JSON.stringify({ ...base, rules })).toString("base64url");
  const page = await open();
  // a post rule that fails, or one that passes: qualifies
  await go(page, `/c/preview#${enc([{ kind: 3, target: "never-in-any-post-zzqq" }, { kind: 3, target: words, or: true }])}`);
  await page.type("input[aria-label='Bluesky handle']", "bsky.app");
  await page.$$eval("button[type=submit]", (b) => b[0].click());
  await page.waitForSelector(".note.ok", { timeout: 60000 });
  check(true, "one side of an either/or is enough");
  check((await page.$eval(".progress", (e) => e.textContent)).includes("1 of 1"), "progress counts the group once");
  check(await page.$eval(".claimart", (e) => e.classList.contains("won")), "the card celebrates");
  // both sides failing: not eligible
  await go(page, "/");
  await page.goto(`${BASE}/c/preview#${enc([{ kind: 3, target: "never-in-any-post-zzqq" }, { kind: 3, target: "also-never-zzqq", or: true }])}`, { waitUntil: "networkidle2" });
  await page.reload({ waitUntil: "networkidle2" });
  await page.type("input[aria-label='Bluesky handle']", "bsky.app");
  await page.$$eval("button[type=submit]", (b) => b[0].click());
  await page.waitForSelector(".note.warn strong", { timeout: 2000 });
  await page.waitForFunction(() => /0 of 1/.test(document.querySelector(".progress")?.textContent ?? "") && !document.querySelector("form ~ .steps .stepcard.run"), { timeout: 60000 });
  await sleep(200);
  check(!(await page.$(".note.ok")), "neither side: not eligible");
  await page.close();
}

console.log("Sapient (mock wallet implementing the extension's API)");
{
  const KEY = "f2c27a21e63e7709434bec061bbb76bdb1d49717f18daec8a1574b3350ffab19";
  const ADDR = "otl_esm_17tp85g0x8emsjs6tasrphwmkhkcaf9ch7xx6aj9p2a9nx58l4vva9jyffdc8vvaxu55ax3kzdmu6m2k23y640usryeqph63fj2l7vuqu9el5r";
  const page = await open();
  await page.evaluateOnNewDocument((addr) => {
    const approved = () => sessionStorage.getItem("mock-approved") === "1";
    window.__calls = [];
    window.tariProviders = [{
      info: { name: "Sapient" },
      async request({ method }) {
        window.__calls.push(method);
        switch (method) {
          case "tari_getAccounts": return approved() ? ["component_mock"] : [];
          case "tari_requestAccounts": sessionStorage.setItem("mock-approved", "1"); return ["component_mock"];
          case "tari_getWalletAddress": return addr;
          case "tari_getNetwork": return "esmeralda";
          case "tari_disconnect": sessionStorage.removeItem("mock-approved"); return null;
          case "tari_getBalances": return [{ resourceAddress: "resource_0101010101010101010101010101010101010101010101010101010101010101", amount: "12500000" }];
          default: throw new Error(`unexpected ${method}`);
        }
      },
    }];
  }, ADDR);
  await go(page, "/me");
  check(!(await page.evaluate(() => window.__calls.includes("tari_requestAccounts"))), "no popup until asked");
  check((await page.$eval(".walletchip", (e) => e.textContent)) === "Connect Sapient", "header offers to connect");
  await page.$eval(".walletchip button", (b) => b.click());
  await page.waitForSelector(".chipbtn.on", { timeout: 4000 });
  check(true, "connecting shows the address in the header");
  await sleep(150);
  check((await page.$eval("main", (e) => e.textContent)).includes("12.5 tTARI"), "balance shows");
  // a draft made while connected belongs to this wallet
  await go(page, "/campaigns/new?do=0");
  await page.waitForSelector(".chipbtn.on", { timeout: 4000 });
  await page.$eval("input[maxlength='64']", (e) => { e.value = "Wallet draft"; e.dispatchEvent(new Event("input")); });
  await sleep(600);
  check(await page.evaluate((k) => JSON.parse(localStorage.getItem("atp-drafts")).some((d) => d.spec.name === "Wallet draft" && d.owner === k), KEY), "the draft is filed under the wallet's key");
  await go(page, "/me");
  await page.waitForSelector(".chipbtn.on", { timeout: 4000 });
  await sleep(150);
  check((await page.$eval("main", (e) => e.textContent)).includes("Wallet draft"), "My campaigns lists it");
  await page.screenshot({ path: `${OUT}new_me_wallet.png`, fullPage: true });
  // the claim page uses the wallet's key
  const feed = (await (await fetch("https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=did:plc:z72i7hdynmk6r22z27h6tvur&limit=40&filter=posts_no_replies")).json()).feed.filter((f) => f.post.author.did === "did:plc:z72i7hdynmk6r22z27h6tvur");
  const words = feed[0].post.record.text.split(/\s+/).slice(0, 2).join(" ");
  const enc = Buffer.from(JSON.stringify({ v: 1, name: "W", about: "", rules: [{ kind: 3, target: words }], reward: "1000000", budget: "5000000", rounds: 1, roundDays: 7, bonus: "0", maxReferrals: 0, startsInDays: 0, days: 3 })).toString("base64url");
  await page.goto(`${BASE}/c/preview#${enc}`, { waitUntil: "networkidle2" });
  await page.reload({ waitUntil: "networkidle2" });
  await page.type("input[aria-label='Bluesky handle']", "bsky.app");
  await page.$$eval("button[type=submit]", (b) => b[0].click());
  await page.waitForSelector(".note.ok", { timeout: 60000 });
  await page.waitForFunction(() => [...document.querySelectorAll("pre")].some((e) => e.textContent.includes("tari-quest:")), { timeout: 5000 });
  check(await page.$eval("input[aria-label='Wallet public key']", (e, k) => e.value === k, KEY), "claim post uses the connected wallet");
  await page.screenshot({ path: `${OUT}new_claim.png`, fullPage: true });
  await go(page, "/me");
  await page.waitForSelector(".chipbtn.on", { timeout: 4000 });
  await page.$$eval("button", (b) => b.find((x) => x.textContent === "Disconnect").click());
  await sleep(200);
  check((await page.$eval(".walletchip", (e) => e.textContent)) === "Connect Sapient", "disconnect works");
  check(page.errors.length === 0, "no errors", page.errors.join(" | ").slice(0, 300));
  await page.close();
  // no wallet installed
  const none = await open();
  await go(none, "/me");
  await sleep(1400);
  check((await none.$eval("main", (e) => e.textContent)).includes("Sapient isn't installed"), "no wallet: explains and still works");
  await none.close();
}

console.log("Touch screen");
{
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 1200, hasTouch: true, isMobile: true });
  await go(page, "/campaigns/new?do=0,1,4");
  const order = () => page.$$eval(".stephead strong", (x) => x.map((e) => e.textContent).join("|"));
  const o0 = await order();
  const grips = await page.$$(".grip");
  await grips[2].evaluate((e) => e.scrollIntoView({ block: "center" }));
  await sleep(200);
  const g = await grips[2].boundingBox();
  const first = await (await page.$$(".stepbox"))[0].boundingBox();
  await page.touchscreen.touchStart(g.x + g.width / 2, g.y + g.height / 2);
  for (let i = 1; i <= 8; i++) { await page.touchscreen.touchMove(g.x + g.width / 2, g.y + g.height / 2 + ((first.y + 4 - g.y - g.height / 2) * i) / 8); await sleep(25); }
  await page.touchscreen.touchEnd();
  await sleep(200);
  check((await order()) !== o0 && (await order()).startsWith("Reply to a post"), "dragging a grip by touch reorders", `${o0} -> ${await order()}`);
  // tap a palette tile
  const before = await page.$$eval(".stepbox", (x) => x.length);
  const tile = (await page.$$(".paltile"))[0];
  await tile.tap();
  await sleep(150);
  check((await page.$$eval(".stepbox", (x) => x.length)) === before + 1, "tapping a tile adds exactly one step");
  check((await overflow(page)) <= 0, "no sideways scroll");
  await page.screenshot({ path: `${OUT}new_phone.png`, fullPage: true });
  await page.close();
}

console.log("Use cases and status");
{
  const page = await open();
  await go(page, "/use-cases");
  const all = await page.$$eval(".grid .card", (c) => c.length);
  await page.type("input[type=search]", "airdrop");
  await sleep(100);
  const some = await page.$$eval(".grid .card", (c) => c.length);
  check(some > 0 && some < all, "search narrows the list", `${all} -> ${some}`);
  await go(page, "/status");
  await sleep(2500);
  const net = await page.$eval("main", (m) => m.textContent);
  console.log("        network card:", net.match(/(Network responding|Couldn't reach the network)[^.]*\.?[^.]*\./)?.[0]?.slice(0, 110));
  await page.close();
}

await browser.close();
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
