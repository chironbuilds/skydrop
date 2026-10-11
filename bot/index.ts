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
import { CONFIG } from "../web/src/config";
import * as chain from "../web/src/chain";
import * as bskyLib from "../web/src/bsky";
import { builtinWallet } from "../web/src/wallet";
import type { Wallet } from "../web/src/wallet";
import { fromHex } from "../web/src/cbor";
import { shareLink, type EnvelopeRecord } from "../web/src/envelope-data";

const here = dirname(fileURLToPath(import.meta.url));
const COMPONENT = CONFIG.component;
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
// A real environment variable wins over the file, so a local dry run cannot go live by accident.
if (process.env.BOT_LIVE) env.BOT_LIVE = process.env.BOT_LIVE;
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
  challenge: string;
}

async function readDeposits(): Promise<Record<string, Dep[]>> {
  const sub = await provider.getSubstate(COMPONENT);
  const comp = (sub.substate as { Component?: { body: { state: unknown[] } } }).Component;
  if (!comp) throw new Error("escrow component unreadable");
  const raw = comp.body.state[3] as Record<string, unknown[][]>;
  const out: Record<string, Dep[]> = {};
  for (const [did, list] of Object.entries(raw)) {
    out[did] = list.map((d) => {
      const sender = (d[0] as { hex: string }).hex;
      return { fp: `${sender}:${d[1]}:${d[2]}:${d[3]}`, amount: BigInt(d[1] as number), window: Number(d[3]), challenge: String(d[4] ?? "") };
    });
  }
  return out;
}

const agent = new AtpAgent({ service: "https://bsky.social" });
let provider: IndexerProvider;
/** Signs the relay transactions. It holds no funds: fees come from the escrow's fee vault and the tipper's budget. */
let relayWallet: Wallet | null = null;

const TIP_RE = /^@\S+\s+tip\s+@\S+\s+(\d+(?:\.\d{1,6})?)(?:\s+tTARI)?\s*$/i;
const MAX_TIP_RELAYS_PER_HOUR = 30;
const relayTimes: number[] = [];

interface Notif {
  uri: string;
  cid: string;
  author: { did: string; handle: string };
  record: unknown;
}

/** Relays one tip post to the contract. Returns false if the post was not a tip command at all. */
async function handleTip(n: Notif, ref: { uri: string; cid: string }, root: { uri: string; cid: string }): Promise<boolean> {
  const rec = n.record as { text?: string; facets?: { features?: { $type?: string; did?: string }[] }[] };
  const m = TIP_RE.exec((rec.text ?? "").trim());
  if (!m) return false;
  const reply = (text: string) => post(text, { root, parent: ref });
  const amount = chain.parseTari(m[1]!);
  const mentioned = (rec.facets ?? []).flatMap((f) => f.features ?? []).filter((f) => f.$type === "app.bsky.richtext.facet#mention").map((f) => f.did!);
  const recipientDid = mentioned.find((d) => d !== agent.session!.did);
  if (!amount || !recipientDid) return true;

  const me = n.author.handle;
  const budgets = (await chain.readBudgetsFor(provider, n.author.did)).filter(([, b]) => b.balance >= amount + chain.SPONSOR_FEE && b.maxTip >= amount);
  if (!budgets.length) {
    await reply(`@${me} I can't tip from your account yet: no tip budget with enough in it (or the tip is over your per-tip limit). Set one up here: ${CLAIM_URL}/#/tips/${me}`);
    return true;
  }
  if (!LIVE || !relayWallet) {
    log(`[dry-run] would relay tip of ${fmt(amount)} from ${me} to ${recipientDid}`);
    return true;
  }
  const now = Date.now();
  while (relayTimes.length && now - relayTimes[0]! > 3600_000) relayTimes.shift();
  if (relayTimes.length >= MAX_TIP_RELAYS_PER_HOUR) {
    log("tip relay rate limit reached");
    return true;
  }
  relayTimes.push(now);

  const rkey = n.uri.split("/").pop()!;
  try {
    const proof = await bskyLib.buildClaimProof(n.author.did, rkey);
    const out = await chain.relayTipSponsored(relayWallet, proof, fromHex(budgets[0]![0]), (s) => log("  ·", s));
    log(`tipped ${fmt(amount)} from ${me}: ${out.transactionId}`);
    let recipient = recipientDid;
    try {
      recipient = "@" + (await agent.getProfile({ actor: recipientDid })).data.handle;
    } catch {
      /* mention by DID text is not possible; fall back below */
    }
    await reply(`@${me} ✅ Sent ${fmt(amount)} tTARI to ${recipient}. They collect it by proving they own the account: ${CLAIM_URL}/#/claim/${recipient.replace(/^@/, "")}`);
  } catch (e) {
    log("tip failed:", e instanceof Error ? e.message : e);
    await reply(`@${me} I couldn't send that tip: ${chain.friendly(e)}`);
  }
  return true;
}

/** A link with a preview card: the label in the text is made the link, and the card carries the envelope image. */
interface Card {
  label: string;
  uri: string;
  title: string;
  description: string;
  imageUrl: string;
}

async function post(text: string, reply?: { root: { uri: string; cid: string }; parent: { uri: string; cid: string } }, card?: Card) {
  const rt = new RichText({ text });
  await rt.detectFacets(agent);
  let embed: Record<string, unknown> | undefined;
  if (card) {
    const at = rt.text.indexOf(card.label);
    if (at >= 0) {
      const enc = new TextEncoder();
      const byteStart = enc.encode(rt.text.slice(0, at)).length;
      rt.facets = [...(rt.facets ?? []), { index: { byteStart, byteEnd: byteStart + enc.encode(card.label).length }, features: [{ $type: "app.bsky.richtext.facet#link", uri: card.uri }] }];
    }
    if (LIVE) {
      try {
        const img = await fetch(card.imageUrl);
        if (img.ok) {
          const bytes = new Uint8Array(await img.arrayBuffer());
          const up = await agent.uploadBlob(bytes, { encoding: "image/png" });
          embed = { $type: "app.bsky.embed.external", external: { uri: card.uri, title: card.title, description: card.description, thumb: up.data.blob } };
        }
      } catch (e) {
        log("couldn't attach the preview image:", e instanceof Error ? e.message : e);
      }
    }
  }
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
  await agent.post({ text: rt.text, facets: rt.facets, reply, embed: embed as never, langs: ["en"], createdAt: new Date().toISOString() });
  state.postTimes.push(now);
}

async function notifyDeposits(): Promise<void> {
  const all = await readDeposits();
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
    const ask = fresh.find((d) => d.challenge)?.challenge;
    // the envelope the sender picked, if their app registered one, so the mention shows the same card as their own link
    let saved: EnvelopeRecord | null = null;
    for (const d of fresh) {
      try {
        const r = await fetch(`${CLAIM_URL}/envelope?fp=${encodeURIComponent(d.fp)}`);
        if (r.ok) {
          saved = (await r.json()) as EnvelopeRecord;
          break;
        }
      } catch {
        /* no envelope: plain card */
      }
    }
    const link = shareLink(CLAIM_URL, handle, saved?.e ?? "air", saved?.m ?? "", saved?.a || `${fmt(total)} tTARI`, saved?.c ?? "");
    const query = link.includes("?") ? link.slice(link.indexOf("?")) : "";
    const imageUrl = `${CLAIM_URL}/og${query}${query ? "&" : "?"}h=${encodeURIComponent(handle)}`;
    const label = "Open your gift";
    let text =
      `@${handle} 🎁 You have ${fmt(total)} tTARI waiting for you on Tari (testnet).\n` +
      `Prove you own this account and collect it. No wallet needed:\n${label} ↗${careful}`;
    const withAsk = ask ? `${text}\nThe sender asks you to say: “${ask}”` : text;
    if ([...withAsk].length <= 295) text = withAsk;
    await post(text, undefined, {
      label,
      uri: link,
      title: `@${handle}, you got a gift on Tari`,
      description: saved?.m ? `“${saved.m}”` : `${fmt(total)} tTARI is waiting for you. Collect it with one Bluesky post.`,
      imageUrl,
    });
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
    {
      const tipRef = { uri: n.uri, cid: n.cid };
      if (await handleTip(n as unknown as Notif, tipRef, rec.reply?.root ?? tipRef)) continue;
    }
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
  provider = await IndexerProvider.connect({ url: defaultIndexerUrl(Network.Esmeralda), network: Network.Esmeralda });
  if (env.OOTLE_SEED) {
    chain.initStorage();
    const account = chain.openAccount(env.OOTLE_SEED);
    relayWallet = await builtinWallet(account, () => chain.tariBalance(account));
    log("tip relaying enabled");
  } else {
    log("OOTLE_SEED not set: tip relaying disabled");
  }
  const once = process.argv.includes("--once");
  for (;;) {
    try {
      await notifyDeposits();
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
