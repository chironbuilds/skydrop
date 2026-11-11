// Puts a site's mainnet build inside its testnet build, so one Worker can serve either at launch without a deploy.
// Hashed files share /assets, since their names can't clash; each page goes under /mainnet.
//
//   node scripts/merge-mainnet.mjs <dist> <dist-mainnet>
import { cpSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const [dist, mainnet] = process.argv.slice(2).map((p) => resolve(p));
if (!dist || !mainnet) throw new Error("Usage: merge-mainnet.mjs <dist> <dist-mainnet>");

rmSync(join(dist, "mainnet"), { recursive: true, force: true });
mkdirSync(join(dist, "mainnet"));
for (const name of readdirSync(mainnet)) {
  const from = join(mainnet, name);
  if (name.endsWith(".html")) cpSync(from, join(dist, "mainnet", name));
  else if (name === "assets") cpSync(from, join(dist, "assets"), { recursive: true, force: false, errorOnExist: false });
  else if (!statSync(from).isDirectory() && !name.endsWith(".wasm")) cpSync(from, join(dist, name), { force: false, errorOnExist: false });
}
console.log("merged", mainnet, "into", dist);
