/**
 * Waits for Ootle mainnet to go live, then:
 *   1. Publishes the Skydrop contracts (LinkRegistry template + Campaign template + Verifier template + one LinkRegistry instance)
 *   2. Writes the returned addresses into web-atproto/src/data/deployment.ts
 *   3. Runs `npm run build:all` in the repo
 *   4. Redeploys both Cloudflare Workers (skydrop + atproto-ootle)
 *
 * Run from your PUBLISHER FOLDER (the one containing publisher.json and node_modules):
 *
 *   node <repo>/scripts/launch-deploy.mjs <path-to-wasm-folder>
 *
 * Prerequisites in the publisher folder:
 *   - node_modules               tari-cipherseed, @chironbuilder/ootle-sdk, @tari-project/ootle, etc.
 *   - ../confidential-rcv-web/lib/derive.mjs  (sibling folder)
 *   - burn-proof.json            (optional) exported from Tari Universe — auto-claims before publishing
 *
 * Set your seed before running (never paste in chat):
 *   $env:TARI_SEED_PHRASE = "word1 word2 ... word24"
 *   node <repo>/scripts/launch-deploy.mjs <path-to-wasm-folder>
 *
 * Wasm files needed:
 *   bsky_campaign.wasm, bsky_link_registry.wasm, bsky_verifier.wasm
 *   (in WSL: ~/skydrop-050-opt; on Windows: \\wsl$\Ubuntu\home\<user>\skydrop-050-opt)
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, execFileSync } from "node:child_process";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wasmDir = resolve(process.argv[2] ?? ".");

const MAINNET_INDEXER = "https://indexer-a.ootle.tari.com";
const DEPLOYMENT_TS = join(repo, "web-atproto", "src", "data", "deployment.ts");
// 2026-11-11 05:00:00 UTC — start polling 15 minutes early
const LAUNCH_MS = Date.UTC(2026, 10, 11, 5, 0, 0);
const POLL_START_MS = LAUNCH_MS - 15 * 60 * 1000;
const POLL_INTERVAL_MS = 10_000;
// How long to wait for the publish to settle before retrying (the indexer may not be ready)
const PUBLISH_RETRY_DELAY_MS = 20_000;
const MAX_PUBLISH_ATTEMPTS = 6;

// ─── Colour helpers ───────────────────────────────────────────────────────────
const c = {
  green:  (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red:    (s) => `\x1b[31m${s}\x1b[0m`,
  bold:   (s) => `\x1b[1m${s}\x1b[0m`,
  cyan:   (s) => `\x1b[36m${s}\x1b[0m`,
};
const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
const log  = (...a) => console.log(c.cyan(`[${stamp()}]`), ...a);
const ok   = (...a) => console.log(c.green(`[${stamp()}] ✓`), ...a);
const warn = (...a) => console.log(c.yellow(`[${stamp()}] ⚠`), ...a);
const fail = (...a) => { console.error(c.red(`[${stamp()}] ✗`), ...a); process.exit(1); };

// ─── 1. Preflight checks ──────────────────────────────────────────────────────
log("Skydrop launch-deploy preflight…");

// Seed can come from (in priority order):
//   1. TARI_SEED_PHRASE env var  — 24-word seed phrase, space-separated
//   2. PUBLISHER_ENTROPY env var — raw entropy as hex string
//   3. publisher.json            — { "entropy": "<hex>" }
let entropyBytes; // Uint8Array passed to OotleAccount.fromSeed / deriveAccountKeys

if (process.env.TARI_SEED_PHRASE) {
  const phrase = process.env.TARI_SEED_PHRASE.trim();
  const words = phrase.split(/\s+/);
  if (words.length !== 24) fail(`TARI_SEED_PHRASE must be 24 words, got ${words.length}.`);
  log("Seed phrase set — deciphering…");
  // Dynamically load tari-cipherseed from the publisher folder's node_modules
  const { createRequire } = await import("node:module");
  const req2 = createRequire(join(process.cwd(), "noop.js"));
  const { pathToFileURL: p2f } = await import("node:url");
  const { importWalletSeed } = await import(p2f(req2.resolve("tari-cipherseed")).href + `?t=${Date.now()}`);
  const seed = await importWalletSeed(phrase);
  entropyBytes = seed.entropy;
  ok("Seed phrase deciphered.");
} else if (process.env.PUBLISHER_ENTROPY) {
  const hex = process.env.PUBLISHER_ENTROPY.trim();
  if (!/^[0-9a-f]+$/i.test(hex)) fail("PUBLISHER_ENTROPY must be hex chars.");
  entropyBytes = Uint8Array.from(hex.match(/.{2}/g).map(b => parseInt(b, 16)));
  log("Using entropy from PUBLISHER_ENTROPY env variable.");
} else if (existsSync("publisher.json")) {
  let hex;
  try { ({ entropy: hex } = JSON.parse(readFileSync("publisher.json", "utf8"))); } catch (e) { fail("Bad publisher.json:", e.message); }
  if (!/^[0-9a-f]+$/i.test(hex)) fail("publisher.json entropy must be hex.");
  entropyBytes = Uint8Array.from(hex.match(/.{2}/g).map(b => parseInt(b, 16)));
  log("Using entropy from publisher.json.");
} else {
  fail(
    "No seed found. Set one of these before running:\n" +
    "  $env:TARI_SEED_PHRASE = \"word1 word2 ... word24\"   (your 24-word Tari seed phrase)\n" +
    "  $env:PUBLISHER_ENTROPY = \"<hex>\"                   (raw entropy hex)\n" +
    "  or create publisher.json: { \"entropy\": \"<hex>\" }"
  );
}

for (const f of ["bsky_campaign.wasm", "bsky_link_registry.wasm", "bsky_verifier.wasm"]) {
  if (!existsSync(join(wasmDir, f))) fail(`Missing wasm: ${join(wasmDir, f)}`);
}
if (!existsSync("node_modules/@chironbuilder/ootle-sdk"))
  fail("node_modules not found. Run: npm install @chironbuilder/ootle-sdk @tari-project/ootle @tari-project/ootle-indexer @tari-project/ootle-secret-key-wallet");
const deriveLib = resolve("../confidential-rcv-web/lib/derive.mjs");
if (!existsSync(deriveLib))
  fail("Missing", deriveLib, "\nThis folder must be a sibling of confidential-rcv-web/");
if (!existsSync(DEPLOYMENT_TS))
  fail("Missing", DEPLOYMENT_TS);
ok("All prerequisites present.");

// Check wrangler is available
const wr = spawnSync("npx", ["wrangler", "--version"], { shell: true, cwd: join(repo, "web"), encoding: "utf8" });
if (wr.status !== 0) fail("wrangler not found. Run: npm install in", repo);
ok("wrangler OK:", wr.stdout?.trim());

// ─── 2. Pre-build (so the rebuild after publish is fast) ──────────────────────
const buildAll = (label) => {
  log(`Building ${label} (build:all)…`);
  for (const dir of ["web", "web-atproto"]) {
    execFileSync("npm", ["run", "build:all"], { cwd: join(repo, dir), shell: true, stdio: "inherit" });
  }
  ok(`${label} done.`);
};

try {
  buildAll("pre-build");
} catch (e) {
  fail("build:all failed — fix it before leaving:", e.message);
}

// ─── 3. Wait for mainnet ──────────────────────────────────────────────────────
const msUntilPollStart = POLL_START_MS - Date.now();
if (msUntilPollStart > 0) {
  const mins = Math.ceil(msUntilPollStart / 60_000);
  log(`Waiting ${mins} minute(s) before polling starts (polls begin at 04:45 UTC)…`);
  await new Promise((r) => setTimeout(r, msUntilPollStart));
}

log("Polling for mainnet…");
let mainnetLive = false;
while (!mainnetLive) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8_000);
    const res = await fetch(`${MAINNET_INDEXER}/network`, { signal: ctrl.signal });
    clearTimeout(t);
    if (res.ok) {
      const body = await res.json();
      log("Indexer replied:", JSON.stringify(body));
      // network_byte===0 is mainnet per test-network.ts; also accept network==="mainnet" as a fallback
      const isMainnet = body?.network_byte === 0 || body?.network === "mainnet";
      if (isMainnet) {
        ok(c.bold("MAINNET IS LIVE!"), JSON.stringify(body));
        mainnetLive = true;
        break;
      }
      log("Not mainnet yet (network_byte=" + body?.network_byte + " network=" + body?.network + ")");
    } else {
      log("Indexer returned", res.status);
    }
  } catch (e) {
    log("Indexer not reachable:", e.message);
  }
  if (!mainnetLive) await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
}

// ─── 4. Claim the burn (if burn-proof.json is present) ───────────────────────
// Export the burn proof from whatever wallet you used to burn:
//   - Tari Universe: Burn tab → Export proof → save as burn-proof.json in this folder
//   - L1 wallet UI : Burn history → export icon → save as burn-proof.json
// Format: the JSON object returned by assembleBurnClaimProof (what account.claimBurn takes).
// If the file is absent the step is skipped (useful if TU auto-claimed or the account is prefunded).

const burnProofPath = resolve("burn-proof.json");
if (existsSync(burnProofPath)) {
  log("burn-proof.json found — claiming burn before publishing…");
  try {
    const { createRequire } = await import("node:module");
    const req2 = createRequire(resolve("noop.js"));
    const load2 = async (name) => {
      const { pathToFileURL: p } = await import("node:url");
      return import(p(req2.resolve(name)).href + `?t=${Date.now()}`);
    };
    const { deriveAccountKeys, OotleAccount } = await load2("@chironbuilder/ootle-sdk");
    const { Network }                          = await load2("@tari-project/ootle");
    const { IndexerProvider }                  = await load2("@tari-project/ootle-indexer");
    const { SecretKeyWallet }                  = await load2("@tari-project/ootle-secret-key-wallet");

    const { ownerSecret, viewSecret } = deriveAccountKeys(entropyBytes, 0);
    const provider = await IndexerProvider.connect({ url: MAINNET_INDEXER, network: Network.MainNet });
    const signer   = SecretKeyWallet.fromSecretKey(ownerSecret, Network.MainNet, viewSecret);
    const account  = OotleAccount.fromSeed(entropyBytes, 0, "mainnet");

    // Check if already claimed (tombstone on-chain)
    const { burnClaimedOnOotle } = await load2("@chironbuilder/ootle-sdk").catch(() => ({}));
    const burnProof = JSON.parse(readFileSync(burnProofPath, "utf8"));
    // Handle both TU export format (claim_proof.output_proof.output.commitment)
    // and our wallet's internal format (parts.commitmentHex)
    const commitmentHex =
      burnProof?.claim_proof?.output_proof?.output?.commitment ??
      burnProof?.parts?.commitmentHex ??
      burnProof?.commitment_hex ??
      burnProof?.commitmentHex;

    if (commitmentHex && burnClaimedOnOotle) {
      const already = await burnClaimedOnOotle(commitmentHex, "mainnet").catch(() => null);
      if (already !== null) {
        ok("Burn already claimed (tombstone found). Skipping claim step.");
      } else {
        log("Submitting burn claim…");
        const { transactionId, claimedAmount } = await account.claimBurn(burnProof);
        ok("Burn claim submitted. tx:", transactionId, "— claimed:", String(claimedAmount));

        // Wait up to 3 minutes for the claim to be indexed
        log("Waiting for claim to finalise…");
        let claimed = null;
        for (let i = 0; i < 36 && claimed === null; i++) {
          await new Promise((r) => setTimeout(r, 5_000));
          claimed = await burnClaimedOnOotle(commitmentHex, "mainnet").catch(() => null);
          if (claimed === null) log("Not indexed yet, waiting 5s…");
        }
        if (claimed !== null) {
          ok("Claim confirmed on-chain. Amount:", String(claimed));
        } else {
          warn("Claim not visible in indexer yet — proceeding to publish anyway (it may still land).");
        }
      }
    } else {
      // Fallback: just fire the claim and proceed regardless of on-chain confirmation
      log("commitmentHex not found in proof or burnClaimedOnOotle unavailable — firing claim and proceeding…");
      const { transactionId } = await account.claimBurn(burnProof);
      ok("Claim submitted. tx:", transactionId);
      log("Waiting 30s for claim to reach validators before publishing…");
      await new Promise((r) => setTimeout(r, 30_000));
    }
  } catch (e) {
    warn("Burn claim failed:", e.message);
    warn("Proceeding to publish — make sure the publisher account has enough TARI.");
  }
} else {
  log("No burn-proof.json found — skipping claim step (account must already have TARI).");
  log("To claim automatically: export proof from your wallet, save as burn-proof.json in", process.cwd());
}

// ─── 4b. Publish contracts ────────────────────────────────────────────────────
// deploy-campaigns.mjs reads publisher.json from cwd. Write it from entropyBytes,
// run the publish, then immediately delete it so the key isn't left on disk.
const entropyHex = Array.from(entropyBytes, b => b.toString(16).padStart(2, "0")).join("");
const pubJsonPath = join(process.cwd(), "publisher.json");
writeFileSync(pubJsonPath, JSON.stringify({ entropy: entropyHex }), { mode: 0o600 });
log("publisher.json written (will be deleted after publish).");

log("Publishing Skydrop contracts on mainnet…");

let addresses = null;
for (let attempt = 1; attempt <= MAX_PUBLISH_ATTEMPTS; attempt++) {
  log(`Publish attempt ${attempt}/${MAX_PUBLISH_ATTEMPTS}…`);
  const result = spawnSync(
    "node",
    [join(repo, "scripts", "deploy-campaigns.mjs"), wasmDir, "go"],
    {
      cwd: process.cwd(),
      shell: false,
      encoding: "utf8",
      env: { ...process.env, SKYDROP_NET: "mainnet" },
      timeout: 300_000, // 5 minutes per attempt
    }
  );

  const output = (result.stdout ?? "") + (result.stderr ?? "");
  console.log(output); // Always show the full output

  if (result.status === 0) {
    // Parse the addresses from the output
    const campaignTemplate = output.match(/campaignTemplate:\s*"([^"]+)"/)?.[1];
    const linkRegistry    = output.match(/linkRegistry:\s*"([^"]+)"/)?.[1];
    const verifier        = output.match(/verifier:\s*"([^"]+)"/)?.[1];
    const linkRegTemplate = output.match(/LinkRegistry template:\s*(\S+)/)?.[1];

    if (campaignTemplate && linkRegistry && verifier) {
      addresses = { campaignTemplate, linkRegistry, verifier, linkRegTemplate };
      ok("Contracts published:");
      ok("  campaignTemplate:", campaignTemplate);
      ok("  linkRegistry:    ", linkRegistry);
      ok("  verifier:        ", verifier);
      if (linkRegTemplate) ok("  linkReg template:", linkRegTemplate);
      break;
    } else {
      warn("Script exited 0 but addresses not found in output — will retry.");
    }
  } else {
    warn(`Attempt ${attempt} failed (exit ${result.status}).`);
    if (/Not claimable yet|not live|503|523|network/i.test(output)) {
      warn("Network not ready yet — retrying in", PUBLISH_RETRY_DELAY_MS / 1000, "s…");
    }
  }

  if (attempt < MAX_PUBLISH_ATTEMPTS) {
    await new Promise((r) => setTimeout(r, PUBLISH_RETRY_DELAY_MS));
  }
}

// Delete publisher.json now — key no longer needed on disk
try { unlinkSync(pubJsonPath); log("publisher.json deleted."); } catch { warn("Could not delete publisher.json — delete it manually."); }

if (!addresses) {
  fail(
    "All publish attempts failed. The contracts were NOT deployed.\n" +
    "Your TARI is still in the publisher wallet — nothing was lost.\n" +
    "Try again manually:\n" +
    `  cd ${process.cwd()}\n` +
    `  SKYDROP_NET=mainnet node ${join(repo, "scripts", "deploy-campaigns.mjs")} ${wasmDir} go`
  );
}

// ─── 4c. Deploy the gift stack (Escrow + ClaimPolicy + TipPolicy) ─────────────
// deploy-gifts.mjs lives next to deploy-campaigns.mjs in the publisher folder (cwd).
let giftAddresses = null;
const deployGiftsMjs = join(process.cwd(), "deploy-gifts.mjs");
if (existsSync(deployGiftsMjs)) {
  log("Deploying gift stack (Escrow + ClaimPolicy + TipPolicy)…");
  for (let attempt = 1; attempt <= MAX_PUBLISH_ATTEMPTS; attempt++) {
    log(`Gift deploy attempt ${attempt}/${MAX_PUBLISH_ATTEMPTS}…`);
    const result = spawnSync(
      "node",
      [deployGiftsMjs, wasmDir, addresses.linkRegistry, "go"],
      {
        cwd: process.cwd(),
        shell: false,
        encoding: "utf8",
        env: { ...process.env, SKYDROP_NET: "mainnet" },
        timeout: 300_000,
      }
    );
    const output = (result.stdout ?? "") + (result.stderr ?? "");
    console.log(output);
    if (result.status === 0) {
      const escrow = output.match(/escrow:\s*"([^"]+)"/)?.[1];
      const claim  = output.match(/claim:\s*"([^"]+)"/)?.[1];
      const tip    = output.match(/tip:\s*"([^"]+)"/)?.[1];
      if (escrow && claim && tip) {
        giftAddresses = { escrow, claim, tip };
        ok("Gift stack deployed:");
        ok("  escrow:", escrow);
        ok("  claim: ", claim);
        ok("  tip:   ", tip);
        break;
      }
      warn("Gift deploy exited 0 but addresses not found — will retry.");
    } else {
      warn(`Gift attempt ${attempt} failed (exit ${result.status}).`);
    }
    if (attempt < MAX_PUBLISH_ATTEMPTS) await new Promise((r) => setTimeout(r, PUBLISH_RETRY_DELAY_MS));
  }
  if (!giftAddresses) {
    warn("Gift stack deploy failed after all attempts — continuing without it.");
    warn("Run deploy-gifts.mjs manually later and update KV + deployment.ts.");
  }
} else {
  warn("deploy-gifts.mjs not found in", process.cwd(), "— skipping gift stack.");
  warn("Copy it from skydrop-mainnet/ and run it manually later.");
}

// ─── 4d. Write addresses to KV immediately (site Workers serve them without rebuild) ──────────
const LAUNCH_STATE_KV = "58ad9c6377eb450bbccac4b9ef8448ac";
try {
  const addrJson = JSON.stringify({
    campaignTemplate: addresses.campaignTemplate,
    linkRegistry: addresses.linkRegistry,
    verifier: addresses.verifier,
    ...(giftAddresses ?? {}),
  });
  const kvResult = spawnSync(
    "npx",
    ["wrangler", "kv", "key", "put", "--namespace-id", LAUNCH_STATE_KV, "mainnet:addresses", addrJson],
    { cwd: repo, shell: true, encoding: "utf8", timeout: 30_000 }
  );
  if (kvResult.status === 0) {
    ok("Addresses written to KV — site Workers will serve them immediately.");
  } else {
    warn("KV write failed (Workers will serve addresses after redeploy):", kvResult.stderr?.trim());
  }
  // Also write a launch timestamp so the status page knows it's done
  spawnSync("npx", ["wrangler", "kv", "key", "put", "--namespace-id", LAUNCH_STATE_KV, "launch_complete", new Date().toISOString()],
    { cwd: repo, shell: true, encoding: "utf8", timeout: 30_000 });
} catch (e) {
  warn("KV write error:", e.message);
}

// ─── 5. Write addresses into deployment.ts ───────────────────────────────────
log("Updating deployment.ts with mainnet addresses…");
let src = readFileSync(DEPLOYMENT_TS, "utf8");

const patch = (key, value) => {
  const re = new RegExp(`(MAINNET[^}]*?${key}:\\s*)"[^"]*"`, "s");
  if (!re.test(src)) { warn(`Could not patch ${key} in deployment.ts — patch manually.`); return; }
  src = src.replace(re, `$1"${value}"`);
};

patch("campaignTemplate", addresses.campaignTemplate);
patch("linkRegistry",     addresses.linkRegistry);
patch("verifier",         addresses.verifier);
if (giftAddresses) {
  patch("escrow", giftAddresses.escrow);
  patch("claim",  giftAddresses.claim);
  patch("tip",    giftAddresses.tip);
}
writeFileSync(DEPLOYMENT_TS, src, "utf8");
ok("deployment.ts updated.");

// ─── 6. Rebuild with real addresses ──────────────────────────────────────────
try {
  buildAll("rebuild");
} catch (e) {
  fail("build:all failed after address patch:", e.message);
}

// ─── 7. Deploy Cloudflare Workers ────────────────────────────────────────────
const deploy = (dir, label) => {
  log(`Deploying ${label} Worker…`);
  try {
    execFileSync("npx", ["wrangler", "deploy"], { cwd: join(repo, dir), shell: true, stdio: "inherit" });
    ok(`${label} deployed.`);
  } catch (e) {
    warn(`${label} deploy failed:`, e.message, "— redeploy manually:\n  cd", join(repo, dir), "&& npx wrangler deploy");
  }
};

// Deploy sequentially (wrangler doesn't like parallel deploys against the same account)
deploy("web", "skydrop");
deploy("web-atproto", "atproto-ootle");

// ─── Done ─────────────────────────────────────────────────────────────────────
console.log("");
ok(c.bold("ALL DONE."));
ok("Skydrop is live on Ootle mainnet.");
ok("campaignTemplate:", addresses.campaignTemplate);
ok("linkRegistry:    ", addresses.linkRegistry);
ok("verifier:        ", addresses.verifier);
console.log("");
log("If MAINNET_BURN_CLAIMS_LIVE is still false in the L1 wallet, flip it once you've verified a real claim works.");
