/** A participant's standing in a campaign: what they can claim now and what's left to do. Pure logic, shared with Skydrop. */
import { groupsOf, requirementCount, requirementsMet, RULES, type Rule, type Spec } from "./campaign";

export type StepStatus = "met" | "unmet" | "error";
export type QuestState = "ready" | "progress" | "blocked" | "unknown" | "waiting" | "claimed" | "over";

export interface StepView {
  rule: Rule;
  status: StepStatus;
  /** Part of an either/or that's already covered by another step, so it needs no action. */
  covered: boolean;
  /** Something the participant can do themselves, rather than needing a voucher. */
  actionable: boolean;
  detail: string;
}

export interface Assessment {
  state: QuestState;
  steps: StepView[];
  done: number;
  total: number;
  /** What one round pays this account. */
  perRound: bigint;
  /** What the whole campaign could pay this account, across rounds. */
  fullAmount: bigint;
  /** What it has already paid this account. */
  paid: bigint;
  headline: string;
}

export function assess(spec: Spec, did: string, results: { status: StepStatus; detail: string }[]): Assessment {
  const ids = groupsOf(spec.rules);
  const met = results.map((r) => r.status === "met");
  const steps: StepView[] = spec.rules.map((rule, i) => {
    const r = results[i] ?? { status: "error" as const, detail: "Not checked." };
    return {
      rule,
      status: r.status,
      detail: r.detail,
      covered: r.status !== "met" && !!ids[i] && ids.some((g, j) => g === ids[i] && met[j]),
      actionable: RULES[rule.kind]?.side === "claimant",
    };
  });
  const allocation = spec.allocations?.find((a) => a.did === did);
  const listed = !spec.allocations || !!allocation;
  const perRound = allocation ? BigInt(allocation.amount) : spec.allocations ? 0n : BigInt(spec.reward);
  const rounds = BigInt(Math.max(1, spec.rounds));
  const total = requirementCount(spec.rules);
  const done = requirementsMet(spec.rules, met);
  const open = steps.filter((s) => s.status !== "met" && !s.covered);
  // Each unmet requirement: can the participant fix it? An either/or group is fixable if any member is.
  const fixable = (s: StepView, i: number): boolean => {
    const g = ids[spec.rules.indexOf(s.rule) ?? i];
    return s.actionable || (!!g && steps.some((o, j) => ids[j] === g && o.actionable));
  };
  let state: QuestState;
  let headline: string;
  if (!listed) {
    state = "blocked";
    headline = "This account isn't on the campaign's list.";
  } else if (open.some((s) => s.status === "error")) {
    state = "unknown";
    headline = "Some steps couldn't be checked. Try refreshing.";
  } else if (!open.length) {
    state = "ready";
    headline = spec.rules.length ? "Every step is done." : "You're on the list.";
  } else if (open.every((s, i) => !fixable(s, i))) {
    state = "blocked";
    headline = "This needs someone else to vouch for you.";
  } else {
    state = "progress";
    const left = total - done;
    headline = `${left} step${left === 1 ? "" : "s"} left.`;
  }
  return { state, steps, done, total, perRound, fullAmount: perRound * rounds, paid: 0n, headline };
}

export interface LiveFacts {
  roundsPaid: number;
  rounds: number;
  phase: "upcoming" | "open" | "closed";
  /** Epochs until the next round or the opening, if it has to wait. */
  waitEpochs: number;
  /** Whether the pool can still cover this account's next payment. */
  funded: boolean;
  waitText: string;
}

/** Applies what the chain says to an assessment made from Bluesky data alone. */
export function settle(a: Assessment, f: LiveFacts): Assessment {
  const paid = a.perRound * BigInt(f.roundsPaid);
  const out: Assessment = { ...a, paid };
  const collected = paid > 0n ? "You've collected what you earned before it ended." : "You didn't collect from it.";
  if (a.state === "blocked" && !paid) return f.phase === "closed" ? { ...out, state: "over", headline: "This campaign has closed." } : out;
  if (f.rounds > 0 && f.roundsPaid >= f.rounds) return { ...out, state: "claimed", headline: "You've collected everything from this campaign." };
  if (f.phase === "closed") return { ...out, state: "over", headline: `This campaign has closed. ${collected}` };
  if (!f.funded) return { ...out, state: "over", headline: `This campaign's pool has run out. ${collected}` };
  if (f.phase === "upcoming") return { ...out, state: "waiting", headline: `It opens in ${f.waitText}. You can get your steps done now.` };
  if (f.roundsPaid > 0 && f.waitEpochs > 0) return { ...out, state: "waiting", headline: `Round ${f.roundsPaid + 1} of ${f.rounds} opens in ${f.waitText}.` };
  return out;
}

export interface Totals { readyNow: bigint; readyCount: number; toEarn: bigint; progressCount: number; blockedCount: number; collected: bigint }

export function totals(list: Assessment[]): Totals {
  const t: Totals = { readyNow: 0n, readyCount: 0, toEarn: 0n, progressCount: 0, blockedCount: 0, collected: 0n };
  for (const a of list) {
    t.collected += a.paid;
    const left = a.fullAmount - a.paid;
    if (a.state === "ready") {
      t.readyNow += a.perRound;
      t.readyCount++;
      t.toEarn += left - a.perRound;
    } else if (a.state === "progress" || a.state === "unknown" || a.state === "waiting") {
      t.toEarn += left;
      t.progressCount++;
    } else if (a.state === "blocked") {
      t.blockedCount++;
    }
  }
  return t;
}
