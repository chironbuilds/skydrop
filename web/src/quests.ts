/**
 * Skydrop's participant side: the campaigns someone is in, what they can claim now and what's left to do. Creating
 * campaigns happens on atproto.tari.mw; both sites share the verifier and the eligibility checks in web-atproto/src/lib.
 */
import "./quests.css";
import { poolBar, questArt, ruleChips } from "../../web-atproto/src/lib/art";
import { parachute } from "../../web-atproto/src/lib/icons";
import { celebrate, countUp, initMotion, once, skeleton } from "../../web-atproto/src/lib/motion";
import { composeUrl, fetchPost, latestPost, resolveActor, targetLink, type Actor } from "../../web-atproto/src/lib/atproto";
import { afterFee, approxTime, claimFee, decodeSpec, encodeLive, encodeSpec, EPOCHS_PER_DAY, fromMicro, LIVE_PLACEHOLDER, RULES, summarize, type Rule, type Spec } from "../../web-atproto/src/lib/campaign";
import { checkRule, identity, type Identity, type RuleResult } from "../../web-atproto/src/lib/check";
import { currentEpoch, explainChainError, listCampaigns, listMyClaims, phaseOf, readCampaign, readLink, readReceipt, specOf, usableReferrer, waitForOutcome, type ChainCampaign, type Instruction, type MyClaim, type Receipt, type SubstateInput, type WalletLink } from "../../web-atproto/src/lib/chain";
import { icons } from "./dom";
import { currentLang, setLang, startChinese } from "./i18n";
import { BATCH_MAX, batchPostText, CLAIM_MAX_FEE, LINK_FEE, LINK_MAX_FEE, LINKED_CLAIM_SAVING, mergePlans, planClaim, planLink, type ReadyPlan } from "../../web-atproto/src/lib/claim";
import { append, copyButton, h, replace } from "../../web-atproto/src/lib/dom";
import { fetchList, listMatches } from "../../web-atproto/src/lib/lists";
import { assess, deadlineOf, reminderFile, settle, totals, type Assessment, type StepView } from "../../web-atproto/src/lib/quests";
import { attachSuggest } from "../../web-atproto/src/lib/suggest";
import { connectWallet, dryRunInstructions, friendly, onWallet, sendInstructions, shortAddress, silentConnect, walletBalance, walletState } from "../../web-atproto/src/lib/wallet";
import { campaignLink, contractsOnNetwork, DEPLOYMENT, isPublished } from "../../web-atproto/src/data/deployment";

const unit = "tTARI";
const CREATOR = "https://atproto.tari.mw";
const EXPLORER = "https://testnet-explorer.tari.mw";
const QKEY = "skydrop-quests";
const HKEY = "skydrop-handle";
/** Campaigns someone removed, so finding their past campaigns doesn't bring them back. */
const HIDDEN = "skydrop-hidden";
/** Who invited this browser to each campaign. The contract pays them a bonus from the pool, never from the reward. */
const REFS = "skydrop-refs";

interface Tracked { id: string; spec: Spec; added: number; example?: boolean }

const store = {
  get<T>(k: string, fallback: T): T {
    try {
      const v = localStorage.getItem(k);
      return v === null ? fallback : (JSON.parse(v) as T);
    } catch {
      return fallback;
    }
  },
  set(k: string, v: unknown): void {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* private window: the list just won't be remembered */
    }
  },
};

const refFor = (id: string): string | null => store.get<Record<string, string>>(REFS, {})[id] ?? null;
function setRef(id: string, did: string | null): void {
  const all = store.get<Record<string, string>>(REFS, {});
  if (did) all[id] = did;
  else delete all[id];
  store.set(REFS, all);
}
/** The inviter named in a link, if it's a well-formed account. A link can say anything, so it's only ever a suggestion. */
function refInLink(text: string): string | null {
  const m = text.match(/[&?]ref=([^&#\s]+)/);
  if (!m) return null;
  let did = m[1]!;
  try {
    did = decodeURIComponent(did);
  } catch {
    return null;
  }
  return /^did:(plc:[a-z2-7]{24}|web:[a-zA-Z0-9.-]{1,200})$/.test(did) ? did : null;
}

const hashOf = (s: Spec): string => encodeSpec({ ...s }).slice(0, 180) + encodeSpec({ ...s }).length;
const loadTracked = (): Tracked[] => store.get<Tracked[]>(QKEY, []).filter((t) => t?.spec && Array.isArray(t.spec.rules));

/** Adds a campaign from a shared link's text. Everything in it is re-validated, and shown only as text. */
function trackFromText(text: string): { ok: true; id: string; name: string; isNew: boolean } | { ok: false; error: string } {
  const ref = refInLink(text);
  const m = text.trim().replace(/[&?]ref=[^&#\s]*/, "").match(/(?:#add=|\/c\/preview#|campaigns\/new#|^)([A-Za-z0-9_-]{20,})$/);
  if (!m) return { ok: false, error: "That doesn't look like a campaign link." };
  try {
    const spec = decodeSpec(m[1]!);
    const list = loadTracked();
    const id = spec.component ?? hashOf(spec);
    if (ref && spec.component) setRef(id, ref);
    if (list.some((t) => t.id === id)) return { ok: true, id, name: spec.name, isNew: false };
    list.unshift({ id, spec, added: Date.now() });
    store.set(QKEY, list);
    return { ok: true, id, name: spec.name, isNew: true };
  } catch (e) {
    return { ok: false, error: `That link couldn't be read: ${(e as Error).message}` };
  }
}

// ---- state ------------------------------------------------------------------------------------------------
let actor: Actor | null = null;
const assessments = new Map<string, Assessment>();
/** What the chain says about tracked live campaigns. Their terms come from here, not from the link that added them. */
const liveData = new Map<string, { c: ChainCampaign; receipt: Receipt | null; inviter: string | null }>();
const liveErrors = new Map<string, string>();
/** Each live card's claim panel, kept across redraws so a claim in progress isn't lost. */
const panels = new Map<string, HTMLElement>();
/** How far each ready campaign's claim has got: 2 is the post, 3 is collecting. */
const panelStage = new Map<string, 2 | 3>();
/** Claims waiting for their post to appear, re-checked when someone comes back from Bluesky. */
const rechecks = new Map<string, () => void>();
/** What a step points at, in words: a post's author and text, or an account's handle. */
const targetInfo = new Map<string, string>();
let openCampaigns: ChainCampaign[] | null = null;
/** The wallet the current account has linked, as the registry says. */
let myLink: WalletLink | null = null;
/** The link steps while someone is going through them. */
let linkFlow: HTMLElement | null = null;
let linkRecheck: (() => void) | null = null;
let lastCheck = 0;
let checking = false;
/** A check was asked for during another, which may have been for a different account. */
let checkAgain = false;
let handleSearch = 0;
/** How far someone stands in each open campaign they haven't added. */
const openStand = new Map<string, Assessment>();
/** What this account has been paid, from the chain. */
let payments: MyClaim[] = [];
/** The campaign a link brought someone here for: shown above the form until there's a handle, then scrolled to. */
let arrived: string | null = null;
let pendingFocus: string | null = null;
let flashId: string | null = null;
/** The "collect all" steps while someone is going through them. */
let batchFlow: HTMLElement | null = null;
let batchRecheck: (() => void) | null = null;
/** When a post was last asked for. Looking for it stops after a while, so a forgotten tab doesn't keep asking. */
let postAskedAt = 0;
/** One account's steps across all campaigns in a check: many campaigns ask for the same thing. */
const ruleChecks = new Map<string, Promise<RuleResult>>();

function cachedRule(r: Rule, me: Identity): Promise<RuleResult> {
  const key = `${me.did}|${r.kind}|${r.target}|${r.text ?? ""}|${r.snapshot ?? ""}`;
  let p = ruleChecks.get(key);
  if (!p) {
    p = checkRule(r, me);
    ruleChecks.set(key, p);
  }
  return p;
}

/** Runs `fn` over `items`, a few at a time. Checking in parallel keeps long lists quick without flooding anyone's server. */
async function inPool<T>(items: T[], size: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  }));
}

const handleInput = h("input", { placeholder: "yourname.bsky.social", "aria-label": "Your Bluesky handle", autocomplete: "off", autocapitalize: "off", spellcheck: "false", value: store.get(HKEY, "") });
const go = h("button", { class: "btn primary", type: "submit" }, "Show my quests");
const LEDE = "Enter your handle to see every campaign you're tracking. Each step is checked against your own signed Bluesky data, right here in your browser.";
const lede = h("p", { class: "lede" }, LEDE);
const who = h("div", { class: "who" });
const summary = h("div", { class: "qsummary" });
const board = h("div");
const addMsg = h("p", { class: "muted small-text", "aria-live": "polite" });
const openBox = h("div");
const linkBox = h("div", { class: "qlink" });
const arrivalBox = h("div");
const toastBox = h("div", { class: "qtoast", role: "status", "aria-live": "polite" });
let toastTimer = 0;

function toast(text: string, action?: { label: string; run: () => void }): void {
  replace(toastBox, text, action ? h("button", { class: "qtoastbtn", type: "button", onclick: () => { toastBox.classList.remove("on"); action.run(); } }, action.label) : null);
  toastBox.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastBox.classList.remove("on"), action ? 8000 : 5000);
}

/** The phone's own share sheet where there is one; otherwise a copied link. */
function shareButton(url: () => string, title: string, label = "Share"): HTMLElement {
  const nav = navigator as Navigator & { share?: (d: { title: string; url: string }) => Promise<void> };
  if (!nav.share || !matchMedia("(pointer: coarse)").matches) return copyButton(url, label);
  return h("button", { class: "btn small ghost", type: "button", onclick: () => void nav.share!({ title, url: url() }).catch(() => {}) }, label);
}

const addedText = (r: { name: string; isNew: boolean }): string => {
  const named = r.name && r.name !== LIVE_PLACEHOLDER;
  if (r.isNew) return named ? `Added “${r.name}”.` : "Campaign added.";
  return named ? `“${r.name}” is already on your list.` : "That campaign is already on your list.";
};

// ---- rendering --------------------------------------------------------------------------------------------
function stepAction(rule: Rule): HTMLElement | null {
  const link = targetLink(rule.target);
  const def = RULES[rule.kind]!;
  if (def.side === "voucher") return null;
  if (rule.kind === 3) return h("a", { class: "btn small ghost", href: composeUrl(rule.target), target: "_blank", rel: "noopener noreferrer" }, "Write the post");
  if (!link) return null;
  const label = { 0: "Like it", 1: "Repost it", 2: "Follow", 4: "Comment", 5: "Quote it" }[rule.kind as 0 | 1 | 2 | 4 | 5];
  return h("a", { class: "btn small ghost", href: link, target: "_blank", rel: "noopener noreferrer" }, label ?? "Open");
}

function stepLine(s: StepView): HTMLElement {
  const def = RULES[s.rule.kind]!;
  const mark = s.status === "met" ? "✓" : s.covered ? "–" : s.status === "error" ? "!" : "○";
  const cls = s.status === "met" ? "ok" : s.covered ? "skip" : s.status === "error" ? "err" : "todo";
  const fresh = s.status === "met" && once(`met|${s.rule.kind}|${s.rule.target}|${s.rule.text ?? ""}`);
  return h("li", { class: `qstep ${cls}${fresh ? " justmet" : ""}` },
    h("span", { class: "qmark", "aria-hidden": "true" }, mark),
    h("div", { class: "qsteptext" },
      h("span", null, def.name, s.rule.text ? ` saying “${s.rule.text}”` : "", s.rule.kind === 3 ? `: “${s.rule.target}”` : ""),
      s.status === "met" || s.covered || !targetInfo.has(s.rule.target) ? null : h("small", { class: "qtarget" }, targetInfo.get(s.rule.target)!),
      s.status === "met" ? null : h("small", null, s.covered ? "Not needed: you've done the other option." : s.status === "error" ? s.detail : s.actionable ? "Not done yet." : "Someone else decides this one."),
    ),
    s.status === "met" || s.covered ? null : stepAction(s.rule),
  );
}

function claimPanel(t: Tracked): HTMLElement {
  if (t.spec.component && liveData.has(t.id)) return livePanel(t);
  return h("div", { class: "qclaim" }, h("p", { class: "muted small-text" }, h("strong", null, "Nothing to collect. "),
    t.example ? "This is an example, with no money behind it." : "This is a preview, with no funds behind it. Your progress here is real."));
}

/** Sends a transaction that has already passed its dry run, and waits for the network's answer. */
async function sendAndConfirm(instructions: Instruction[], inputs: SubstateInput[], status: HTMLElement): Promise<void> {
  const tx = await sendInstructions(instructions, CLAIM_MAX_FEE, (s) => { status.textContent = s === "approve" ? "Approve it in your wallet…" : "Sending to the network…"; }, inputs);
  status.textContent = "Waiting for the network to confirm…";
  const out = await waitForOutcome(tx);
  if (out.state === "rejected") throw new Error(`The network refused it, and only the fee was spent. ${out.reason}`);
  if (out.state === "pending") throw new Error(`It hasn't confirmed yet. Don't claim again: refresh in a few minutes. Transaction ${tx}`);
}

/** The claim itself: tie the payout to the wallet with one post, then collect. */
function livePanel(t: Tracked): HTMLElement {
  const existing = panels.get(t.id);
  if (existing) return existing;
  const body = h("div", { style: "display:grid;gap:8px" });
  const panel = h("div", { class: "qclaim" }, body);
  panels.set(t.id, panel);

  const say = (text: string, cls = "muted small-text") => h("p", { class: cls, style: "margin:0" }, text);
  const reset = (message?: string) => {
    panels.delete(t.id);
    panelStage.delete(t.id);
    rechecks.delete(t.id);
    if (message) toast(message);
    void checkAll();
  };

  /** Set when an invite turned out not to work, so the claim goes ahead without it. */
  let skipInvite = false;
  /** Pay the connected wallet with a post, rather than the linked one. */
  let useThisWallet = false;

  /** `quiet` looks for the post in the background; `pressed` means someone said they've posted it. */
  let shownCode = "";
  async function begin(quiet = false, pressed = false): Promise<void> {
    const w = walletState();
    if (!w.available) {
      replace(body, say("You need the Sapient wallet to collect."), h("a", { class: "btn small ghost", href: "https://sapient.tari.mw", target: "_blank", rel: "noopener noreferrer" }, "Get Sapient"));
      return;
    }
    if (!w.connected || !w.key || !w.account) {
      try {
        await connectWallet();
      } catch (e) {
        replace(body, say(friendly(e), "fielderr"), startButton());
        return;
      }
      void begin();
      return;
    }
    if (w.network && w.network !== "esmeralda") {
      replace(body, say(`Your wallet is on ${w.network}. Switch it to Esmeralda, then try again.`, "fielderr"), startButton());
      return;
    }
    const live = liveData.get(t.id);
    if (!live || !actor) return;
    if (!quiet) replace(body, say("Checking your records and the campaign…"));
    try {
      const c = await readCampaign(live.c.component);
      const plan = await planClaim(c, actor.did, w.key, w.account, { allocations: t.spec.allocations, ref: skipInvite ? null : refFor(t.id), ignoreLink: useThisWallet });
      if (quiet && !rechecks.has(t.id)) return;
      rechecks.delete(t.id);
      const stage = plan.kind === "ready" ? 3 : 2;
      if (panelStage.get(t.id) !== stage) {
        panelStage.set(t.id, stage);
        draw();
      }
      switch (plan.kind) {
        case "post": {
          rechecks.set(t.id, () => void begin(true));
          if (quiet && shownCode === plan.code) break;
          if (shownCode !== plan.code) postAskedAt = Date.now();
          shownCode = plan.code;
          const again = h("button", { class: "btn small primary", type: "button", onclick: () => void begin(false, true) }, "I've posted it");
          replace(body,
            h("p", { class: "small-text", style: "margin:0" }, h("strong", null, plan.round > 0 ? `Round ${plan.round + 1}: post this to collect. ` : "One last step: post this. "), "It proves this Bluesky account chose your wallet, so nobody else can redirect the reward."),
            h("pre", { style: "white-space:pre-wrap;overflow-wrap:anywhere;margin:0" }, plan.text),
            h("div", { class: "row" }, h("a", { class: "btn small ghost", href: composeUrl(plan.text), target: "_blank", rel: "noopener noreferrer" }, "Post on Bluesky"), copyButton(() => plan.text), again),
            pressed ? say("That post isn't showing yet. It has to come from this account and include the whole code. It can take a few seconds, and this page keeps looking.", "fielderr") : null,
            say("This page checks for it by itself. You can delete the post after you've collected."),
            plan.receipt && plan.receipt.account !== w.account ? say(`This round pays ${shortAddress(plan.receipt.account)}, the wallet that collected the first round, not the one connected here.`) : null,
            plan.round === 0 && !myLink?.active ? h("button", { class: "linkbtn", type: "button", style: "justify-self:start", onclick: () => void startLink() }, "Link your wallet to skip this") : null,
          );
          break;
        }
        case "ready": {
          const status = say("");
          const go = h("button", { class: "btn small primary", type: "button" }, `Collect ${fromMicro(plan.amount)} ${unit}`);
          go.addEventListener("click", async () => {
            go.disabled = true;
            status.className = "muted small-text";
            try {
              status.textContent = "Checking it will work…";
              try {
                await dryRunInstructions(plan.instructions, CLAIM_MAX_FEE, plan.inputs);
              } catch (e) {
                if (!plan.referrer) throw e;
                // Someone else may have just used their last invite. Checking costs nothing, so try again without it.
                skipInvite = true;
                setRef(t.id, null);
                const shown = liveData.get(t.id);
                if (shown) shown.inviter = null;
                draw();
                toast("That invite can't be used any more. You'll still get your full reward.");
                void begin();
                return;
              }
              await sendAndConfirm(plan.instructions, plan.inputs, status);
              celebrate(go);
              reset(`Collected ${fromMicro(plan.amount)} ${unit} from “${t.spec.name}”.`);
            } catch (e) {
              status.className = "fielderr";
              status.textContent = explainChainError(friendly(e));
              go.disabled = false;
            }
          });
          const funds = h("div");
          const fee = claimFee(c.rules) - (plan.linked ? LINKED_CLAIM_SAVING : 0n);
          const net = plan.amount > fee ? plan.amount - fee : null;
          const elsewhere = plan.account !== w.account;
          replace(body, say(plan.linked ? "Your wallet is linked, so no post is needed." : "Your post is there. Last step:"), go,
            plan.linked && !plan.referrer && liveData.get(t.id)?.inviter ? say("Your invite only counts if the linked wallet sends this claim. Connect that wallet to count it.") : null,
            elsewhere ? say(plan.linked ? `It pays your linked wallet, ${shortAddress(plan.account)}, not the one connected here.` : `This round pays ${shortAddress(plan.account)}, the wallet that collected the first round, not the one connected here.`) : null,
            elsewhere && plan.linked ? h("button", { class: "linkbtn", type: "button", style: "justify-self:start", onclick: () => { useThisWallet = true; void begin(); } }, "Pay this wallet instead, with a post") : null, say(`Your wallet pays a network fee of about ${fromMicro(fee)} ${unit}${net ? `, so you end up about ${fromMicro(net)} ${unit} better off` : ", which may be more than this reward"}. Only the real cost is charged.`), funds, status);
          void walletBalance().then((have) => {
            if (have !== null && have < fee) replace(funds, h("p", { class: "note warn", style: "margin:0" }, `Your wallet has ${fromMicro(have)} ${unit}, which may not cover the fee. Add some first.`));
          });
          break;
        }
        case "steps":
          reset("A step isn't met any more. Your list has been refreshed.");
          break;
        case "done":
          reset();
          break;
        case "wait":
          replace(body, say(`The next round opens in ${approxTime(plan.opensAt - c.epoch)}.`));
          break;
        case "closed":
          replace(body, say("This campaign has closed."));
          break;
        case "upcoming":
          replace(body, say(`This campaign opens in ${approxTime(plan.opensAt - c.epoch)}.`));
          break;
        case "empty":
          replace(body, say("This campaign's pool has run out."));
          break;
        case "not-listed":
          replace(body, say("This account isn't on the campaign's list."));
          break;
        case "bad-list":
          replace(body, say("This campaign's list couldn't be found, so your amount can't be proven yet. Try again in a minute, or ask the creator for a fresh link.", "fielderr"));
          break;
      }
    } catch (e) {
      if (quiet) return;
      replace(body, say(explainChainError(friendly(e)), "fielderr"), startButton());
    }
  }

  const startButton = () => {
    const amount = assessments.get(t.id)?.perRound;
    return h("button", { class: "btn small primary", type: "button", onclick: () => void begin() }, amount ? `Collect ${fromMicro(amount)} ${unit}` : "Collect");
  };
  replace(body, startButton());
  return panel;
}

/** What a reward is really worth, once the network fee for collecting it is paid. */
function feeLine(reward: bigint, rules: Rule[]): HTMLElement {
  const net = afterFee(reward, rules);
  return net
    ? h("p", { class: "qnet" }, `About ${fromMicro(net)} ${unit} after the network fee.`)
    : h("p", { class: "qfeenote" }, `The network fee, about ${fromMicro(claimFee(rules))} ${unit}, may be more than this reward.`);
}

/** Where someone is in a live campaign. Only shown while there's still something to do. */
function flowSteps(t: Tracked, a: Assessment): HTMLElement | null {
  if (!t.spec.component || !["progress", "ready", "unknown"].includes(a.state)) return null;
  const direct = !!myLink?.active && !liveData.get(t.id)?.receipt;
  const stages = direct ? ["Do the steps", "Collect"] : ["Do the steps", "Post once", "Collect"];
  const now = a.state !== "ready" ? 1 : direct ? 2 : (panelStage.get(t.id) ?? 2);
  return h("ol", { class: "qflow", "aria-label": "Your progress" }, stages.map((label, i) =>
    h("li", { class: i + 1 < now ? "done" : i + 1 === now ? "now" : "", "aria-current": i + 1 === now ? "step" : null }, label)));
}

const inviteUrl = (t: Tracked, did: string): string => campaignLink(t.spec.component!, { allocations: t.spec.allocations, ref: did, origin: location.origin });

/** Time and room left in a live campaign, with a flag when it's worth not waiting. */
function deadlineLine(c: ChainCampaign, pay: bigint): HTMLElement | null {
  const phase = phaseOf(c);
  if (phase === "closed") return null;
  const d = deadlineOf(c, pay, !!c.root);
  const room = d.rewardsLeft === null ? "" : d.rewardsLeft === 1 ? " · 1 reward left" : ` · ${d.rewardsLeft.toLocaleString("en-US")} rewards left`;
  const when = phase === "upcoming" ? `Opens in ${approxTime(c.openEpoch - c.epoch)}, closes in ${approxTime(d.closesIn)}` : `Closes in ${approxTime(d.closesIn)}`;
  return h("p", { class: "qdead" }, d.urgent ? h("span", { class: "pill warn" }, d.urgent === "closing" ? "Closing soon" : "Few left") : null, ` ${when}${room}`);
}

/** Epochs until this account's next payment can happen. */
const waitFor = (c: ChainCampaign, receipt: Receipt | null): number => phaseOf(c) === "upcoming" ? c.openEpoch - c.epoch : receipt ? Math.max(0, receipt.lastEpoch + c.roundEpochs - c.epoch) : 0;

/** A calendar entry for when a campaign or round opens: the only reminder that doesn't need an account. */
function reminderLink(t: Tracked, c: ChainCampaign, receipt: Receipt | null): HTMLElement | null {
  const wait = waitFor(c, receipt);
  if (wait <= 0) return null;
  const at = new Date(Date.now() + (wait / EPOCHS_PER_DAY) * 86_400_000);
  const url = campaignLink(c.component, { origin: location.origin });
  const file = reminderFile(`Collect from ${t.spec.name} on Skydrop`, at, url);
  return h("a", { class: "btn small ghost", href: `data:text/calendar;charset=utf-8,${encodeURIComponent(file)}`, download: "skydrop-reminder.ics" }, "Remind me");
}

/** Invites: what's on offer before you've collected, and your own link and earnings after. */
function inviteBox(t: Tracked): HTMLElement | null {
  const live = liveData.get(t.id);
  if (!live || live.c.bonus <= 0n || live.c.maxReferrals === 0) return null;
  const { c, receipt, inviter } = live;
  const each = `${fromMicro(c.bonus)} ${unit}`;
  const open = phaseOf(c) === "open";
  if (receipt && actor) {
    const did = actor.did;
    const used = receipt.referrals;
    const earned = c.bonus * BigInt(used);
    const room = used < c.maxReferrals;
    const funded = c.balance >= c.reward + c.bonus;
    const count = `${used} of ${c.maxReferrals} invite${c.maxReferrals === 1 ? "" : "s"} used`;
    const tally = `${count}${earned > 0n ? `, ${fromMicro(earned)} ${unit} earned` : ""}.`;
    if (!open || !room || !funded) {
      if (!used) return null;
      return h("div", { class: "qinvite" }, h("p", { class: "small-text" }, h("strong", null, "Invites. "), tally, !room ? "" : !open ? " This campaign has closed." : " Its pool is too low to pay more."));
    }
    return h("div", { class: "qinvite" },
      h("p", { class: "small-text" }, h("strong", null, "Invite friends. "), `You get ${each} for each new person who collects through your link, up to ${c.maxReferrals}. It's paid to your wallet when they collect.`),
      h("p", { class: "muted small-text" }, tally),
      h("div", { class: "row" },
        shareButton(() => inviteUrl(t, did), c.name, "Share invite link"),
        h("a", { class: "btn small ghost", href: composeUrl(`${c.name}: earn ${fromMicro(c.reward)} ${unit} on Skydrop. ${inviteUrl(t, did)}`), target: "_blank", rel: "noopener noreferrer" }, "Post it on Bluesky"),
      ),
    );
  }
  if (!open) return null;
  if (inviter) {
    const name = targetInfo.get(inviter);
    const forget = h("button", { class: "linkbtn", type: "button" }, "Remove invite");
    forget.addEventListener("click", () => {
      setRef(t.id, null);
      live.inviter = null;
      draw();
    });
    return h("div", { class: "qinvite" }, h("p", { class: "small-text" }, h("strong", null, name ? `Invited by ${name}. ` : "You were invited. "), `They get ${each} from the campaign's pool when you collect. Your reward stays the same. `, forget));
  }
  return h("p", { class: "muted small-text", style: "margin:0" }, `Once you've collected, invite friends and earn ${each} each, up to ${c.maxReferrals}.`);
}

function questCard(t: Tracked, a?: Assessment): HTMLElement {
  const s = t.spec;
  const unread = !!s.component && !liveData.has(t.id);
  const lit = a ? a.steps.map((x) => x.status === "met") : [];
  const remove = h("button", { class: "linkbtn", type: "button" }, "Remove");
  remove.addEventListener("click", () => {
    const before = loadTracked();
    store.set(QKEY, before.filter((x) => x.id !== t.id));
    store.set(HIDDEN, [...store.get<string[]>(HIDDEN, []), t.id]);
    const was = assessments.get(t.id);
    assessments.delete(t.id);
    panels.delete(t.id);
    rechecks.delete(t.id);
    draw();
    toast(`Removed “${s.name}”.`, { label: "Undo", run: () => {
      store.set(QKEY, before);
      store.set(HIDDEN, store.get<string[]>(HIDDEN, []).filter((x) => x !== t.id));
      if (was) assessments.set(t.id, was);
      draw();
    } });
  });
  const invite = inviteBox(t);
  const hasLink = !!invite?.querySelector("button:not(.linkbtn), a.btn");
  const finished = a?.state === "claimed";
  const liveNow = liveData.get(t.id);
  const shareUrl = (): string => (s.component ? campaignLink(s.component, { allocations: s.allocations, origin: location.origin }) : `${location.origin}/quests#add=${encodeSpec(s)}`);
  return h("article", { class: `questcard qcard${a?.state === "ready" ? " won" : ""}${flashId === t.id ? " qflash" : ""}`, id: `quest-${t.id}` },
    h("div", { class: "qart" }, questArt(s.name, s.rules, lit), a?.state === "claimed" ? h("span", { class: `qstamp${once(`stamp|${t.id}`) ? " fresh" : ""}` }, "Collected") : null),
    h("div", { class: "questbody" },
      h("div", { class: "row", style: "justify-content:space-between;gap:6px" },
        h("h3", null, s.name),
        t.example ? h("span", { class: "pill plain" }, "Example") : liveData.get(t.id)?.c.legacy ? h("span", { class: "pill warn", title: "Made before the Ootle 0.50 network upgrade" }, "Retired") : liveData.has(t.id) ? h("span", { class: "pill ok" }, "Live") : s.component ? null : h("span", { class: "pill plain" }, "Preview"),
      ),
      unread ? null : h("p", { class: "questreward" }, s.allocations ? (a && a.perRound > 0n ? `${fromMicro(a.perRound)} ${unit}` : "Listed amounts") : `${fromMicro(s.reward)} ${unit}`, s.rounds > 1 ? h("small", { class: "muted" }, ` per round, ${s.rounds} rounds`) : null),
      unread || (s.allocations && !a?.perRound) ? null : feeLine(a?.perRound ?? BigInt(s.reward), s.rules),
      liveNow && !finished && !liveNow.c.legacy ? deadlineLine(liveNow.c, a?.perRound || liveNow.c.reward) : null,
      s.about ? h("p", { class: "muted small-text" }, s.about) : null,
      liveErrors.has(t.id) ? h("p", { class: "fielderr" }, liveErrors.get(t.id)!) : null,
      a && a.paid > 0n ? h("p", { class: "small-text", style: "margin:0" }, h("strong", null, `Collected ${fromMicro(a.paid)} ${unit}`), a.fullAmount > a.paid ? `, ${fromMicro(a.fullAmount - a.paid)} ${unit} still possible.` : ".") : null,
      a
        ? [
            finished ? null : flowSteps(t, a) ?? h("div", { class: "meter big", role: "img", "aria-label": `${a.done} of ${a.total} steps done` }, h("i", { class: once(`meter|${t.id}`) ? "fillin" : null, style: `width:${a.total ? (a.done / a.total) * 100 : a.state === "ready" ? 100 : 0}%` })),
            h("p", { class: "qhead" }, a.headline),
            // Once it's all paid, undoing a step changes nothing, so it isn't worth asking about.
            finished ? null : h("ul", { class: "qsteps" }, a.steps.map(stepLine)),
            a.state === "ready" ? claimPanel(t) : null,
            a.state === "waiting" && liveNow ? reminderLink(t, liveNow.c, liveNow.receipt) : null,
          ]
        : unread
          ? liveErrors.has(t.id) ? null : h("p", { class: "muted small-text" }, "Reading the contract…")
          : h("p", { class: "muted small-text" }, s.rules.length ? `${summarize(s.rules)[0]!.toUpperCase()}${summarize(s.rules).slice(1)}.` : "On an allocation list."),
      invite,
      h("div", { class: "row", style: "justify-content:space-between;margin-top:4px" }, hasLink ? h("span") : shareButton(shareUrl, s.name), remove),
    ));
}

// ---- linking a wallet ---------------------------------------------------------------------------------------

function drawLink(): void {
  if (!actor || !DEPLOYMENT.linkRegistry) {
    replace(linkBox);
    return;
  }
  if (linkFlow) {
    replace(linkBox, linkFlow);
    return;
  }
  const w = walletState();
  if (myLink?.next) {
    replace(linkBox, h("p", { class: "muted small-text" }, h("strong", null, "New wallet linked. "), `${shortAddress(myLink.next.account)} takes over in about an hour or more.`));
  } else if (myLink?.active) {
    const other = w.connected && w.account && w.account !== myLink.active;
    replace(linkBox,
      h("p", { class: "muted small-text" }, h("strong", null, "Wallet linked. "), `First claims need no post and pay ${shortAddress(myLink.active)}.`, " "),
      other ? h("button", { class: "linkbtn", type: "button", onclick: () => void startLink() }, "Link the connected wallet instead") : null,
    );
  } else {
    replace(linkBox,
      h("p", { class: "muted small-text" }, h("strong", null, "Skip the post. "), "Link your wallet once and first claims on any campaign need no post."),
      h("button", { class: "btn ghost small", type: "button", onclick: () => void startLink() }, "Link a wallet"),
    );
  }
}

async function refreshLink(did: string): Promise<void> {
  const found = await currentEpoch().then((epoch) => readLink(did, epoch)).catch(() => null);
  if (actor?.did !== did) return;
  myLink = found;
  drawLink();
}

function closeLink(): void {
  linkFlow = null;
  linkRecheck = null;
  drawLink();
}

async function startLink(): Promise<void> {
  const box = h("div", { class: "qlinkflow" });
  linkFlow = box;
  linkRecheck = null;
  const say = (text: string, cls = "muted small-text") => h("p", { class: cls, style: "margin:0" }, text);
  const notNow = () => h("button", { class: "linkbtn", type: "button", onclick: closeLink }, "Not now");
  drawLink();
  linkBox.scrollIntoView({ block: "nearest" });

  const w0 = walletState();
  if (!w0.available) {
    replace(box, say("You need the Sapient wallet to link one."), h("div", { class: "row" }, h("a", { class: "btn small ghost", href: "https://sapient.tari.mw", target: "_blank", rel: "noopener noreferrer" }, "Get Sapient"), notNow()));
    return;
  }
  try {
    if (!w0.connected || !w0.key || !w0.account) await connectWallet();
  } catch (e) {
    replace(box, say(friendly(e), "fielderr"), notNow());
    return;
  }
  const w = walletState();
  if (w.network && w.network !== "esmeralda") {
    replace(box, say(`Your wallet is on ${w.network}. Switch it to Esmeralda, then try again.`, "fielderr"), notNow());
    return;
  }
  if (!actor || !w.key || !w.account) {
    closeLink();
    return;
  }
  const did = actor.did;
  const key = w.key;
  const account = w.account;
  let shown = false;
  const check = async (quiet = false, pressed = false): Promise<void> => {
    if (linkFlow !== box || actor?.did !== did) return;
    if (!quiet) replace(box, say("Checking for your post…"));
    try {
      const plan = await planLink(did, key, account, DEPLOYMENT.linkRegistry);
      if (linkFlow !== box) return;
      if (plan.kind === "post") {
        linkRecheck = () => void check(true);
        if (quiet && shown) return;
        if (!shown) postAskedAt = Date.now();
        shown = true;
        replace(box,
          h("p", { class: "small-text", style: "margin:0" }, h("strong", null, "Post this to link your wallet. "), `It proves this Bluesky account chose ${shortAddress(account)}. The network fee is about ${fromMicro(LINK_FEE)} ${unit}.`),
          h("pre", { style: "white-space:pre-wrap;word-break:break-all;margin:0" }, plan.text),
          h("div", { class: "row" },
            h("a", { class: "btn small ghost", href: composeUrl(plan.text), target: "_blank", rel: "noopener noreferrer" }, "Post on Bluesky"),
            copyButton(() => plan.text),
            h("button", { class: "btn small primary", type: "button", onclick: () => void check(false, true) }, "I've posted it"),
            notNow(),
          ),
          pressed ? say("That post isn't showing yet. It has to come from this account and include the whole code. It can take a few seconds, and this page keeps looking.", "fielderr") : null,
          say("The link is public: anyone can see which wallet this account chose. Repeat campaigns still ask for a post from round two on. You can delete this post once it's linked."),
        );
        return;
      }
      linkRecheck = null;
      const status = say("");
      const go = h("button", { class: "btn small primary", type: "button" }, "Link this wallet");
      go.addEventListener("click", async () => {
        go.disabled = true;
        status.className = "muted small-text";
        try {
          status.textContent = "Checking it will work…";
          await dryRunInstructions(plan.instructions, LINK_MAX_FEE, plan.inputs);
          await sendAndConfirm(plan.instructions, plan.inputs, status);
          celebrate(go);
          closeLink();
          toast("Wallet linked. First claims no longer need a post.");
          panels.clear();
          panelStage.clear();
          rechecks.clear();
          await refreshLink(did);
          void checkAll();
        } catch (e) {
          status.className = "fielderr";
          status.textContent = explainChainError(friendly(e));
          go.disabled = false;
        }
      });
      replace(box, say("Your post is there. Last step:"), h("div", { class: "row" }, go, notNow()), status);
    } catch (e) {
      if (quiet) return;
      replace(box, say(explainChainError(friendly(e)), "fielderr"), h("div", { class: "row" }, h("button", { class: "btn small ghost", type: "button", onclick: () => void check() }, "Try again"), notNow()));
    }
  };
  await check();
}

// ---- collecting several at once --------------------------------------------------------------------------------

/** Live campaigns that can be collected now, biggest first. */
function readyLive(list: Tracked[]): Tracked[] {
  return list
    .filter((t) => assessments.get(t.id)?.state === "ready" && liveData.has(t.id))
    .sort((x, y) => Number((assessments.get(y.id)?.perRound ?? 0n) - (assessments.get(x.id)?.perRound ?? 0n)));
}

function closeBatch(): void {
  batchFlow = null;
  batchRecheck = null;
  draw();
}

function batchBox(list: Tracked[]): HTMLElement | null {
  if (batchFlow) return batchFlow;
  const ready = readyLive(list);
  if (ready.length < 2) return null;
  const some = ready.slice(0, BATCH_MAX);
  const sum = some.reduce((n, t) => n + (assessments.get(t.id)?.perRound ?? 0n), 0n);
  return h("div", { class: "qbatch" },
    h("button", { class: "btn primary", type: "button", onclick: () => void startBatch() }, `Collect ${some.length} together: ${fromMicro(sum)} ${unit}`),
    h("p", { class: "muted small-text" }, ready.length > BATCH_MAX ? `One wallet approval for your ${BATCH_MAX} biggest. Do it again for the rest.` : "One wallet approval, instead of one for each."),
  );
}

async function startBatch(): Promise<void> {
  const box = h("div", { class: "qbatch qlinkflow" });
  batchFlow = box;
  batchRecheck = null;
  draw();
  const say = (text: string, cls = "muted small-text") => h("p", { class: cls, style: "margin:0" }, text);
  const notNow = () => h("button", { class: "linkbtn", type: "button", onclick: closeBatch }, "Not now");

  const w0 = walletState();
  if (!w0.available) {
    replace(box, say("You need the Sapient wallet to collect."), h("div", { class: "row" }, h("a", { class: "btn small ghost", href: "https://sapient.tari.mw", target: "_blank", rel: "noopener noreferrer" }, "Get Sapient"), notNow()));
    return;
  }
  try {
    if (!w0.connected || !w0.key || !w0.account) await connectWallet();
  } catch (e) {
    replace(box, say(friendly(e), "fielderr"), notNow());
    return;
  }
  const w = walletState();
  if (w.network && w.network !== "esmeralda") {
    replace(box, say(`Your wallet is on ${w.network}. Switch it to Esmeralda, then try again.`, "fielderr"), notNow());
    return;
  }
  if (!actor || !w.key || !w.account) {
    closeBatch();
    return;
  }
  const did = actor.did;
  const key = w.key;
  const account = w.account;
  const chosen = readyLive(loadTracked()).slice(0, BATCH_MAX);

  let shownText = "";
  const check = async (quiet = false, pressed = false): Promise<void> => {
    if (batchFlow !== box || actor?.did !== did) return;
    if (!quiet) replace(box, say(`Checking ${chosen.length} campaigns…`));
    try {
      const planned = await Promise.all(chosen.map(async (t) => {
        const c = await readCampaign(t.spec.component!);
        return { t, c, plan: await planClaim(c, did, key, account, { allocations: t.spec.allocations, ref: refFor(t.id) }) };
      }));
      if (batchFlow !== box) return;
      const posts = planned.flatMap((x) => (x.plan.kind === "post" ? [x.plan.code] : []));
      if (posts.length) {
        const text = batchPostText(posts);
        batchRecheck = () => void check(true);
        if (quiet && shownText === text) return;
        if (shownText !== text) postAskedAt = Date.now();
        shownText = text;
        replace(box,
          h("p", { class: "small-text", style: "margin:0" }, h("strong", null, `One post covers ${posts.length === 1 ? "this campaign" : `these ${posts.length} campaigns`}. `), "It proves this Bluesky account chose your wallet, so nobody else can redirect the rewards."),
          h("pre", { style: "white-space:pre-wrap;overflow-wrap:anywhere;margin:0" }, text),
          h("div", { class: "row" },
            h("a", { class: "btn small ghost", href: composeUrl(text), target: "_blank", rel: "noopener noreferrer" }, "Post on Bluesky"),
            copyButton(() => text),
            h("button", { class: "btn small primary", type: "button", onclick: () => void check(false, true) }, "I've posted it"),
            notNow(),
          ),
          pressed ? say("That post isn't showing yet. It has to come from this account and include every code. It can take a few seconds, and this page keeps looking.", "fielderr") : null,
          say("This page checks for it by itself. You can delete the post after you've collected."),
        );
        return;
      }
      batchRecheck = null;
      const ready = planned.filter((x): x is typeof x & { plan: ReadyPlan } => x.plan.kind === "ready");
      if (!ready.length) {
        closeBatch();
        toast("Those campaigns changed. Your list has been refreshed.");
        void checkAll();
        return;
      }
      const merged = mergePlans(ready.map((x) => x.plan));
      const fee = ready.reduce((n, x) => n + claimFee(x.c.rules) - (x.plan.linked ? LINKED_CLAIM_SAVING : 0n), 0n);
      const status = say("");
      const go = h("button", { class: "btn small primary", type: "button" }, `Collect ${fromMicro(merged.amount)} ${unit}`);
      go.addEventListener("click", async () => {
        go.disabled = true;
        status.className = "muted small-text";
        try {
          status.textContent = "Checking it will work…";
          try {
            await dryRunInstructions(merged.instructions, CLAIM_MAX_FEE, merged.inputs);
          } catch (e) {
            // Nothing was spent. Each campaign still has its own button, which also handles an invite going stale.
            status.className = "fielderr";
            status.textContent = `These can't all go through together: ${explainChainError(friendly(e))} Nothing was spent. You can collect them one at a time below.`;
            return;
          }
          await sendAndConfirm(merged.instructions, merged.inputs, status);
          celebrate(go);
          panels.clear();
          panelStage.clear();
          rechecks.clear();
          batchFlow = null;
          toast(`Collected ${fromMicro(merged.amount)} ${unit} from ${ready.length} campaigns.`);
          void checkAll();
        } catch (e) {
          status.className = "fielderr";
          status.textContent = explainChainError(friendly(e));
          go.disabled = false;
        }
      });
      replace(box,
        h("ul", { class: "qbatchlist" }, ready.map((x) => h("li", null, `${x.c.name}: ${fromMicro(x.plan.amount)} ${unit}`, x.plan.account !== account ? h("small", { class: "muted" }, `, paid to ${shortAddress(x.plan.account)}`) : null))),
        h("div", { class: "row" }, go, notNow()),
        say(`Your wallet pays a network fee of about ${fromMicro(fee)} ${unit} in total. Only the real cost is charged.`),
        status,
      );
    } catch (e) {
      if (quiet) return;
      replace(box, say(explainChainError(friendly(e)), "fielderr"), h("div", { class: "row" }, h("button", { class: "btn small ghost", type: "button", onclick: () => void check() }, "Try again"), notNow()));
    }
  };
  await check();
}

/** What this account has been paid, as the chain's events have it. */
function historyBox(list: Tracked[]): HTMLElement | null {
  if (!payments.length) return null;
  const nameOf = (component: string): string => list.find((t) => t.id === component)?.spec.name ?? shortAddress(component);
  return h("details", { class: "qhist" },
    h("summary", null, "Your payments", h("span", { class: "qcount" }, String(payments.length))),
    h("ul", null, payments.map((x) => h("li", null,
      h("strong", null, `${fromMicro(x.amount)} ${unit}`), ` from ${nameOf(x.component)}`, x.round > 0 ? `, round ${x.round + 1}` : "", " · ",
      h("a", { href: `${EXPLORER}/tx/${x.tx}`, target: "_blank", rel: "noopener noreferrer" }, "See transaction"),
    ))),
    h("p", { class: "muted small-text" }, "From recent network history, so very old payments may not appear."),
  );
}

function section(title: string, note: string, items: HTMLElement[], before: HTMLElement | null = null): HTMLElement | null {
  if (!items.length) return null;
  return h("section", { class: "qsection" }, h("h2", null, title, h("span", { class: "qcount" }, String(items.length))), h("p", { class: "muted small-text" }, note), before, h("div", { class: "questgrid" }, items));
}

/** Finished campaigns stay out of the way once there's something else to look at. */
function finishedSection(items: HTMLElement[], others: boolean): HTMLElement | null {
  if (!items.length) return null;
  if (!others) return section("Finished", "Nothing more to collect from these.", items);
  return h("details", { class: "qsection qdone" }, h("summary", null, "Finished", h("span", { class: "qcount" }, String(items.length))), h("div", { class: "questgrid" }, items));
}

/** The campaign someone followed a link to, before they've said who they are. */
function drawArrival(list: Tracked[]): void {
  const t = arrived && !actor ? list.find((x) => x.id === arrived) : null;
  if (!t) {
    replace(arrivalBox);
    return;
  }
  const live = liveData.get(t.id);
  const named = t.spec.name && t.spec.name !== LIVE_PLACEHOLDER;
  replace(arrivalBox, h("div", { class: "qarrive" },
    h("h2", null, named ? t.spec.name : "Reading this campaign…"),
    named ? h("p", { class: "questreward" }, t.spec.root ? "See if you're on its list" : `${fromMicro(t.spec.reward)} ${unit}`, t.spec.rounds > 1 ? h("small", { class: "muted" }, ` per round, ${t.spec.rounds} rounds`) : null) : null,
    live ? deadlineLine(live.c, live.c.reward) : null,
    h("p", { class: "small-text", style: "margin:0" }, live?.inviter ? "You were invited. " : "", "Enter your Bluesky handle to see where you stand. No sign-in, and no wallet until you collect."),
  ));
}

function draw(): void {
  const list = loadTracked();
  drawArrival(list);
  if (!list.length) {
    replace(summary);
    replace(board, h("div", { class: "qempty" },
      h("div", { class: "qemptyart", "aria-hidden": "true" }, parachute(74)),
      h("h2", null, "No quests yet"),
      h("p", { class: "muted" }, "Pick an open campaign below, or open a link someone shared. It'll appear here with what you've done and what's left. Your list stays in this browser."),
      h("div", { class: "row", style: "justify-content:center" }, h("button", { class: "btn ghost small", type: "button", onclick: () => void addExample() }, "Try a pretend example")),
    ));
    drawOpen();
    return;
  }
  const seen = list.map((t) => assessments.get(t.id));
  const known = seen.filter((a): a is Assessment => !!a);
  const readySum = actor ? totals(known) : null;
  document.title = readySum?.readyCount ? `${fromMicro(readySum.readyNow)} ${unit} ready · Skydrop` : "My quests · Skydrop";
  if (known.length && actor) {
    const t = totals(known);
    const bonuses = list.reduce((n, x) => {
      const l = liveData.get(x.id);
      return n + (l?.receipt ? l.c.bonus * BigInt(l.receipt.referrals) : 0n);
    }, 0n);
    replace(summary,
      t.readyCount
        ? h("div", { class: "qtile big" }, h("span", null, "Ready to claim"), h("strong", null, `${fromMicro(t.readyNow)} ${unit}`), h("small", null, `${t.readyCount} campaign${t.readyCount === 1 ? "" : "s"}`))
        : h("div", { class: "qtile" }, h("span", null, "Ready to claim"), h("strong", null, "Nothing yet"), h("small", null, t.progressCount ? "Finish the steps below" : t.collected > 0n ? "Add another campaign" : "Add a campaign to start")),
      h("div", { class: "qtile" }, h("span", null, "Still to earn"), h("strong", null, `${fromMicro(t.toEarn)} ${unit}`), h("small", null, `${t.progressCount} in progress`)),
      t.collected > 0n
        ? h("div", { class: "qtile" }, h("span", null, "Collected"), h("strong", null, `${fromMicro(t.collected + bonuses)} ${unit}`), h("small", null, bonuses > 0n ? "including invite bonuses" : "paid to your wallet"))
        : h("div", { class: "qtile" }, h("span", null, "Tracking"), h("strong", null, String(list.length)), h("small", null, t.blockedCount ? `${t.blockedCount} you can't complete yourself` : list.length === 1 ? "campaign" : "campaigns")),
    );
    for (const figure of summary.querySelectorAll<HTMLElement>(".qtile strong")) countUp(figure, figure.previousElementSibling?.textContent ?? "");
  } else {
    replace(summary);
  }
  // Whatever closes first comes first.
  const closes = (t: Tracked): number => liveData.get(t.id)?.c.closeEpoch ?? Number.MAX_SAFE_INTEGER;
  const cards = (state: string[]) => list.filter((t) => state.includes(assessments.get(t.id)?.state ?? "new")).sort((x, y) => closes(x) - closes(y)).map((t) => questCard(t, assessments.get(t.id)));
  const active = list.some((t) => !["claimed", "over"].includes(assessments.get(t.id)?.state ?? "new"));
  replace(board,
    section("Ready to claim", "You've done every step.", cards(["ready"]), batchBox(list)),
    section("In progress", "Here's what's left. Do them on Bluesky, and this page checks again when you come back.", cards(["progress", "unknown"])),
    section("Coming up", "Nothing to do until these open.", cards(["waiting"])),
    section("Needs someone else", "These depend on a list or a voucher, so you can't complete them yourself.", cards(["blocked"])),
    finishedSection(cards(["claimed", "over"]), active),
    section(actor ? "Not checked yet" : "Your campaigns", actor ? "Checking your Bluesky records…" : "Enter your handle above to see where you stand.", cards(["new"])),
    historyBox(list),
  );
  drawOpen();
  focusArrived();
}

/** Once the campaign someone came for has its answer, takes them to it. */
function focusArrived(): void {
  if (!pendingFocus || !actor || !assessments.has(pendingFocus)) return;
  const id = pendingFocus;
  pendingFocus = null;
  flashId = id;
  const el = document.getElementById(`quest-${id}`);
  el?.classList.add("qflash");
  el?.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  window.setTimeout(() => {
    flashId = null;
    document.getElementById(`quest-${id}`)?.classList.remove("qflash");
  }, 3500);
}

// ---- finding campaigns --------------------------------------------------------------------------------------

/** Open campaigns made with this contract, read back from the chain. Those paying a list only show to accounts on it. */
async function loadOpen(): Promise<void> {
  try {
    openCampaigns = (await listCampaigns()).filter((c) => !c.legacy && phaseOf(c) !== "closed" && (c.root ? c.balance > 0n : c.balance >= c.reward && c.reward > 0n));
  } catch {
    openCampaigns = [];
  }
  drawOpen();
  if (actor && !checking) void checkOpen(actor);
}

/**
 * Works out where this account stands in every open campaign, so nobody has to add one to find out. Any it already
 * qualifies for, and that would leave it better off after the fee, go straight onto its list. Removing one keeps it off.
 */
async function checkOpen(forActor: Actor): Promise<void> {
  if (!openCampaigns) return;
  const me = await identity(forActor.did);
  const hidden = new Set(store.get<string[]>(HIDDEN, []));
  const tracked = new Set(loadTracked().map((t) => t.id));
  const todo = openCampaigns.filter((c) => !tracked.has(c.component));
  await inPool(todo, 3, async (c) => {
    let allocations: Spec["allocations"];
    if (c.root) {
      allocations = (await fetchList(c.root)) ?? undefined;
      if (!allocations?.some((x) => x.did === forActor.did)) return;
    }
    const results = await Promise.all(c.rules.map((r) => cachedRule(r, me)));
    if (actor !== forActor) return;
    openStand.set(c.component, assess(specOf(c, allocations), forActor.did, results.map((r) => ({ status: r.status, detail: r.detail }))));
  });
  if (actor !== forActor) return;
  const qualifies = todo.filter((c) => {
    const a = openStand.get(c.component);
    return a?.state === "ready" && !hidden.has(c.component) && afterFee(a.perRound, c.rules) !== null;
  });
  for (const c of qualifies) trackFromText(encodeLive(c.component));
  if (qualifies.length) {
    toast(qualifies.length === 1 ? `You already qualify for “${qualifies[0]!.name}”. It's been added.` : `You already qualify for ${qualifies.length} open campaigns. They've been added.`);
    void checkAll();
  } else {
    drawOpen();
  }
}

function openCard(c: ChainCampaign): HTMLElement {
  const add = h("button", { class: "btn small primary", type: "button" }, "Add to my quests");
  add.addEventListener("click", () => {
    const r = trackFromText(encodeLive(c.component));
    if (r.ok) toast(`Added “${c.name}”.`);
    draw();
    void (actor ? checkAll() : readLiveTerms());
  });
  const stand = openStand.get(c.component);
  const pay = stand?.perRound || c.reward;
  const lit = stand ? stand.steps.map((x) => x.status === "met") : [];
  return h("article", { class: "qopen" },
    h("div", { class: "qopenart" }, questArt(c.name, c.rules, lit)),
    h("div", { class: "qopenbody" },
    h("h3", null, c.name),
    c.root ? h("span", { class: "pill ok" }, "You're on its list") : stand?.state === "ready" ? h("span", { class: "pill ok" }, "You qualify") : stand && stand.done > 0 ? h("span", { class: "pill info" }, `${stand.done} of ${stand.total} steps done`) : null,
    h("p", { class: "questreward" }, `${fromMicro(pay)} ${unit}`, c.rounds > 1 ? h("small", { class: "muted" }, ` per round, ${c.rounds} rounds`) : null, c.bonus > 0n && c.maxReferrals > 0 ? h("small", { class: "muted" }, ` +${fromMicro(c.bonus)} per invite`) : null),
    c.rules.length ? ruleChips(c.rules, (r) => RULES[r.kind]!.name) : null,
    h("p", { class: "muted small-text" }, c.rules.length ? `${summarize(c.rules)[0]!.toUpperCase()}${summarize(c.rules).slice(1)}.` : ""),
    feeLine(pay, c.rules),
    deadlineLine(c, pay),
    poolBar(c.paid, c.balance, unit, once(`pool|${c.component}`)),
    h("p", { class: "muted small-text" }, `${c.claimants.toLocaleString("en-US")} claimed · ${fromMicro(c.balance)} ${unit} left · `, h("a", { href: `${CREATOR}/c/${c.component}`, target: "_blank", rel: "noopener" }, "Details")),
    add,
    ),
  );
}

type OpenSort = "best" | "reward" | "closing";
const OPEN_SORTS: [OpenSort, string][] = [["best", "Best for you"], ["reward", "Biggest reward"], ["closing", "Closing soon"]];
let openSort: OpenSort = "best";

function drawOpen(): void {
  if (openCampaigns === null) {
    replace(openBox, h("section", { class: "qsection" }, h("h2", null, "Open campaigns"), h("p", { class: "muted small-text" }, "Reading the network…"), skeleton(2, "skel qskel")));
    return;
  }
  const tracked = new Set(loadTracked().map((t) => t.id));
  // A campaign paying a list only shows to someone on it. Otherwise: nearest to done, then the most left after the fee.
  const score = (c: ChainCampaign): number => {
    const a = openStand.get(c.component);
    return a && a.total ? a.done / a.total : 0;
  };
  const net = (c: ChainCampaign): bigint => afterFee(openStand.get(c.component)?.perRound || c.reward, c.rules) ?? 0n;
  const fresh = openCampaigns
    .filter((c) => !tracked.has(c.component) && (!c.root || openStand.has(c.component)))
    .sort((x, y) => {
      if (openSort === "closing") return x.closeEpoch - y.closeEpoch;
      const byNet = net(y) > net(x) ? 1 : net(y) < net(x) ? -1 : 0;
      return openSort === "reward" ? byNet : score(y) - score(x) || byNet;
    });
  replace(openBox, fresh.length
    ? h("section", { class: "qsection" },
        h("h2", null, "Open campaigns", h("span", { class: "qcount" }, String(fresh.length))),
        h("p", { class: "muted small-text" }, "Anyone can create a campaign and nobody has vetted these. Their rewards and rules are real; check a post before you engage with it."),
        fresh.length > 2 ? h("div", { class: "chips qsort", role: "group", "aria-label": "Sort open campaigns" }, OPEN_SORTS.map(([id, label]) => h("button", { class: "chip", type: "button", "aria-pressed": String(openSort === id), onclick: () => { openSort = id; drawOpen(); } }, label))) : null,
        h("div", { class: "questgrid" }, fresh.map(openCard)))
    : null);
}

/** Adds campaigns this account has already been paid by, so they show up on any device. */
async function findMine(did: string): Promise<void> {
  const hidden = new Set(store.get<string[]>(HIDDEN, []));
  const known = new Set(loadTracked().map((t) => t.id));
  const claims = await listMyClaims(did).catch(() => null);
  if (actor?.did !== did) return;
  if (claims) payments = claims;
  const found = [...new Set((claims ?? []).map((c) => c.component))].filter((c) => !known.has(c) && !hidden.has(c));
  if (!found.length) return;
  for (const c of found) trackFromText(encodeLive(c));
  toast(`Found ${found.length} campaign${found.length === 1 ? "" : "s"} you've collected from.`);
}

/** Puts what each step points at into words, so people can see what they're being asked to engage with. */
async function describeTargets(): Promise<void> {
  const rules = loadTracked().flatMap((t) => t.spec.rules);
  const posts = [...new Set(rules.filter((r) => RULES[r.kind]?.input === "post").map((r) => r.target))].filter((x) => !targetInfo.has(x));
  const inviters = [...liveData.values()].map((l) => l.inviter).filter((x): x is string => !!x);
  const people = [...new Set([...rules.filter((r) => RULES[r.kind]?.input === "did").map((r) => r.target), ...inviters])].filter((x) => !targetInfo.has(x));
  await Promise.all([
    ...posts.map(async (uri) => {
      const p = await fetchPost(uri).catch(() => null);
      if (p) targetInfo.set(uri, `@${p.handle}: “${p.text.length > 90 ? `${p.text.slice(0, 90)}…` : p.text}”`);
    }),
    ...people.map(async (did) => {
      const a = await resolveActor(did).catch(() => null);
      if (a) targetInfo.set(did, `@${a.handle}`);
    }),
  ]);
}

async function addExample(): Promise<void> {
  const list = loadTracked();
  const post = await latestPost("bsky.app");
  const who2 = await resolveActor("bsky.app");
  const rules: Rule[] = post ? [{ kind: 0, target: post.uri }, { kind: 2, target: who2.did }] : [{ kind: 2, target: who2.did }];
  const spec: Spec = { v: 1, name: "Example quest", about: "A pretend campaign to show how this works. Nothing is paid.", rules, reward: "1000000", budget: "100000000", rounds: 1, roundDays: 7, bonus: "0", maxReferrals: 0, startsInDays: 0, days: 14 };
  list.unshift({ id: `example-${Date.now()}`, spec, added: Date.now(), example: true });
  store.set(QKEY, list);
  draw();
  if (actor) await checkAll();
}

/** Replaces a live campaign's terms with what its contract says. The link only ever named the address. */
async function refreshLive(t: Tracked, did: string | null): Promise<{ c: ChainCampaign; receipt: Receipt | null; inviter: string | null } | null> {
  try {
    const c = await readCampaign(t.spec.component!);
    // A list that doesn't match the contract is no use to anyone, wherever it came from.
    if (c.root && !(await listMatches(t.spec.allocations, c.root))) t.spec.allocations = (await fetchList(c.root)) ?? undefined;
    const receipt = did ? await readReceipt(c, did) : null;
    // An invite only shows if it would really pay, so nobody is told someone earns a bonus when they won't.
    const named = receipt ? null : refFor(t.id);
    const inviter = named ? ((await usableReferrer(c, did ?? "", named, c.reward))?.did ?? null) : null;
    liveData.set(t.id, { c, receipt, inviter });
    liveErrors.delete(t.id);
    t.spec = specOf(c, t.spec.allocations);
    store.set(QKEY, loadTracked().map((x) => (x.id === t.id ? t : x)));
    return { c, receipt, inviter };
  } catch (e) {
    liveData.delete(t.id);
    liveErrors.set(t.id, `This campaign couldn't be read from the network: ${(e as Error).message}`);
    return null;
  }
}

async function checkAll(): Promise<void> {
  if (!actor) return;
  if (checking) {
    checkAgain = true;
    return;
  }
  checking = true;
  document.body.classList.add("busy");
  go.textContent = "Checking…";
  try {
    const checkingFor = actor;
    void refreshLink(checkingFor.did);
    await findMine(checkingFor.did);
    const me = await identity(checkingFor.did);
    ruleChecks.clear();
    await inPool(loadTracked(), 4, async (t) => {
      if (actor !== checkingFor) {
        checkAgain = !!actor;
        return;
      }
      const live = t.spec.component ? await refreshLive(t, checkingFor.did) : null;
      // Without the contract there are no trustworthy terms to check against.
      if (t.spec.component && !live) {
        assessments.delete(t.id);
        draw();
        return;
      }
      const spec = t.spec;
      const results = await Promise.all(spec.rules.map((r) => cachedRule(r, me)));
      if (actor !== checkingFor) {
        checkAgain = !!actor;
        return;
      }
      let a = assess(spec, checkingFor.did, results.map((r) => ({ status: r.status, detail: r.detail })));
      if (live) {
        const { c, receipt } = live;
        const phase = phaseOf(c);
        const roundsPaid = receipt?.roundsPaid ?? 0;
        const waitEpochs = waitFor(c, receipt);
        a = settle(a, { roundsPaid, rounds: c.rounds, phase, waitEpochs, waitText: approxTime(waitEpochs), funded: a.perRound === 0n || c.balance >= a.perRound, closesIn: Math.max(0, c.closeEpoch - c.epoch), roundEpochs: c.roundEpochs, pool: c.balance });
        // Its contract no longer loads, so nothing about it can be collected, however its steps stand.
        if (c.legacy && a.state !== "claimed") a = { ...a, state: "over", headline: "This campaign was made before the Ootle 0.50 network upgrade. Its contract no longer runs, so it can't pay out." };
      }
      assessments.set(t.id, a);
      draw();
    });
    await describeTargets();
    if (actor === checkingFor) await checkOpen(checkingFor);
    lastCheck = Date.now();
  } catch (e) {
    replace(who, h("p", { class: "fielderr" }, (e as Error).message));
  } finally {
    checking = false;
    document.body.classList.remove("busy");
    go.textContent = "Refresh";
    draw();
    if (checkAgain) {
      checkAgain = false;
      void checkAll();
    }
  }
}

function forgetHandle(): void {
  handleSearch++;
  actor = null;
  store.set(HKEY, "");
  handleInput.value = "";
  go.textContent = "Show my quests";
  lede.textContent = LEDE;
  myLink = null;
  linkFlow = null;
  linkRecheck = null;
  drawLink();
  assessments.clear();
  openStand.clear();
  payments = [];
  batchFlow = null;
  batchRecheck = null;
  panels.clear();
  panelStage.clear();
  rechecks.clear();
  replace(who);
  draw();
  handleInput.focus();
}

async function useHandle(text: string): Promise<void> {
  if (!text.trim()) {
    handleInput.focus();
    return;
  }
  replace(who);
  const mine = ++handleSearch;
  try {
    const found = await resolveActor(text);
    if (mine !== handleSearch) return;
    actor = found;
  } catch (e) {
    if (mine !== handleSearch) return;
    actor = null;
    assessments.clear();
    panels.clear();
    panelStage.clear();
    rechecks.clear();
    replace(who, h("p", { class: "fielderr" }, (e as Error).message));
    draw();
    return;
  }
  store.set(HKEY, actor.handle);
  handleInput.value = actor.handle;
  myLink = null;
  linkFlow = null;
  linkRecheck = null;
  drawLink();
  assessments.clear();
  openStand.clear();
  payments = [];
  batchFlow = null;
  batchRecheck = null;
  panels.clear();
  panelStage.clear();
  rechecks.clear();
  lede.textContent = "Here's where you stand. Each step is checked against your own signed Bluesky data, right here in your browser.";
  replace(who, actor.avatar ? h("img", { src: actor.avatar, alt: "", width: "40", height: "40", referrerpolicy: "no-referrer" }) : null, h("div", null, h("strong", null, actor.displayName), h("div", { class: "muted small-text" }, `@${actor.handle}`)), h("button", { class: "linkbtn", type: "button", onclick: forgetHandle }, "Not you?"));
  draw();
  await checkAll();
}

// ---- page -------------------------------------------------------------------------------------------------
function languagePicker(): HTMLElement {
  const lang = currentLang();
  const pick = h("select", { "aria-label": "Language" }, h("option", { value: "en", selected: lang === "en" }, "English"), h("option", { value: "zh", selected: lang === "zh" }, "中文"));
  pick.addEventListener("change", () => setLang(pick.value as "en" | "zh"));
  return pick;
}

/** The same choice the home page's menu makes, under the same key. */
function themePicker(): HTMLElement {
  const KEY = "skydrop.theme";
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch {
    /* storage can be blocked */
  }
  const mode = saved === "light" || saved === "dark" ? saved : "auto";
  const pick = h("select", { "aria-label": "Theme" }, ["auto", "light", "dark"].map((m) => h("option", { value: m, selected: m === mode }, m === "auto" ? "Auto" : m === "light" ? "Light" : "Dark")));
  pick.addEventListener("change", () => {
    try {
      if (pick.value === "auto") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, pick.value);
    } catch {
      /* the choice just lasts this visit */
    }
    if (pick.value === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = pick.value;
  });
  return pick;
}

const chip = h("div", { class: "walletchip" });
onWallet((w) => {
  drawLink();
  if (w.connected) replace(chip, h("span", { class: "chipbtn on", title: w.address ?? "" }, h("span", { class: "dot2", "aria-hidden": "true" }), shortAddress(w.address ?? w.account ?? "").slice(0, 16)));
  else if (w.available) replace(chip, h("button", { class: "chipbtn", type: "button", onclick: async () => { try { await connectWallet(); } catch (e) { replace(who, h("p", { class: "fielderr" }, friendly(e))); } } }, `Connect ${w.name}`));
  else replace(chip);
});
void silentConnect();

// Someone typing a different handle isn't refreshing.
handleInput.addEventListener("input", () => {
  if (!checking) go.textContent = actor && handleInput.value.trim().replace(/^@/, "").toLowerCase() === actor.handle.toLowerCase() ? "Refresh" : "Show my quests";
});
const form = h("form", { class: "row qform" }, h("div", { style: "flex:1;min-width:210px" }, handleInput), go);
attachSuggest(handleInput, (handle) => void useHandle(handle));
form.addEventListener("submit", (e) => {
  e.preventDefault();
  void useHandle(handleInput.value);
});

const addInput = h("input", { placeholder: "Paste a campaign link", "aria-label": "Campaign link", spellcheck: "false", autocomplete: "off" });
const addForm = h("form", { class: "row" }, h("div", { style: "flex:1;min-width:210px" }, addInput), h("button", { class: "btn ghost", type: "submit" }, "Add"));
addForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const r = trackFromText(addInput.value);
  addMsg.textContent = r.ok ? addedText(r) : r.error;
  if (r.ok) {
    addInput.value = "";
    draw();
    void checkAll();
  }
});

append(document.getElementById("app")!, [
  h("div", { class: "airmail", "aria-hidden": "true" }),
  h("a", { class: "skip", href: "#qmain" }, "Skip to content"),
  h("header", { class: "top" }, h("div", { class: "wrap bar" },
    h("a", { class: "brand", href: "/" }, h("span", { class: "logo" }, icons.drop(20)), h("span", { class: "brand-name" }, "Skydrop")),
    h("nav", { class: "links qnav", "aria-label": "Main" }, h("a", { href: "/quests", "aria-current": "page" }, "My quests"), h("a", { href: "/#/how" }, "How it works"), h("a", { href: CREATOR, target: "_blank", rel: "noopener" }, "Create a campaign")),
    chip,
  )),
  h("main", { class: "wrap qmain", id: "qmain", tabindex: "-1" },
    h("div", { class: "qsky", "aria-hidden": "true" }, h("i", { class: "cloud c1" }), h("i", { class: "cloud c2" }), h("i", { class: "cloud c3" }), h("div", { class: "qdrop" }, parachute(112))),
    h("span", { class: "kicker" }, "My quests"),
    h("h1", null, "What you've earned, and what's left"),
    lede,
    arrivalBox,
    form,
    who,
    linkBox,
    summary,
    board,
    openBox,
    h("section", { class: "qadd" }, h("h2", null, "Have a link?"), addForm, addMsg),
    !isPublished()
      ? h("div", { class: "note warn" }, h("strong", null, "Testnet preview. "), `${contractsOnNetwork() ? `The campaign contract is on ${DEPLOYMENT.network}, but funding and claiming from these sites is still being built.` : `The campaign contract isn't published on ${DEPLOYMENT.network} yet.`} Campaigns here are previews with no funds behind them, so nothing can be collected.`)
      : h("div", { class: "note warn" }, h("strong", null, "Testnet only. "), `Rewards here are ${unit} on the ${DEPLOYMENT.network}, with no real value. The contracts haven't had an outside audit. Anyone can create a campaign, so judge what it asks you to do yourself.`),
  ),
  h("footer", { class: "qfoot wrap" },
    h("a", { href: "/#/how" }, "How it works"),
    h("a", { href: CREATOR, target: "_blank", rel: "noopener" }, "Create a campaign"),
    languagePicker(),
    themePicker(),
    h("span", null, "Tari testnet: tTARI has no monetary value."),
  ),
  toastBox,
]);
if (currentLang() === "zh") startChinese();
initMotion(document.getElementById("app")!);

// A link like /quests#add=<campaign> adds it, then leaves the hash clean. It can also arrive while the page is open.
function addFromHash(): boolean {
  if (!location.hash.startsWith("#add=")) return false;
  const r = trackFromText(location.hash.slice(5));
  if (r.ok) {
    if (actor || store.get(HKEY, "")) toast(addedText(r));
    arrived = r.id;
    pendingFocus = r.id;
  } else addMsg.textContent = r.error;
  history.replaceState(null, "", location.pathname);
  if (r.ok && !handleInput.value) handleInput.focus();
  if (r.ok && !actor) void readLiveTerms();
  return r.ok;
}
addEventListener("hashchange", () => {
  if (addFromHash()) {
    draw();
    void checkAll();
  }
});
/** Shows what each live campaign's contract says, before any handle is entered. */
async function readLiveTerms(): Promise<void> {
  for (const t of loadTracked()) {
    if (t.spec.component) {
      await refreshLive(t, null);
      if (!actor) draw();
    }
  }
}

/** Back from Bluesky: check again, so nobody has to press anything. */
function onReturn(): void {
  if (document.visibilityState !== "visible" || !actor || checking || Date.now() - lastCheck < 8000) return;
  void checkAll();
  rechecks.forEach((again) => again());
  linkRecheck?.();
  batchRecheck?.();
}
// While a post is being waited for, keep looking: someone may have posted from their phone with this tab still in view.
window.setInterval(() => {
  if (document.visibilityState !== "visible" || Date.now() - postAskedAt > 15 * 60_000) return;
  rechecks.forEach((again) => again());
  linkRecheck?.();
  batchRecheck?.();
}, 30_000);
addEventListener("visibilitychange", onReturn);
addEventListener("focus", onReturn);

addFromHash();
// The home page's form hands the handle over in the address.
const fromHome = new URLSearchParams(location.search).get("handle");
if (fromHome) {
  handleInput.value = fromHome;
  history.replaceState(null, "", location.pathname + location.hash);
}
draw();
void loadOpen();
if (handleInput.value) void useHandle(handleInput.value);
else void readLiveTerms();
