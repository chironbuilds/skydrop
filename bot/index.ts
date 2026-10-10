/**
 * Skydrop bot (stage 1: notifier + helper). It holds no funds and no Ootle keys, only a Bluesky login.
 *
 *  - Watches the BskyClaim escrow. When money arrives for a Bluesky account, it mentions that account once
 *    with a link to collect it (rate limited, with a per-account cooldown).
 *  - If someone mentions the bot with "claim" or "help", it replies once with the link.
 *
 * Starts in dry-run mode (prints what it would post). Set BOT_LIVE=1 and CLAIM_URL to go live.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AtpAgent, RichText } from "@atproto/api";
import { IndexerProvider } from "@tari-project/ootle-indexer";
import { Network, defaultIndexerUrl } from "@tari-project/ootle";

const here = dirname(fileURLToPath(import.meta.url));
const COMPONENT = "component_6aa79eaa110cc5b7b1fc672b3ad74d026259f6257884c565ed8d4ea529d69ec9";
const POLL_MS = 60_000;
const COOLDOWN_MS = 6 * 3600_000;
const MAX_POSTS_PER_HOUR = 20;
const REPLY_COOLDOWN_MS = 3600_000;

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(join(here, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith("#")) out[m[1]!] = m[2]!;
  }
  return out;
}

const env = loadEnv();
const LIVE = env.BOT_LIVE === "1" && !!env.CLAIM_URL;
const CLAIM_URL = (env.CLAIM_URL || "https://<claim-url-not-set>").replace(/\/$/, "");
const NOTIFY_MIN = BigInt(env.NOTIFY_MIN || "1000");
const ALWAYS = new Set((env.ALWAYS_NOTIFY || "").split(",").map((s) => s.trim()).filter(Boolean));

interface State {
  /** did -> fingerprints of deposits already announced */
  seen: Record<string, string[]>;
  lastNotified: Record<string, number>;
  repliedTo: Record<string, number>;
  handledNotifications: string[];
  postTimes: number[];
  initialised: boolean;
}

const STATE_FILE = join(here, "state.json");
const state: State = existsSync(STATE_FILE)
  ? JSON.parse(readFileSync(STATE_FILE, "utf8"))
  : { seen: {}, lastNotified: {}, repliedTo: {}, handledNotifications: [], postTimes: [], initialised: false };
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

const fmt = (micro: bigint): string => {
  const whole = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(6, "0").slice(0, 4).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
};

interface Dep {
  fp: string;
  amount: bigint;
  window: number;
}

async function readDeposits(provider: IndexerProvider): Promise<Record<string, Dep[]>> {
  const sub = await provider.getSubstate(COMPONENT);
  const comp = (sub.substate as { Component?: { body: { state: unknown[] } } }).Component;
  if (!comp) throw new Error("escrow component unreadable");
  const raw = comp.body.state[3] as Record<string, unknown[][]>;
  const out: Record<string, Dep[]> = {};
  for (const [did, list] of Object.entries(raw)) {
    out[did] = list.map((d) => {
      const sender = (d[0] as { hex: string }).hex;
      return { fp: `${sender}:${d[1]}:${d[2]}:${d[3]}`, amount: BigInt(d[1] as number), window: Number(d[3]) };
    });
  }
  return out;
}

const agent = new AtpAgent({ service: "https://bsky.social" });

async function post(text: string, reply?: { root: { uri: string; cid: string }; parent: { uri: string; cid: string } }) {
  const rt = new RichText({ text });
  await rt.detectFacets(agent);
  if (!LIVE) {
    log("[dry-run] would post:\n   " + text.replace(/\n/g, "\n   "));
    return;
  }
  const now = Date.now();
  state.postTimes = state.postTimes.filter((t) => now - t < 3600_000);
  if (state.postTimes.length >= MAX_POSTS_PER_HOUR) {
    log("rate limit reached; skipping a post");
    return;
  }
  await agent.post({ text: rt.text, facets: rt.facets, reply, langs: ["en"], createdAt: new Date().toISOString() });
  state.postTimes.push(now);
}

async function notifyDeposits(provider: IndexerProvider): Promise<void> {
  const all = await readDeposits(provider);
  const firstRun = !state.initialised;
  for (const [did, deps] of Object.entries(all)) {
    const known = new Set(state.seen[did] ?? []);
    const fresh = deps.filter((d) => !known.has(d.fp));
    state.seen[did] = deps.map((d) => d.fp);
    if (!fresh.length) continue;
    // First run only records what already existed, except accounts we deliberately test with.
    if (firstRun && !ALWAYS.has(did)) continue;
    const total = fresh.reduce((n, d) => n + d.amount, 0n);
    if (total < NOTIFY_MIN) {
      log(`skip ${did}: ${fmt(total)} is below the notify minimum`);
      continue;
    }
    if (Date.now() - (state.lastNotified[did] ?? 0) < COOLDOWN_MS && !ALWAYS.has(did)) {
      log(`skip ${did}: notified recently`);
      continue;
    }
    let handle: string;
    try {
      handle = (await agent.getProfile({ actor: did })).data.handle;
    } catch {
      log(`skip ${did}: profile not found`);
      continue;
    }
    if (handle === "handle.invalid") continue;
    const careful = fresh.some((d) => d.window > 0) ? "\nA short safety window protects larger transfers." : "";
    const text =
      `@${handle} 🎁 You have ${fmt(total)} tTARI waiting for you on Tari (testnet).\n` +
      `Prove you own this account and collect it. No wallet needed:\n${CLAIM_URL}/#/claim/${handle}${careful}`;
    await post(text);
    state.lastNotified[did] = Date.now();
  }
  state.initialised = true;
}

async function answerMentions(): Promise<void> {
  const { data } = await agent.listNotifications({ limit: 30 });
  const handled = new Set(state.handledNotifications);
  const me = agent.session!.did;
  for (const n of data.notifications.slice().reverse()) {
    if (handled.has(n.uri) || (n.reason !== "mention" && n.reason !== "reply") || n.author.did === me) continue;
    handled.add(n.uri);
    const rec = n.record as { text?: string; reply?: { root: { uri: string; cid: string } } };
    const text = (rec.text ?? "").toLowerCase();
    if (!/\b(claim|help|tari)\b/.test(text)) continue;
    if (Date.now() - (state.repliedTo[n.author.did] ?? 0) < REPLY_COOLDOWN_MS) continue;
    const ref = { uri: n.uri, cid: n.cid };
    const reply = `@${n.author.handle} Collect tTARI sent to you, or send some to any Bluesky handle: ${CLAIM_URL}\nYou prove you own your account. No wallet or middleman needed.`;
    await post(reply, { root: rec.reply?.root ?? ref, parent: ref });
    state.repliedTo[n.author.did] = Date.now();
  }
  state.handledNotifications = [...handled].slice(-500);
  if (LIVE) await agent.updateSeenNotifications();
}

async function main() {
  await agent.login({ identifier: env.BSKY_HANDLE!, password: env.BSKY_APP_PASSWORD! });
  log(`logged in as ${agent.session!.handle}; mode: ${LIVE ? "LIVE" : "dry-run"}; claim url: ${CLAIM_URL}`);
  const provider = await IndexerProvider.connect({ url: defaultIndexerUrl(Network.Esmeralda), network: Network.Esmeralda });
  const once = process.argv.includes("--once");
  for (;;) {
    try {
      await notifyDeposits(provider);
      await answerMentions();
      save();
    } catch (e) {
      log("cycle failed:", e instanceof Error ? e.message : e);
    }
    if (once) break;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
