/**
 * Turns a plain description into campaign steps: "like and repost <link>, comment 'gm' on <link>, follow @alice,
 * 5 tTARI each, pool 500, for 7 days". Simple word rules, no AI and no network, so it behaves the same every time.
 * Whatever it can't read is reported, not guessed at.
 */
import type { RuleKind } from "./campaign";
import { toMicro } from "./campaign";

export interface DraftStep { kind: RuleKind; raw: string; text?: string; or?: boolean }
export interface Composed {
  steps: DraftStep[];
  reward?: string;
  budget?: string;
  days?: number;
  rounds?: number;
  roundDays?: number;
  notes: string[];
}

const VERBS: [RegExp, RuleKind][] = [
  [/^(likes?|liked|liking|heart)$/, 0],
  [/^(reposts?|reposted|reposting|retweets?|retweeted|rt|boost|share)$/, 1],
  [/^(comments?|commented|commenting|repl(y|ies)|replied|replying|respond)$/, 4],
  [/^(quotes?|quoted|quoting)$/, 5],
  [/^(follows?|followed|following)$/, 2],
];

const POST_LINK = /^(https?:\/\/)?(www\.)?bsky\.app\/profile\/[^/\s]+\/post\/[^/?#\s]+|^at:\/\/[^\s]+\/app\.bsky\.feed\.post\/[^\s]+/i;
const LIST_LINK = /^(https?:\/\/)?(www\.)?bsky\.app\/profile\/[^/\s]+\/lists\/[^/?#\s]+/i;

/** Splits into words, keeping "quoted text" together and separating commas and arrows. */
function tokens(input: string): string[] {
  const out: string[] = [];
  const re = /"[^"]*"|“[^”]*”|'[^'\s][^']*'|[^\s,;]+|[,;]/g;
  for (const m of input.matchAll(re)) out.push(m[0]);
  return out;
}

const isQuoted = (t: string): boolean => /^(".*"|“.*”|'.*')$/.test(t);
const unquote = (t: string): string => t.slice(1, -1);
const clean = (t: string): string => t.toLowerCase().replace(/[.!:()]+$/g, "").replace(/^[(]+/, "");
const asNumber = (t: string): string | null => {
  const m = t.replace(/,/g, "").match(/^(\d+(?:\.\d{1,6})?)(t?tari|xtm)?$/i);
  return m ? m[1]! : null;
};

export function compose(input: string): Composed {
  const toks = tokens(input);
  const out: Composed = { steps: [], notes: [] };
  // verbs waiting for a target, then what the next or previous post should apply to
  let pending: { kind: RuleKind; text?: string; or: boolean }[] = [];
  let lastPost = "";
  let nextOr = false;
  let waitingPostText = false;

  const flushOnto = (raw: string) => {
    for (const p of pending) out.steps.push({ kind: p.kind, raw, ...(p.text ? { text: p.text } : {}), ...(p.or ? { or: true } : {}) });
    pending = [];
  };

  for (let i = 0; i < toks.length; i++) {
    const raw = toks[i]!;
    const t = clean(raw);
    const nextTok = clean(toks[i + 1] ?? "");
    const prevTok = clean(toks[i - 1] ?? "");
    if (raw === "," || raw === ";") continue;
    if (t === "or") { nextOr = true; continue; }

    if (POST_LINK.test(raw)) {
      const link = raw.replace(/[.,;)]+$/, "");
      // A link on its own means "like it", unless verbs follow it ("<link> like and repost").
      const verbNext = VERBS.some(([re]) => re.test(nextTok));
      if (!pending.length && !verbNext && (prevTok === "post" || !out.steps.some((s) => s.raw === link))) pending.push({ kind: 0, or: nextOr });
      flushOnto(link);
      lastPost = link;
      nextOr = false;
      continue;
    }
    if (LIST_LINK.test(raw)) {
      out.steps.push({ kind: 6, raw: raw.replace(/[.,;)]+$/, ""), ...(nextOr ? { or: true } : {}) });
      nextOr = false;
      continue;
    }
    if (isQuoted(raw)) {
      const words = unquote(raw);
      if (waitingPostText) {
        out.steps.push({ kind: 3, raw: words, ...(nextOr ? { or: true } : {}) });
        nextOr = false;
        waitingPostText = false;
      } else {
        const open = [...pending].reverse().find((p) => p.kind === 4 || p.kind === 5);
        const done = [...out.steps].reverse().find((s) => s.kind === 4 || s.kind === 5);
        if (open) open.text = words;
        else if (done && !done.text) done.text = words;
        else out.notes.push(`Not sure where “${words}” belongs, so it was left out.`);
      }
      continue;
    }
    if (raw.startsWith("#") && raw.length > 1) {
      const open = [...pending].reverse().find((p) => p.kind === 4 || p.kind === 5);
      if (open) open.text = raw;
      else out.steps.push({ kind: 3, raw, ...(nextOr ? { or: true } : {}) });
      nextOr = false;
      waitingPostText = false;
      continue;
    }
    if (raw.startsWith("@") && raw.length > 1) {
      const handle = raw.slice(1).replace(/[.,;)]+$/, "");
      const f = pending.findIndex((p) => p.kind === 2);
      if (f >= 0) {
        out.steps.push({ kind: 2, raw: handle, ...(pending[f]!.or ? { or: true } : {}) });
        pending.splice(f, 1);
      } else if (/^(by|from)$/.test(prevTok)) {
        out.steps.push({ kind: prevTok === "by" && clean(toks[i - 2] ?? "").startsWith("verif") ? 8 : 7, raw: handle });
      } else {
        out.steps.push({ kind: 2, raw: handle, ...(nextOr ? { or: true } : {}) });
      }
      nextOr = false;
      continue;
    }

    // numbers with a meaning next to them
    const n = asNumber(t);
    if (n) {
      if (/^days?$/.test(nextTok)) { if (prevTok === "every") out.roundDays = Number(n); else out.days = Number(n); i++; continue; }
      if (/^weeks?$/.test(nextTok)) { if (prevTok === "every") out.roundDays = Number(n) * 7; else out.days = Number(n) * 7; i++; continue; }
      if (/^rounds?$/.test(nextTok)) { out.rounds = Number(n); i++; continue; }
      if (/^(pool|budget|prize|prizes|total)/.test(prevTok) || /^(pool|budget|total)/.test(nextTok)) { out.budget = n; if (/^(pool|budget|total)/.test(nextTok)) i++; continue; }
      if (/^(reward|earn|earns|pays?|gets?|win)/.test(prevTok) || /^(each|per|t?tari|xtm)/.test(nextTok)) {
        out.reward = n;
        if (/^(t?tari|xtm)$/.test(nextTok)) i++;
        continue;
      }
      out.notes.push(`Not sure what “${raw}” means, so it was left out.`);
      continue;
    }

    const verb = VERBS.find(([re]) => re.test(t));
    if (verb) {
      // "followed by @x" and "verified by @x" are vouches, not actions
      if (verb[1] === 2 && t === "followed" && nextTok === "by") continue;
      if (verb[1] === 5 && pending.length === 0 && /^(the|a)$/.test(prevTok) && nextTok === "") continue;
      pending.push({ kind: verb[1], or: nextOr });
      nextOr = false;
      continue;
    }
    if (t === "post" && !/^(this|that|the|a|each)$/.test(prevTok) && (isQuoted(toks[i + 1] ?? "") || (toks[i + 1] ?? "").startsWith("#"))) {
      waitingPostText = true;
      continue;
    }
  }

  // verbs with nothing after them: "<link> like and repost", or a follow meaning the post's author
  if (pending.length) {
    if (lastPost) flushOnto(lastPost);
    else if (pending.every((p) => p.kind !== 2) || pending.length) {
      out.notes.push("Add a post link so the steps know what to act on.");
      for (const p of pending) out.steps.push({ kind: p.kind, raw: "", ...(p.text ? { text: p.text } : {}), ...(p.or ? { or: true } : {}) });
      pending = [];
    }
  }
  if (out.reward) toMicro(out.reward);
  if (out.budget) toMicro(out.budget);
  return out;
}

export const EXAMPLES = [
  "Like, repost and comment on https://bsky.app/profile/bsky.app/post/3k, 5 tTARI each, pool 500, for 7 days",
  "Like https://bsky.app/profile/a.com/post/3x then like https://bsky.app/profile/b.com/post/3y or repost https://bsky.app/profile/c.com/post/3z",
  'Comment "gm #Ootle" on https://bsky.app/profile/bsky.app/post/3k and follow @bsky.app, 4 rounds every 7 days',
];
