// Full claim on the live component using the bot's own account as the Bluesky identity and a throwaway wallet
// as the claimant. Posts the claim code from the bot account, claims, collects immediately, then deletes the post.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AtpAgent } from "@atproto/api";
import * as chain from "../web/src/chain";
import * as bsky from "../web/src/bsky";
import { builtinWallet } from "../web/src/wallet";
import { CONFIG } from "../web/src/config";

const here = dirname(fileURLToPath(import.meta.url));
const env: Record<string, string> = {};
for (const line of readFileSync(join(here, ".env"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
  if (m) env[m[1]!] = m[2]!;
}
const seed = process.env.E2E_SEED!;
chain.initStorage();
const account = chain.openAccount(seed);
const w = await builtinWallet(account, () => chain.tariBalance(account));
const provider = await account.getProvider();
console.log("claimant balance", chain.formatTari(await w.balance()));

const agent = new AtpAgent({ service: "https://bsky.social" });
await agent.login({ identifier: env.BSKY_HANDLE!, password: env.BSKY_APP_PASSWORD! });
const did = agent.session!.did;
const code = await bsky.claimCode(CONFIG.claim, did, w.publicKey);
const created = await agent.post({ text: `claim test ${code}`, createdAt: new Date().toISOString() });
const rkey = created.uri.split("/").pop()!;
console.log("posted", rkey);
try {
  await new Promise((r) => setTimeout(r, 4000));
  const proof = await bsky.buildClaimProof(did, rkey);
  const t0 = Date.now();
  await chain.startClaim(w, proof, (s) => console.log("  ·", s));
  console.log("claim started", ((Date.now() - t0) / 1000).toFixed(1), "s, epoch", await provider.getCurrentEpoch());
  for (let i = 0; i < 8; i++) {
    try {
      await chain.finalizeClaim(w, did, (s) => console.log("  ·", s));
      console.log("collected on try", i + 1, "balance", chain.formatTari(await w.balance()));
      break;
    } catch (e) {
      console.log("try", i + 1, "failed at epoch", await provider.getCurrentEpoch(), "->", chain.friendly(e));
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
} finally {
  await agent.com.atproto.repo.deleteRecord({ repo: did, collection: "app.bsky.feed.post", rkey });
  console.log("test post deleted");
}
