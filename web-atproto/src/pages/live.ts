/** Launching a campaign, and its live page. Everything on the live page is read from the chain. */
import { DEPLOYMENT, participantLink } from "../data/deployment";
import { questArt } from "../lib/art";
import { targetLink } from "../lib/atproto";
import { approxTime, encodeLive, fromMicro, RULES, summarize, toMicro, type Spec } from "../lib/campaign";
import { asInputs, campaignFromTx, closeInstructions, createInstruction, currentEpoch, explainChainError, extendInstruction, FUNDS_WORKSPACE, listClaims, phaseOf, readCampaign, TARI_RESOURCE, topUpInstruction, waitForOutcome, type ChainCampaign } from "../lib/chain";
import { copyButton, h, pageHead, pill, replace } from "../lib/dom";
import { allocationsFor, rememberAllocations } from "../lib/library";
import { connectWallet, dryRunInstructions, friendly, onWallet, sendFunded, sendInstructions, walletBalance, type Stage, type WalletState } from "../lib/wallet";
import type { Page } from "../main";

const unit = "tTARI";
/** Limits on what the wallet may charge in fees. It only charges the real cost: creating measured about 0.016 tTARI. */
const LAUNCH_MAX_FEE = 1_000_000n;
const MANAGE_MAX_FEE = 500_000n;

const stageText = (s: Stage): string => (s === "approve" ? "Approve it in your wallet…" : "Sending to the network…");

function connectButton(w: WalletState, onError: (msg: string) => void): HTMLElement {
  return h("button", { class: "btn primary small", type: "button", onclick: async () => { try { await connectWallet(); } catch (e) { onError(friendly(e)); } } }, `Connect ${w.name}`);
}

const wrongNetwork = (w: WalletState): boolean => !!w.network && w.network !== "esmeralda";

/** The builder's last step: fund the contract from the connected wallet. */
export function launchBox(spec: Spec): HTMLElement {
  const box = h("div", { style: "display:grid;gap:10px" });
  const status = h("p", { class: "muted small-text", "aria-live": "polite", style: "margin:0" });
  let busy = false;

  async function launch(btn: HTMLButtonElement, w: WalletState): Promise<void> {
    if (busy) return;
    busy = true;
    btn.disabled = true;
    status.className = "muted small-text";
    try {
      const budget = BigInt(spec.budget);
      const have = await walletBalance();
      if (have !== null && have < budget + LAUNCH_MAX_FEE / 10n) throw new Error(`Your wallet has ${fromMicro(have)} ${unit}, which doesn't cover the ${fromMicro(budget)} ${unit} pool and the fee.`);
      status.textContent = "Reading the network…";
      const epoch = await currentEpoch();
      const tx = await sendFunded(budget, TARI_RESOURCE, FUNDS_WORKSPACE, [createInstruction(spec, epoch, w.key!)], [DEPLOYMENT.linkRegistry], LAUNCH_MAX_FEE, (s) => { status.textContent = stageText(s); });
      status.textContent = "Waiting for the network to confirm…";
      const out = await waitForOutcome(tx);
      if (out.state === "rejected") throw new Error(`The network refused it, and only the fee was spent. ${out.reason}`);
      if (out.state === "pending") throw new Error(`It hasn't confirmed yet. Don't fund it again: check My campaigns in a few minutes. Transaction ${tx}`);
      const live = await campaignFromTx(tx);
      if (!live) throw new Error(`It went through, but the campaign couldn't be read back. Check My campaigns. Transaction ${tx}`);
      rememberAllocations(live.component, spec.allocations);
      location.href = `/c/${live.component}`;
    } catch (e) {
      status.className = "fielderr";
      status.textContent = explainChainError(friendly(e));
      btn.disabled = false;
      busy = false;
    }
  }

  const stop = onWallet((w) => {
    if (box.dataset.seen && !box.isConnected) {
      stop();
      return;
    }
    box.dataset.seen = "1";
    if (busy) return;
    if (!w.available) {
      replace(box, h("p", { class: "muted small-text", style: "margin:0" }, "To fund it, add the Sapient wallet to this browser."), h("a", { class: "btn ghost small", href: "https://sapient.tari.mw", target: "_blank", rel: "noopener noreferrer" }, "Get Sapient"));
    } else if (!w.connected || !w.key) {
      replace(box, h("p", { class: "muted small-text", style: "margin:0" }, "Connect the wallet that will fund this campaign."), connectButton(w, (m) => { status.className = "fielderr"; status.textContent = m; }), status);
    } else if (wrongNetwork(w)) {
      replace(box, h("p", { class: "note warn", style: "margin:0" }, `Your wallet is on ${w.network}. Switch it to Esmeralda to fund this.`));
    } else {
      const go = h("button", { class: "btn primary", type: "button" }, `Fund and launch: ${fromMicro(spec.budget)} ${unit}`);
      go.addEventListener("click", () => void launch(go, w));
      replace(box, go, h("p", { class: "muted small-text", style: "margin:0" }, `The pool leaves your wallet now, plus a small network fee, and stays locked in the contract until it closes. The rules can't be changed afterwards, and you can only move the close date later.`), status);
    }
  });
  return box;
}

function statRow(label: string, value: string): HTMLElement {
  return h("div", null, h("dt", null, label), h("dd", null, value));
}

function ruleRow(c: ChainCampaign, i: number): HTMLElement {
  const r = c.rules[i]!;
  const def = RULES[r.kind]!;
  const link = targetLink(r.target);
  return h("li", { class: "stepcard" }, h("span", { class: "mark" }, String(i + 1)), h("div", null,
    h("span", null, r.or ? "Or: " : "", def.verb, " ", link ? h("a", { href: link, target: "_blank", rel: "noopener noreferrer" }, r.target.length > 44 ? `${r.target.slice(0, 26)}…${r.target.slice(-12)}` : r.target) : h("code", { class: "mono" }, r.target)),
    r.text ? h("p", null, `It must contain “${r.text}”.`) : null,
  ));
}

function phaseLine(c: ChainCampaign): string {
  const phase = phaseOf(c);
  if (phase === "upcoming") return `Opens at epoch ${c.openEpoch.toLocaleString("en-US")}, in ${approxTime(c.openEpoch - c.epoch)}. Closes at epoch ${c.closeEpoch.toLocaleString("en-US")}.`;
  if (phase === "open") return `Closes at epoch ${c.closeEpoch.toLocaleString("en-US")}, in ${approxTime(c.closeEpoch - c.epoch)}. The network is at epoch ${c.epoch.toLocaleString("en-US")}.`;
  return `Closed at epoch ${c.closeEpoch.toLocaleString("en-US")}. The network is at epoch ${c.epoch.toLocaleString("en-US")}.`;
}

/** What the funder can do. Each action is also enforced by the contract, whatever this page shows. */
function manageBox(c: ChainCampaign, w: WalletState, reload: () => void): HTMLElement {
  const status = h("p", { class: "muted small-text", "aria-live": "polite" });
  const fail = (e: unknown) => {
    status.className = "fielderr";
    status.textContent = explainChainError(friendly(e));
  };
  const finish = async (tx: string, done: string) => {
    status.textContent = "Waiting for the network to confirm…";
    const out = await waitForOutcome(tx);
    if (out.state === "rejected") throw new Error(out.reason);
    if (out.state === "pending") throw new Error(`It hasn't confirmed yet. Refresh in a few minutes. Transaction ${tx}`);
    status.className = "muted small-text";
    status.textContent = done;
    reload();
  };
  const onStage = (s: Stage) => {
    status.className = "muted small-text";
    status.textContent = stageText(s);
  };

  const amount = h("input", { placeholder: "10", inputmode: "decimal", "aria-label": `Amount to add in ${unit}` });
  const topUp = h("form", { class: "row" }, h("div", { style: "flex:1;min-width:120px" }, amount), h("button", { class: "btn ghost small", type: "submit" }, "Add to pool"));
  topUp.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const micro = toMicro(amount.value);
      if (micro <= 0n) throw new Error("Enter an amount above zero.");
      await finish(await sendFunded(micro, TARI_RESOURCE, FUNDS_WORKSPACE, [topUpInstruction(c.component)], [c.component], MANAGE_MAX_FEE, onStage), `Added ${fromMicro(micro)} ${unit}.`);
    } catch (err) {
      fail(err);
    }
  });

  const days = h("input", { placeholder: "7", inputmode: "numeric", "aria-label": "Days to add" });
  const extend = h("form", { class: "row" }, h("div", { style: "flex:1;min-width:120px" }, days), h("button", { class: "btn ghost small", type: "submit" }, "Add days"));
  extend.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const d = Number(days.value);
      if (!(d > 0)) throw new Error("Enter a number of days above zero.");
      const target = Math.max(c.closeEpoch, c.epoch) + Math.round(d * 24);
      await finish(await sendInstructions([extendInstruction(c.component, target)], MANAGE_MAX_FEE, onStage, asInputs([c.component])), `Now closes at epoch ${target.toLocaleString("en-US")}.`);
    } catch (err) {
      fail(err);
    }
  });

  const closed = phaseOf(c) === "closed";
  const take = h("button", { class: "btn primary small", type: "button", disabled: !closed || c.balance === 0n }, `Take back ${fromMicro(c.balance)} ${unit}`);
  take.addEventListener("click", async () => {
    take.disabled = true;
    try {
      const ins = closeInstructions(c.component, w.account!);
      status.textContent = "Checking it will work…";
      const inputs = asInputs([c.component, c.vault]);
      await dryRunInstructions(ins, MANAGE_MAX_FEE, inputs);
      await finish(await sendInstructions(ins, MANAGE_MAX_FEE, onStage, inputs), "The funds are back in your wallet.");
    } catch (err) {
      take.disabled = false;
      fail(err);
    }
  });

  return h("div", { class: "panel", style: "margin-top:16px" },
    h("h2", null, "Manage your campaign"),
    h("p", { class: "muted small-text", style: "margin:0" }, "You can add funds and move the close date later. You can't change the rules, close it early or take funds before it closes, so people's rewards stay safe."),
    h("h3", { style: "margin-top:14px" }, "Add to the pool"), topUp,
    h("h3", { style: "margin-top:14px" }, "Keep it open longer"), extend,
    h("h3", { style: "margin-top:14px" }, "Take back what's left"),
    h("p", { class: "muted small-text", style: "margin:0 0 8px" }, closed ? "It has closed, so what's left is yours." : `Available once it closes, in ${approxTime(c.closeEpoch - c.epoch)}.`),
    take,
    status,
  );
}

export function livePage(component: string): Page {
  const body = h("div", { class: "wrap narrow" }, pageHead("Live campaign", "Reading the contract…"));
  let stopWallet: (() => void) | null = null;

  async function load(): Promise<void> {
    let c: ChainCampaign;
    try {
      c = await readCampaign(component);
    } catch (e) {
      replace(body, pageHead("Live campaign", "This campaign can't be shown", (e as Error).message), h("a", { class: "btn primary", href: "/campaigns" }, "Browse campaigns"), h("div", { class: "spacer" }));
      return;
    }
    document.title = `${c.name} · ATProto for Ootle`;
    const allocations = allocationsFor(component);
        const phase = phaseOf(c);
    const people = c.reward > 0n ? c.balance / c.reward : 0n;
    const paidShare = c.paid + c.balance > 0n ? Number((c.paid * 1000n) / (c.paid + c.balance)) / 10 : 0;
    const manage = h("div");
    const claims = h("div", null, h("p", { class: "muted small-text" }, "Reading recent claims…"));

    stopWallet?.();
    stopWallet = onWallet((w) => {
      if (w.key === c.funder && w.account) replace(manage, manageBox(c, w, () => void load()));
      else replace(manage);
    });
    void listClaims(component).then((list) => {
      replace(claims, list.length
        ? h("div", { class: "tablewrap" }, h("table", null,
            h("thead", null, h("tr", null, h("th", null, "Account"), h("th", null, "Round"), h("th", { style: "text-align:right" }, "Paid"))),
            h("tbody", null, list.map((x) => h("tr", null,
              h("td", { class: "m" }, h("a", { href: `https://bsky.app/profile/${x.did}`, target: "_blank", rel: "noopener noreferrer" }, x.did)),
              h("td", { class: "num" }, String(x.round + 1)),
              h("td", { class: "num" }, `${fromMicro(x.amount)} ${unit}`)))),
          ))
        : h("p", { class: "muted small-text" }, "Nobody has claimed yet."));
    }).catch(() => replace(claims, h("p", { class: "muted small-text" }, "Recent claims couldn't be read.")));

    const link = participantLink(encodeLive(c.component, allocations));
    replace(body,
      h("div", { class: "row", style: "margin-top:24px;gap:8px" },
        pill(phase === "open" ? "ok" : phase === "upcoming" ? "info" : "plain", phase === "open" ? "Open" : phase === "upcoming" ? "Not open yet" : "Closed"),
        pill("info", DEPLOYMENT.network),
      ),
      pageHead("Live campaign", c.name, c.info || undefined),
      h("div", { class: "claimart" }, questArt(c.name, c.rules)),
      h("div", { class: "row", style: "margin:14px 0 22px" },
        h("a", { class: "btn primary small", href: link, target: "_blank", rel: "noopener" }, "Claim on Skydrop"),
        copyButton(() => link, "Copy link for participants"),
        h("button", { class: "btn ghost small", type: "button", onclick: () => void load() }, "Refresh"),
      ),

      h("h2", { class: "vh" }, "At a glance"),
      h("div", { class: "grid g3", style: "margin-top:0" },
        h("div", { class: "card" }, h("span", { class: "tag" }, "reward"), h("h3", null, c.root ? "Listed amounts" : `${fromMicro(c.reward)} ${unit}`), h("p", null, c.rounds > 1 ? `Per round, ${c.rounds} rounds.` : "Paid once per account.")),
        h("div", { class: "card" }, h("span", { class: "tag" }, "pool left"), h("h3", null, `${fromMicro(c.balance)} ${unit}`), h("p", null, c.root ? "Held by the contract." : `Enough for ${people.toLocaleString("en-US")} more ${people === 1n ? "payment" : "payments"}.`)),
        h("div", { class: "card" }, h("span", { class: "tag" }, "claimed"), h("h3", null, `${c.claimants.toLocaleString("en-US")} ${c.claimants === 1 ? "person" : "people"}`), h("p", null, `${fromMicro(c.paid)} ${unit} paid in ${c.payments.toLocaleString("en-US")} ${c.payments === 1 ? "payment" : "payments"}.`)),
      ),
      h("div", { class: "meter big", role: "img", "aria-label": `${paidShare} percent of the funds paid out`, style: "margin-top:16px" }, h("i", { style: `width:${paidShare}%` })),
      h("p", { class: "muted small-text" }, phaseLine(c), " Times assume about one epoch an hour."),
      c.root && !allocations ? h("div", { class: "note warn" }, h("strong", null, "Allocation list not in this browser. "), "The chain holds only its fingerprint. Share the link from the browser that launched it, so claimers receive the list.") : null,
      manage,

      h("h2", { class: "big", style: "margin-top:38px" }, "What to do"),
      c.rules.length ? h("p", { class: "sentence" }, `To earn the reward: ${summarize(c.rules)}.`) : h("p", { class: "muted" }, "Nothing beyond being on the allocation list."),
      c.rules.length ? h("ol", { class: "steps", style: "padding:0;list-style:none" }, c.rules.map((_, i) => ruleRow(c, i))) : null,

      h("h2", { class: "big", style: "margin-top:38px" }, "Recent claims"),
      claims,

      h("h2", { class: "big", style: "margin-top:38px" }, "On the network"),
      h("dl", { class: "statlist", style: "margin-top:12px" },
        statRow("Funded by", `${c.funder.slice(0, 12)}…${c.funder.slice(-6)}`),
      ),
      h("p", { class: "muted small-text mono", style: "word-break:break-all;margin-top:10px" }, c.component),
      h("p", { class: "muted small-text" }, "Anyone can create a campaign with this contract. This page shows what its contract holds and enforces, not who is behind it."),
      h("div", { class: "spacer" }),
    );
  }
  void load();
  return { title: "Live campaign", body };
}
