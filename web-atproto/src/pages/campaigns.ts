import { fromMicro } from "../lib/campaign";
import { contractsOnNetwork, isPublished } from "../data/deployment";
import { PLAYBOOKS, type Playbook } from "../data/playbooks";
import { listCampaigns, phaseOf } from "../lib/chain";
import { h, pageHead, pill, replace } from "../lib/dom";
import { exposure, newSpec, QUICK_ACTIONS, QUICK_STARTS, RULES, toMicro, type RuleKind, type Spec } from "../lib/campaign";
import type { Page } from "../main";

/** Turns a playbook into a starting spec with its targets blank, for the builder. */
export function specFromPlaybook(p: Playbook): Spec {
  return {
    ...newSpec(),
    name: p.name,
    about: p.goal,
    rules: p.rules.map((r) => ({ kind: r.kind as RuleKind, target: r.text ?? "", label: r.hint })),
    reward: toMicro(p.reward).toString(),
    budget: toMicro(p.budget).toString(),
    rounds: p.rounds ?? 1,
    roundDays: p.roundDays ?? 7,
    bonus: toMicro(p.bonus ?? "0").toString(),
    maxReferrals: p.maxReferrals ?? 0,
    days: p.days,
  };
}

function exposureOf(p: Playbook): "Low" | "Medium" | "High" {
  if (p.usesAllocation) return "Low";
  return exposure(specFromPlaybook(p)).level;
}

/** Open campaigns made with this contract. Each is read back from the chain, which decides what's real. */
function liveCampaigns(): HTMLElement {
  const box = h("div", { style: "margin-top:12px" }, h("p", { class: "muted" }, "Reading the network…"));
  if (!isPublished()) {
    replace(box, h("div", { class: "note" }, h("strong", null, "No campaigns can run yet."), " ", contractsOnNetwork() ? "The Campaign contract is on the Esmeralda testnet, but funding from the site is still being built. You can design a campaign and try its eligibility check against real accounts today." : "The Campaign contract passes its tests on Ootle 0.49.2 but isn't published on the network. You can design a campaign and try its eligibility check against real accounts today."));
    return box;
  }
  void (async () => {
    const open = (await listCampaigns()).filter((c) => !c.legacy && phaseOf(c) !== "closed" && c.balance > 0n);
    replace(box, open.length
      ? [
          h("div", { class: "grid g3" }, open.map((c) => h("a", { class: "card", href: `/c/${c.component}` }, h("h3", null, c.name), h("p", null, c.root ? "Listed amounts" : `${fromMicro(c.reward)} tTARI each`), h("div", { class: "foot-line" }, `${c.claimants.toLocaleString("en-US")} claimed · ${fromMicro(c.balance)} left`)))),
          h("p", { class: "muted small-text" }, "Anyone can create a campaign, so nobody here has vetted these. Their funds and rules are real; their names and links are whatever the creator chose."),
        ]
      : h("div", { class: "note" }, h("strong", null, "No campaigns are open right now."), " Be the first: pick a playbook below."));
  })().catch(() => replace(box, h("p", { class: "muted" }, "The network couldn't be read just now. Refresh to try again.")));
  return box;
}

export const exposurePill = (level: "Low" | "Medium" | "High"): HTMLElement => pill(level === "Low" ? "ok" : level === "Medium" ? "warn" : "bad", `Farming risk: ${level}`);

export function playbookCard(p: Playbook): HTMLElement {
  const steps = p.usesAllocation
    ? ["Allocation list", ...p.rules.map((r) => RULES[r.kind]!.name)]
    : p.rules.map((r) => RULES[r.kind]!.name);
  return h("a", { class: "card", href: `/campaigns/new?playbook=${p.id}` },
    h("span", { class: "tag" }, p.tag.toLowerCase()),
    h("h3", null, p.name),
    h("p", null, p.goal),
    exposurePill(exposureOf(p)),
    h("div", { class: "foot-line" }, steps.join(" + ") + (p.rounds ? ` × ${p.rounds} rounds` : "")),
  );
}

const TAGS = ["All", "Growth", "Community", "Retention", "Allocation", "Events"] as const;

export function campaignsPage(): Page {
  const liveList = liveCampaigns();
  const grid = h("div", { class: "grid g3" });
  const chips = h("div", { class: "chips", role: "group", "aria-label": "Filter playbooks" });
  let tag: (typeof TAGS)[number] = "All";
  const draw = () => {
    replace(grid, PLAYBOOKS.filter((p) => tag === "All" || p.tag === tag).map(playbookCard));
    replace(chips, TAGS.map((t) => h("button", { class: "chip", type: "button", "aria-pressed": String(t === tag), onclick: () => { tag = t; draw(); } }, t)));
  };
  draw();

  return {
    title: "Campaigns",
    body: h("div", { class: "wrap" },
      pageHead("Campaigns", "Reward people for what they can prove", "A campaign is a funded pool with rules. Anyone who proves every rule from their signed Bluesky repo claims once, and nobody can redirect the payout. Once it's funded, even the funder can't pull the pool early."),

      h("section", { "aria-labelledby": "quick" },
        h("h2", { id: "quick", class: "big" }, "Start from a template"),
        h("p", { class: "muted", style: "margin-top:8px" }, "Each opens on the drag-and-drop board, ready for your posts. Add, remove or reorder steps from there."),
        h("div", { class: "quickgrid" }, QUICK_STARTS.map((q) => h("a", { class: "quick", href: `/campaigns/new?do=${q.kinds.join(",")}` },
          h("span", { class: "icons", "aria-hidden": "true" }, q.kinds.map((k) => QUICK_ACTIONS.find((a) => a.kind === k)!.icon).join(" ")),
          h("strong", null, q.name),
          h("span", { class: "muted small-text" }, q.text),
        ))),
      ),

      h("section", { "aria-labelledby": "live", style: "margin-top:44px" },
        h("h2", { id: "live", class: "big" }, "Live campaigns"),
        liveList,
      ),

      h("section", { style: "margin-top:44px" },
        h("div", { class: "row", style: "justify-content:space-between" }, h("h2", { class: "big" }, "Playbooks"), h("a", { class: "btn ghost small", href: "/campaigns/new" }, "Start from scratch")),
        chips,
        grid,
      ),

      h("section", { style: "margin-top:52px" },
        h("h2", { class: "big" }, "How a campaign works"),
        h("div", { class: "grid g4" },
          h("div", { class: "card" }, h("span", { class: "tag" }, "1 · fund"), h("h3", null, "Lock a pool"), h("p", null, "Set the rules, the reward and the window. The campaign becomes its own contract holding its own funds. No one has to approve it.")),
          h("div", { class: "card" }, h("span", { class: "tag" }, "2 · act"), h("h3", null, "People take part"), h("p", null, "They like, follow, post or get vouched for, on Bluesky, the way they normally would. No wallet needed yet.")),
          h("div", { class: "card" }, h("span", { class: "tag" }, "3 · claim"), h("h3", null, "They prove it"), h("p", null, "A claim carries proofs of every rule, and a post that ties the payout to their own wallet. The contract checks it all.")),
          h("div", { class: "card" }, h("span", { class: "tag" }, "4 · close"), h("h3", null, "The rest comes back"), h("p", null, "After the close date, and not before, the funder takes back whatever wasn't claimed. The date can only move later.")),
        ),
      ),
      h("div", { class: "spacer" }),
    ),
  };
}
