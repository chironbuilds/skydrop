/** A participant's standing in a campaign: what they can claim now and what's left to do. Pure logic, shared with Skydrop. */
import { groupsOf, requirementCount, requirementsMet, RULES, type Rule, type Spec } from "./campaign";

export type StepStatus = "met" | "unmet" | "error";
export type QuestState = "ready" | "progress" | "blocked" | "unknown";

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
  return { state, steps, done, total, perRound, fullAmount: perRound * rounds, headline };
}

export interface Totals { readyNow: bigint; readyCount: number; toEarn: bigint; progressCount: number; blockedCount: number }

export function totals(list: Assessment[]): Totals {
  const t: Totals = { readyNow: 0n, readyCount: 0, toEarn: 0n, progressCount: 0, blockedCount: 0 };
  for (const a of list) {
    if (a.state === "ready") {
      t.readyNow += a.perRound;
      t.readyCount++;
      t.toEarn += a.fullAmount - a.perRound;
    } else if (a.state === "progress" || a.state === "unknown") {
      t.toEarn += a.fullAmount;
      t.progressCount++;
    } else {
      t.blockedCount++;
    }
  }
  return t;
}
