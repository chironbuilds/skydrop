// Checks on the deployed sites: list storage at real sizes, and that both sites carry the new contract address.
const A = "abcdefghijklmnopqrstuvwxyz234567";
const did = (tag, i) => { let s = ""; let n = i; for (let k = 0; k < 8; k++) { s = A[n % 32] + s; n = Math.floor(n / 32); } return `did:plc:${tag}${s.padStart(23, "a")}`; };
for (const [n, tag] of [[2000, "p"], [20000, "q"]]) {
  const list = Array.from({ length: n }, (_, i) => ({ did: did(tag, i), amount: String(1000 + i) }));
  const body = JSON.stringify(list);
  const t = Date.now();
  const r = await fetch("https://skydrop.tari.mw/api/list", { method: "POST", body });
  const text = await r.text();
  console.log(`store ${n} (${(body.length / 1024).toFixed(0)} KB): ${r.status} ${text.slice(0, 100)} in ${Date.now() - t} ms`);
  const root = (() => { try { return JSON.parse(text).root; } catch { return null; } })();
  if (root) {
    const b = await fetch(`https://skydrop.tari.mw/api/list/${root}`);
    console.log(`  read back: ${b.status} ${(await b.json()).length} accounts, CORS ${b.headers.get("access-control-allow-origin")}`);
  }
}
const NEW = "template_d911cfc348ffb30eb046776e4746d3880898f059bae997c2735447a4f0866060";
for (const page of ["https://skydrop.tari.mw/quests", "https://atproto.tari.mw/"]) {
  const origin = new URL(page).origin;
  const html = await (await fetch(page)).text();
  const seen = new Set(), todo = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.js)"/g)].map((m) => m[1]);
  let found = false;
  while (todo.length) {
    const u = todo.pop();
    if (seen.has(u)) continue;
    seen.add(u);
    const js = await (await fetch(origin + u)).text();
    if (js.includes(NEW)) found = true;
    for (const m of js.matchAll(/["'`(/.]*(assets\/[A-Za-z0-9_-]+\.js)/g)) todo.push("/" + m[1]);
    for (const m of js.matchAll(/["'`]\.\/([A-Za-z0-9_-]+\.js)["'`]/g)) todo.push("/assets/" + m[1]);
  }
  console.log(`${page}: new contract in ${found ? "its code" : "NONE OF ITS CODE"} (${seen.size} scripts)`);
}
