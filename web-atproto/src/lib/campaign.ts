/** The Campaign contract's rules, as data. Everything here mirrors campaigns/src/lib.rs; keep them in step. */
export type RuleKind = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export type InputKind = "post" | "did" | "text" | "list";

export interface RuleDef {
  kind: RuleKind;
  name: string;
  verb: string;
  input: InputKind;
  placeholder: string;
  collection: string;
  /** Whose repo holds the proof: the claimant's own, or a voucher's. */
  side: "claimant" | "voucher";
  help: string;
}

export const RULES: RuleDef[] = [
  { kind: 0, name: "Like a post", verb: "Like this post", input: "post", placeholder: "bsky.app/profile/name/post/3k…", collection: "app.bsky.feed.like", side: "claimant", help: "A like record whose subject is the post." },
  { kind: 1, name: "Repost a post", verb: "Repost this post", input: "post", placeholder: "bsky.app/profile/name/post/3k…", collection: "app.bsky.feed.repost", side: "claimant", help: "A repost record whose subject is the post." },
  { kind: 2, name: "Follow an account", verb: "Follow this account", input: "did", placeholder: "name.bsky.social", collection: "app.bsky.graph.follow", side: "claimant", help: "A follow record whose subject is the account." },
  { kind: 3, name: "Post containing text", verb: "Post text containing", input: "text", placeholder: "#OotleLaunch", collection: "app.bsky.feed.post", side: "claimant", help: "A post whose text contains this exact string, capitals included." },
  { kind: 4, name: "Reply to a post", verb: "Reply to this post", input: "post", placeholder: "bsky.app/profile/name/post/3k…", collection: "app.bsky.feed.post", side: "claimant", help: "A post whose reply parent or thread root is the post." },
  { kind: 5, name: "Quote a post", verb: "Quote this post", input: "post", placeholder: "bsky.app/profile/name/post/3k…", collection: "app.bsky.feed.post", side: "claimant", help: "A post embedding the post, with or without media." },
  { kind: 6, name: "Be on a list", verb: "Be on this list", input: "list", placeholder: "bsky.app/profile/org/lists/3k…", collection: "app.bsky.graph.listitem", side: "voucher", help: "A list item in the list owner's repo naming the claimant. The owner decides who is on it." },
  { kind: 7, name: "Be followed by", verb: "Be followed by", input: "did", placeholder: "org.bsky.social", collection: "app.bsky.graph.follow", side: "voucher", help: "A follow record in that account's repo whose subject is the claimant." },
  { kind: 8, name: "Be verified by", verb: "Be verified by", input: "did", placeholder: "trusted-verifier.bsky.social", collection: "app.bsky.graph.verification", side: "voucher", help: "A Bluesky verification record in that account's repo naming the claimant." },
];

/** The one-tap actions in the builder. All apply to one pasted post; Follow means that post's author. */
export const QUICK_ACTIONS: { kind: RuleKind; label: string; hint: string; icon: string }[] = [
  { kind: 0, label: "Like", hint: "Like the post", icon: "♥" },
  { kind: 1, label: "Repost", hint: "Retweet it", icon: "⟲" },
  { kind: 4, label: "Comment", hint: "Reply in its thread", icon: "✎" },
  { kind: 5, label: "Quote", hint: "Quote post it", icon: "❝" },
  { kind: 2, label: "Follow", hint: "Follow the author", icon: "+" },
];

/** Every step type, for the builder's palette. */
export const PALETTE: { kind: RuleKind; label: string; icon: string }[] = [
  ...QUICK_ACTIONS.map(({ kind, label, icon }) => ({ kind, label, icon })),
  { kind: 3, label: "Post text", icon: "#" },
  { kind: 6, label: "On a list", icon: "☰" },
  { kind: 7, label: "Followed by", icon: "←" },
  { kind: 8, label: "Verified by", icon: "✓" },
];

/** Ready-made action sets, as links into the builder. */
export const QUICK_STARTS: { name: string; text: string; kinds: RuleKind[] }[] = [
  { name: "Like", text: "Pay people to like a post.", kinds: [0] },
  { name: "Repost", text: "Pay people to repost a post.", kinds: [1] },
  { name: "Comment", text: "Pay people to reply to a post.", kinds: [4] },
  { name: "Follow", text: "Pay people to follow an account.", kinds: [2] },
  { name: "Quote", text: "Pay people to quote a post.", kinds: [5] },
  { name: "Like + repost", text: "Both, on the same post.", kinds: [0, 1] },
  { name: "Like, repost + comment", text: "All three are needed to claim.", kinds: [0, 1, 4] },
  { name: "Full quest", text: "Like, repost, comment and follow.", kinds: [0, 1, 4, 2] },
  { name: "Like three posts", text: "Post X, post Y and post Z.", kinds: [0, 0, 0] },
];

const VERBS: Partial<Record<RuleKind, string>> = { 0: "like", 1: "repost", 4: "comment on", 5: "quote" };

function joinWords(words: string[], last = "and"): string {
  if (words.length < 2) return words.join("");
  return `${words.slice(0, -1).join(", ")} ${last} ${words[words.length - 1]}`;
}

/** A plain sentence for a set of rules: "like, repost and comment on this post, and follow its author". */
export function summarize(rules: Rule[]): string {
  if (rules.some((r, i) => (i > 0 && r.or) || r.text)) return summarizeSteps(rules);
  const posts = [...new Set(rules.filter((r) => VERBS[r.kind]).map((r) => r.target))];
  const parts: string[] = [];
  posts.forEach((t, i) => {
    const verbs = rules.filter((r) => VERBS[r.kind] && r.target === t).map((r) => VERBS[r.kind]!);
    const name = posts.length === 1 ? "this post" : `post ${i + 1}`;
    parts.push(`${joinWords(verbs)} ${name}`);
  });
  const owners = new Set(posts.map((t) => t.match(/^at:\/\/(did:[^/]+)\//)?.[1]).filter(Boolean));
  for (const r of rules) {
    if (r.kind === 2) parts.push(r.target && owners.has(r.target) ? "follow its author" : "follow an account");
    if (r.kind === 3) parts.push(r.target ? `post “${r.target}”` : "post the required text");
    if (r.kind === 6) parts.push("be on a list");
    if (r.kind === 7) parts.push("be followed by a chosen account");
    if (r.kind === 8) parts.push("be verified by a chosen account");
  }
  return joinWords(parts);
}

/** The step-by-step form, for either/or steps and required wording. */
function summarizeSteps(rules: Rule[]): string {
  const posts = [...new Set(rules.filter((r) => VERBS[r.kind]).map((r) => r.target))];
  const owners = new Set(posts.map((t) => t.match(/^at:\/\/(did:[^/]+)\//)?.[1]).filter(Boolean));
  const phrase = (r: Rule): string => {
    const verb = VERBS[r.kind];
    if (verb) {
      const name = posts.length === 1 ? "this post" : `post ${posts.indexOf(r.target) + 1}`;
      return `${verb} ${name}${r.text ? ` saying “${r.text}”` : ""}`;
    }
    if (r.kind === 2) return r.target && owners.has(r.target) ? "follow its author" : "follow an account";
    if (r.kind === 3) return r.target ? `post “${r.target}”` : "post the required text";
    if (r.kind === 6) return "be on a list";
    if (r.kind === 7) return "be followed by a chosen account";
    return "be verified by a chosen account";
  };
  const parts: string[] = [];
  rules.forEach((r, i) => {
    if (i > 0 && r.or) parts[parts.length - 1] += ` or ${phrase(r)}`;
    else parts.push(phrase(r));
  });
  return joinWords(parts);
}

/** A default campaign name from the one-tap actions. */
export function questName(kinds: number[]): string {
  if (kinds.length && new Set(kinds).size < kinds.length) return `${kinds.length}-step quest`;
  const names = PALETTE.filter((a) => kinds.includes(a.kind)).map((a) => a.label.toLowerCase());
  if (!names.length) return "";
  const s = joinWords(names);
  return `${s[0]!.toUpperCase()}${s.slice(1)} quest`;
}

export const ruleDef = (k: number): RuleDef => RULES[k] ?? RULES[0]!;

export interface Rule {
  kind: RuleKind;
  target: string;
  snapshot?: number;
  label?: string;
  /** For a comment or quote: text that post itself must contain. */
  text?: string;
  /** Either/or with the step before it. */
  or?: boolean;
}

/** Contract group ids: 0 = required; steps joined by "or" share an id. */
export function groupsOf(rules: Rule[]): number[] {
  const ids = rules.map(() => 0);
  let next = 0;
  rules.forEach((r, i) => {
    if (i === 0 || !r.or) return;
    if (!ids[i - 1]) ids[i - 1] = ++next;
    ids[i] = ids[i - 1]!;
  });
  return ids;
}

/** How many things a claimant has to do: an either/or group counts once. */
export function requirementCount(rules: Rule[]): number {
  const ids = groupsOf(rules);
  return ids.filter((g) => g === 0).length + new Set(ids.filter((g) => g !== 0)).size;
}

/** Whether a set of results (one per rule) meets every requirement. */
export function requirementsMet(rules: Rule[], met: boolean[]): number {
  const ids = groupsOf(rules);
  const groups = new Set(ids.filter((g) => g !== 0));
  let n = ids.filter((g, i) => g === 0 && met[i]).length;
  for (const g of groups) if (ids.some((x, i) => x === g && met[i])) n++;
  return n;
}
export interface Allocation { did: string; amount: string }

/** A campaign's terms. Amounts are in µ-units (1 tTARI = 1,000,000), as decimal strings. */
export interface Spec {
  v: 1;
  name: string;
  about: string;
  rules: Rule[];
  reward: string;
  budget: string;
  rounds: number;
  roundDays: number;
  bonus: string;
  maxReferrals: number;
  startsInDays: number;
  days: number;
  root?: string;
  allocations?: Allocation[];
  /** Set once funded: the live contract. Its terms are read from the chain, so a link can't misstate them. */
  component?: string;
}

export const UNIT = 1_000_000n;
export const EPOCHS_PER_DAY = 24; // about one epoch an hour was observed on Esmeralda; an assumption, not a guarantee

/** What a real one-step first claim's transaction cost on Esmeralda: 0.04 tTARI. More steps cost more. */
export const CLAIM_FEE_MICRO = 40_000n;

export const MAX_RULES = 8;
export const MAX_ROUNDS = 52;
export const MAX_DURATION_EPOCHS = 20_000;
export const MAX_NAME = 64;
export const MAX_TARGET = 300;

export function toMicro(tari: string): bigint {
  const m = tari.trim().match(/^(\d+)(?:\.(\d{1,6}))?$/);
  if (!m) throw new Error("Use a plain number with at most 6 decimals");
  return BigInt(m[1]!) * UNIT + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
}

/** A rough duration for a number of epochs, using the same one-an-hour assumption as the builder. */
export function approxTime(epochs: number): string {
  const hours = Math.max(0, Math.round(epochs * (24 / EPOCHS_PER_DAY)));
  if (hours < 1) return "under an hour";
  if (hours < 48) return `about ${hours} hour${hours === 1 ? "" : "s"}`;
  return `about ${Math.round(hours / 24)} days`;
}

export function fromMicro(v: bigint | string): string {
  const n = BigInt(v);
  const whole = n / UNIT;
  const frac = (n % UNIT).toString().padStart(6, "0").replace(/0+$/, "");
  return whole.toLocaleString("en-US") + (frac ? `.${frac}` : "");
}

export const newSpec = (): Spec => ({ v: 1, name: "", about: "", rules: [], reward: "1000000", budget: "100000000", rounds: 1, roundDays: 7, bonus: "0", maxReferrals: 0, startsInDays: 0, days: 14 });

const b64url = (s: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string): string => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));

export const encodeSpec = (s: Spec): string => b64url(JSON.stringify(s));

/** The name a live campaign shows until its contract has been read. */
export const LIVE_PLACEHOLDER = "Live campaign";

/** The link for a live campaign: only what the chain can't supply. */
export const encodeLive = (component: string, allocations?: Allocation[]): string => b64url(JSON.stringify({ v: 1, name: "", rules: [], component, ...(allocations ? { allocations } : {}) }));

/** Parses a shared spec. Treats it as untrusted: everything it holds is shown as text and re-validated. */
export function decodeSpec(s: string): Spec {
  const j = JSON.parse(unb64url(s)) as Spec;
  if (j.v !== 1 || typeof j.name !== "string" || !Array.isArray(j.rules)) throw new Error("Not a campaign");
  if (j.component !== undefined) {
    // A live campaign's terms come from its contract. The link names the address and carries any allocation list, and
    // whatever else it says is dropped, so it can't misstate a reward or be refused over terms the chain overrules.
    if (!/^component_[0-9a-f]{64}$/.test(j.component)) throw new Error("That link names an invalid campaign address");
    const list = j.allocations;
    const allocations = Array.isArray(list) && list.every((a) => typeof a?.did === "string" && /^\d+$/.test(String(a?.amount))) ? list : undefined;
    return { ...newSpec(), name: LIVE_PLACEHOLDER, component: j.component, ...(allocations ? { allocations } : {}) };
  }
  const problems = validate(j).filter((p) => p.level === "error");
  if (problems.length) throw new Error(problems[0]!.text);
  return j;
}

export interface Problem { level: "error" | "warn"; text: string }

/** The same limits the contract enforces at creation, plus advice. */
export function validate(s: Spec): Problem[] {
  const out: Problem[] = [];
  const err = (text: string) => out.push({ level: "error", text });
  const warn = (text: string) => out.push({ level: "warn", text });
  const bytes = (x: string) => new TextEncoder().encode(x).length;
  if (!s.name.trim()) err("Give the campaign a name.");
  if (bytes(s.name) > MAX_NAME) err(`Names are at most ${MAX_NAME} bytes.`);
  if (s.rules.length > MAX_RULES) err(`A campaign has at most ${MAX_RULES} rules.`);
  if (!s.rules.length && !s.root) err("Add at least one rule or an allocation list.");
  for (const r of s.rules) {
    const def = RULES[r.kind];
    if (!def) { err("Unknown rule."); continue; }
    if (!r.target) err(`"${def.name}" needs a value.`);
    else if (bytes(r.target) > MAX_TARGET) err(`"${def.name}" is longer than ${MAX_TARGET} bytes.`);
    if (r.target && (def.input === "post" || def.input === "list") && !r.target.startsWith("at://did:plc:")) err(`"${def.name}" must point at a did:plc account's record.`);
    if (r.target && def.input === "did" && !r.target.startsWith("did:plc:")) err(`"${def.name}" must name a did:plc account.`);
    if (r.text && r.kind !== 4 && r.kind !== 5) err("Only comments and quotes can require wording.");
    if (r.text && bytes(r.text) > 200) err("Required wording is at most 200 bytes.");
  }
  const steps = s.rules.filter((r) => r.target).map((r) => `${r.kind}|${r.target}`);
  if (new Set(steps).size < steps.length) warn("Two steps are identical, so one of them adds nothing. Did you mean a different post?");
  let reward = 0n, budget = 0n, bonus = 0n;
  try { reward = BigInt(s.reward); budget = BigInt(s.budget); bonus = BigInt(s.bonus); } catch { err("Amounts must be whole numbers of µ-units."); }
  if (reward <= 0n && !s.root) err("The reward must be more than zero.");
  if (budget <= 0n) err("The pool must be more than zero.");
  if (s.rounds < 1 || s.rounds > MAX_ROUNDS || !Number.isInteger(s.rounds)) err(`Rounds must be 1 to ${MAX_ROUNDS}.`);
  if (s.rounds > 1 && !(s.roundDays > 0)) err("Repeating rounds need a spacing.");
  if (!(s.days > 0)) err("The campaign must stay open for some time.");
  if ((s.startsInDays + s.days) * EPOCHS_PER_DAY > MAX_DURATION_EPOCHS) err("The contract allows about 833 days at most.");
  if (s.rounds > 1 && s.roundDays * (s.rounds - 1) >= s.days) warn("Not every round fits inside the open window. Rounds not claimed before it closes are forfeited, so people could not earn the full amount.");
  if (bonus > 0n && s.maxReferrals === 0) warn("A bonus with a referral limit of 0 can never pay.");
  if (bonus > 0n && exposure(s).level !== "Low") warn("Paid referrals on an open campaign reward making fake accounts. Add a vouch rule or keep the bonus tiny.");
  if (reward > 0n && budget > 0n && !s.root && budget < reward) err("The pool can't cover even one reward.");
  if (reward > 0n && !s.root && reward <= CLAIM_FEE_MICRO * BigInt(Math.max(1, s.rules.length))) warn(`Claimers pay the network fee themselves, about ${fromMicro(CLAIM_FEE_MICRO)} tTARI or more for a claim, so a reward this small may not be worth claiming.`);
  return out;
}

export function exposure(s: Spec): { level: "Low" | "Medium" | "High"; why: string } {
  const vouched = s.rules.some((r) => RULES[r.kind]?.side === "voucher");
  if (vouched || s.root) {
    return { level: "Low", why: vouched ? "A voucher you chose decides who qualifies, so fake accounts can't qualify on their own." : "Only the accounts on your list can claim." };
  }
  if (s.rounds > 1) return { level: "Medium", why: "Anyone can make accounts, but each one has to keep posting and re-proving over time to earn the full reward." };
  return { level: "High", why: "Bluesky accounts are free. Someone can create many and do every step with each, so expect farming. Keep the reward small or add a vouch rule." };
}

export interface Projection {
  perClaimant: bigint;
  maxClaimants: bigint;
  worstCasePerClaimant: bigint;
  allocated: bigint;
  computeM: number;
  computeShare: number;
  ownCommits: number;
  vouches: number;
}

// Measured by campaigns.rs on Ootle 0.49.2, in millions of WASM points, with k256 keys and a one-operation chain.
const POINTS_BASE = 14.4;
const POINTS_PER_OWN_PROOF = 6.8;
const POINTS_PER_VOUCH = 14.2;
export const POINTS_LIMIT = 250;

export function project(s: Spec): Projection {
  const reward = BigInt(s.reward || "0");
  const bonus = BigInt(s.bonus || "0");
  const budget = BigInt(s.budget || "0");
  const rounds = BigInt(Math.max(1, s.rounds || 1));
  const allocated = (s.allocations ?? []).reduce((n, a) => n + BigInt(a.amount), 0n) * rounds;
  const perClaimant = reward * rounds;
  const worstCasePerClaimant = perClaimant + bonus * BigInt(Math.max(0, s.maxReferrals));
  const maxClaimants = s.root ? BigInt((s.allocations ?? []).length) : perClaimant > 0n ? budget / (perClaimant + (s.maxReferrals > 0 ? bonus : 0n)) : 0n;
  const vouches = s.rules.filter((r) => RULES[r.kind]?.side === "voucher").length;
  const ownCommits = s.rules.length - vouches;
  const computeM = POINTS_BASE + POINTS_PER_OWN_PROOF * Math.max(ownCommits, 1) + POINTS_PER_VOUCH * vouches;
  return { perClaimant, maxClaimants, worstCasePerClaimant, allocated, computeM, computeShare: computeM / POINTS_LIMIT, ownCommits, vouches };
}

// ---- hashes the contract recomputes ----------------------------------------------------------------

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const fromHex = (s: string): Uint8Array => Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));

/** tari-campaign:v1:<component>:<did>:<32-byte key>:<round BE16>, truncated to 16 bytes of SHA-256. */
export async function claimCode(component: string, did: string, claimant: Uint8Array, round: number): Promise<string> {
  const digest = await sha256(concat(utf8(`tari-campaign:v1:${component}:${did}:`), claimant, utf8(":"), Uint8Array.of(round >> 8, round & 255)));
  return `tari-quest:${toHex(digest.slice(0, 16))}`;
}

export async function allocationLeaf(did: string, amount: bigint): Promise<Uint8Array> {
  const be = new Uint8Array(8);
  new DataView(be.buffer).setBigUint64(0, amount);
  return sha256(concat(Uint8Array.of(0), utf8(did), Uint8Array.of(0), be));
}

function compare(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

async function parent(a: Uint8Array, b: Uint8Array): Promise<Uint8Array> {
  const [x, y] = compare(a, b) <= 0 ? [a, b] : [b, a];
  return sha256(concat(Uint8Array.of(1), x, y));
}

export interface MerkleResult { root: string; proofs: Record<string, { amount: string; path: string[] }> }

/** Builds the allocation tree. An unpaired node moves up unchanged. */
export async function buildAllocationTree(list: Allocation[]): Promise<MerkleResult> {
  if (!list.length) throw new Error("The list is empty");
  const seen = new Set<string>();
  for (const a of list) {
    if (seen.has(a.did)) throw new Error(`${a.did} is listed twice`);
    seen.add(a.did);
    if (BigInt(a.amount) <= 0n) throw new Error(`${a.did} has no amount`);
  }
  const leaves = await Promise.all(list.map((a) => allocationLeaf(a.did, BigInt(a.amount))));
  const paths: string[][] = list.map(() => []);
  let level = leaves.map((node, i) => ({ node, members: [i] }));
  while (level.length > 1) {
    const next: typeof level = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i]!;
      const b = level[i + 1];
      if (!b) {
        next.push(a);
        continue;
      }
      for (const m of a.members) paths[m]!.push(toHex(b.node));
      for (const m of b.members) paths[m]!.push(toHex(a.node));
      next.push({ node: await parent(a.node, b.node), members: [...a.members, ...b.members] });
    }
    level = next;
  }
  const proofs: MerkleResult["proofs"] = {};
  list.forEach((a, i) => (proofs[a.did] = { amount: a.amount, path: paths[i]! }));
  return { root: toHex(level[0]!.node), proofs };
}

/** The same check the contract's merkle_ok runs. */
export async function checkAllocation(root: string, did: string, amount: bigint, path: string[]): Promise<boolean> {
  let node = await allocationLeaf(did, amount);
  for (const sibling of path) node = await parent(node, fromHex(sibling));
  return toHex(node) === root;
}

/** Cuts text to a byte limit without splitting a character: the contract counts bytes. */
function clipBytes(text: string, max: number): string {
  let out = "";
  let used = 0;
  for (const ch of text) {
    used += utf8(ch).length;
    if (used > max) break;
    out += ch;
  }
  return out;
}

/** Exactly the arguments Campaign::create takes, in order, relative to the current epoch. */
export function createArgs(s: Spec, now: number, funder: string, registry: string): Record<string, unknown> {
  const open = now + Math.round(s.startsInDays * EPOCHS_PER_DAY);
  return {
    name: s.name,
    info: clipBytes(s.about, 256),
    funder,
    link_registry: registry,
    kinds: s.rules.map((r) => r.kind),
    targets: s.rules.map((r) => r.target),
    snapshots: s.rules.map((r) => r.snapshot ?? 0),
    texts: s.rules.map((r) => r.text ?? ""),
    groups: groupsOf(s.rules),
    reward: s.reward,
    allocation_root: s.root ?? "",
    rounds: s.rounds,
    round_epochs: s.rounds > 1 ? Math.round(s.roundDays * EPOCHS_PER_DAY) : 0,
    referral_bonus: s.bonus,
    max_referrals: s.maxReferrals,
    open_epoch: open,
    close_epoch: open + Math.round(s.days * EPOCHS_PER_DAY),
    funds: s.budget,
  };
}
