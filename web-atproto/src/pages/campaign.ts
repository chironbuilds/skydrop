import { isPublished, participantLink } from "../data/deployment";
import { questArt } from "../lib/art";
import { composeUrl, fetchPost, resolveActor, targetLink, type Actor } from "../lib/atproto";
import { claimCode, decodeSpec, encodeSpec, exposure, fromHex, fromMicro, groupsOf, project, requirementCount, requirementsMet, RULES, summarize, type Spec } from "../lib/campaign";
import { checkRule, identity, type RuleResult } from "../lib/check";
import { copyButton, h, pageHead, replace } from "../lib/dom";
import { connectWallet, friendly, onWallet } from "../lib/wallet";
import type { Page } from "../main";
import { postCard } from "./builder";
import { exposurePill } from "./campaigns";

const unit = "tTARI";

function ruleLine(rule: Spec["rules"][number]): HTMLElement {
  const def = RULES[rule.kind]!;
  const link = targetLink(rule.target);
  return h("span", null, def.verb, " ", link ? h("a", { href: link, target: "_blank", rel: "noopener noreferrer" }, shortTarget(rule.target)) : h("code", { class: "mono" }, rule.target));
}

const shortTarget = (t: string): string => (t.length > 44 ? `${t.slice(0, 26)}…${t.slice(-12)}` : t);

export function campaignPage(id: string): Page {
  if (id !== "preview") {
    return {
      title: "Campaign",
      body: h("div", { class: "wrap narrow" },
        pageHead("Campaign", "This campaign can't be loaded yet", "Live campaign pages read from the network once the contract is published. Previews from the builder work today."),
        h("a", { class: "btn primary", href: "/campaigns" }, "Browse playbooks"), h("div", { class: "spacer" })),
    };
  }

  let spec: Spec;
  try {
    spec = decodeSpec(location.hash.slice(1));
  } catch (e) {
    return {
      title: "Campaign preview",
      body: h("div", { class: "wrap narrow" },
        pageHead("Preview", "This link isn't a usable campaign", `${(e as Error).message}. Build one in the campaign builder.`),
        h("a", { class: "btn primary", href: "/campaigns/new" }, "Open the builder"), h("div", { class: "spacer" })),
    };
  }

  const p = project(spec);
  const art = h("div", { class: "claimart" }, questArt(spec.name, spec.rules));
  const progress = h("div", { class: "progress", "aria-live": "polite" });
  const showProgress = (lit: boolean[]) => {
    const total = requirementCount(spec.rules);
    const done = requirementsMet(spec.rules, lit);
    replace(art, questArt(spec.name, spec.rules, lit));
    replace(progress, h("div", { class: "meter big" }, h("i", { style: `width:${total ? (done / total) * 100 : 100}%` })), h("p", { class: "muted small-text" }, `${done} of ${total} done`));
  };
  const celebrate = () => art.classList.add("won");
  const postsBox = h("div", { style: "display:grid;gap:10px;margin-top:14px" });
  const postTargets = [...new Set(spec.rules.filter((r) => RULES[r.kind]?.input === "post").map((r) => r.target))];
  void Promise.all(postTargets.map((t) => fetchPost(t).catch(() => null))).then((found) => replace(postsBox, found.filter((x) => x !== null).map(postCard)));
  const exp = exposure(spec);
  const results = h("div", { class: "steps" });
  const after = h("div");
  const handle = h("input", { placeholder: "yourname.bsky.social", "aria-label": "Bluesky handle", autocomplete: "off", autocapitalize: "off", spellcheck: "false" });
  const go = h("button", { class: "btn primary", type: "submit" }, "Check eligibility");
  const form = h("form", { class: "row", style: "margin-top:12px" }, h("div", { style: "flex:1;min-width:220px" }, handle), go);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    go.disabled = true;
    replace(after);
    replace(results, stepCard("run", "Reading the account", "Finding the DID and verifying its identity log."));
    try {
      const actor = await resolveActor(handle.value);
      const me = await identity(actor.did);
      const head = stepCard("ok", `@${actor.handle}`, `Identity log verified: ${me.chain.len} operation${me.chain.len === 1 ? "" : "s"}, ${me.chain.alg} signing key.`);
      replace(results, head);

      showProgress(spec.rules.map(() => false));
      const cards = spec.rules.map((r) => {
        const c = stepCard("run", RULES[r.kind]!.name, "Checking…");
        results.appendChild(c);
        return c;
      });
      const lit = spec.rules.map(() => false);
      const out: RuleResult[] = await Promise.all(spec.rules.map(async (rule, i) => {
        const res = await checkRule(rule, me);
        const card = stepCard(res.status === "met" ? "ok" : "fail", RULES[rule.kind]!.name, res.detail, res.uri);
        cards[i]!.replaceWith(card);
        lit[i] = res.status === "met";
        showProgress(lit);
        return res;
      }));

      let onList = true;
      let allocation: bigint | null = null;
      if (spec.allocations) {
        const line = spec.allocations.find((a) => a.did === actor.did);
        onList = !!line;
        allocation = line ? BigInt(line.amount) : null;
        results.appendChild(stepCard(onList ? "ok" : "fail", "Allocation list", onList ? `Allocated ${fromMicro(allocation!)} ${unit}.` : "This account isn't on the list."));
      }
      showOutcome(actor, out, onList, allocation);
    } catch (err) {
      replace(results, stepCard("fail", "Couldn't check that account", (err as Error).message));
    } finally {
      go.disabled = false;
    }
  });

  function showOutcome(actor: Actor, out: RuleResult[], onList: boolean, allocation: bigint | null): void {
    const ids = groupsOf(spec.rules);
    // a miss inside an either/or group doesn't matter if another member of the group is met
    const unmet = out.filter((r, i) => r.status !== "met" && !(ids[i] && out.some((o, j) => ids[j] === ids[i] && o.status === "met")));
    if (unmet.length || !onList) {
      replace(after, h("div", { class: "note warn" }, h("strong", null, unmet.some((u) => u.status === "error") ? "Some checks didn't finish." : "Not eligible yet."), " ", onList ? "Complete the steps above, then check again. New records can take a moment to appear." : "Only accounts on the list can claim this one."));
      return;
    }
    celebrate();
    const bytes = out.reduce((n, r) => n + (r.bytes ?? 0), 0);
    const earn = allocation ?? BigInt(spec.reward);
    const keyInput = h("input", { class: "mono", placeholder: "64-character wallet public key (hex)", "aria-label": "Wallet public key", spellcheck: "false" });
    const codeOut = h("div");
    const walletRow = h("div", { class: "row" });
    const useKey = (key: string) => {
      keyInput.value = key;
      keyInput.dispatchEvent(new Event("input"));
    };
    const stop = onWallet((w) => {
      if (!walletRow.isConnected && walletRow.dataset.seen) {
        stop();
        return;
      }
      walletRow.dataset.seen = "1";
      if (!w.available) replace(walletRow);
      else if (w.key) {
        replace(walletRow, h("span", { class: "muted small-text" }, `Using your ${w.name} wallet.`));
        const key = w.key;
        if (keyInput.value !== key) queueMicrotask(() => useKey(key));
      } else {
        replace(walletRow, h("button", { class: "btn ghost small", type: "button", onclick: async () => { try { await connectWallet(); } catch (e) { replace(walletRow, h("p", { class: "fielderr" }, friendly(e))); } } }, `Connect ${w.name}`));
      }
    });
    keyInput.addEventListener("input", async () => {
      const v = keyInput.value.trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(v)) {
        replace(codeOut, v ? h("p", { class: "muted small-text" }, "A wallet key is 64 hex characters.") : null);
        return;
      }
      const code = await claimCode("component_preview", actor.did, fromHex(v), 0);
      const text = `Claiming my reward from ${spec.name}. ${code}`;
      replace(codeOut,
        h("pre", null, text),
        h("div", { class: "row", style: "margin-top:10px" }, h("a", { class: "btn ghost small", href: composeUrl(text), target: "_blank", rel: "noopener noreferrer" }, "Post on Bluesky"), copyButton(() => text)),
        h("p", { class: "muted small-text", style: "margin-top:8px" }, "This is the format of the post, but a live code also commits to the campaign's address, so don't post this preview code."));
    });
    replace(after,
      h("div", { class: "note ok" }, h("strong", null, `@${actor.handle} qualifies for ${fromMicro(earn)} ${unit}${spec.rounds > 1 ? " per round" : ""}.`), ` Every rule was verified in this browser by the same code the contract runs. The proofs total ${(bytes / 1024).toFixed(1)} KB.`),
      h("div", { class: "panel", style: "margin-top:16px" },
        h("h2", null, "Claiming"),
        h("p", { class: "muted small-text", style: "margin:0" }, "A claim also needs a post tying the payout to your wallet, so nobody can redirect it. Connect your wallet, or enter its key, to see the post."),
        walletRow,
        keyInput,
        codeOut,
      ),
      !isPublished() ? h("div", { class: "note warn" }, h("strong", null, "This is a preview."), " No funds exist behind it, so nothing can be claimed.") : null,
    );
  }

  return {
    title: spec.name,
    body: h("div", { class: "wrap narrow" },
      h("div", { class: "note warn", style: "margin-top:24px" }, h("strong", null, "Preview, not a live campaign."), " Anyone can make a link like this, so it promises nothing: there is no money behind it. A live campaign shows its funded contract address."),
      pageHead("Campaign preview", spec.name, spec.about || undefined),
      art,
      h("div", { class: "row", style: "margin:14px 0 22px" }, h("a", { class: "btn ghost small", href: `/campaigns/new#${encodeSpec(spec)}` }, "Use this as a template"), h("a", { class: "btn ghost small", href: participantLink(encodeSpec(spec)), target: "_blank", rel: "noopener" }, "Track it on Skydrop")),

      h("div", { class: "grid g3", style: "margin-top:0" },
        h("div", { class: "card" }, h("span", { class: "tag" }, "reward"), h("h3", null, spec.allocations ? "Listed amounts" : `${fromMicro(p.perClaimant)} ${unit}`), h("p", null, spec.rounds > 1 ? `${fromMicro(spec.reward)} over ${spec.rounds} rounds, ${spec.roundDays} days apart.` : "Paid once per account.")),
        h("div", { class: "card" }, h("span", { class: "tag" }, "pool"), h("h3", null, `${fromMicro(spec.budget)} ${unit}`), h("p", null, spec.allocations ? `For ${spec.allocations.length} listed accounts.` : `Enough for ${p.maxClaimants.toLocaleString("en-US")} people.`)),
        h("div", { class: "card" }, h("span", { class: "tag" }, "window"), h("h3", null, `${spec.days} days`), h("p", null, spec.startsInDays ? `Opens ${spec.startsInDays} days after creation.` : "Opens at creation."), exposurePill(exp.level)),
      ),

      h("h2", { class: "big", style: "margin-top:38px" }, "What to do"),
      spec.rules.length ? h("p", { class: "sentence" }, `To earn the reward: ${summarize(spec.rules)}.`) : null,
      postsBox,
      spec.rules.length
        ? h("ol", { class: "steps", style: "padding:0;list-style:none" }, spec.rules.map((r, i) => h("li", { class: "stepcard" }, h("span", { class: "mark" }, String(i + 1)), h("div", null, ruleLine(r), h("p", null, RULES[r.kind]!.help)))))
        : h("p", { class: "muted", style: "margin-top:10px" }, "Nothing beyond being on the allocation list."),

      h("h2", { class: "big", style: "margin-top:38px" }, "Check an account"),
      h("p", { class: "muted", style: "margin-top:8px" }, "This reads public Bluesky data and verifies it in your browser. Nothing is signed or sent."),
      form,
      progress,
      results,
      after,
      h("div", { class: "spacer" }),
    ),
  };
}

export function stepCard(state: "ok" | "fail" | "run" | "idle", title: string, text?: string, kv?: string): HTMLElement {
  const mark = { ok: "✓", fail: "✕", run: "…", idle: "·" }[state];
  return h("div", { class: `stepcard ${state}` }, h("span", { class: "mark", "aria-hidden": "true" }, mark),
    h("div", null, h("h3", null, title), text ? h("p", null, text) : null, kv ? h("div", { class: "kv" }, kv) : null));
}
