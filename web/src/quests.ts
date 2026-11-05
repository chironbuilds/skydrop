/**
 * Skydrop's participant side: the campaigns someone is in, what they can claim now and what's left to do. Creating
 * campaigns happens on atproto.tari.mw; both sites share the verifier and the eligibility checks in web-atproto/src/lib.
 */
import "./quests.css";
import { questArt } from "../../web-atproto/src/lib/art";
import { composeUrl, fetchPost, latestPost, resolveActor, targetLink, type Actor } from "../../web-atproto/src/lib/atproto";
import { approxTime, CLAIM_FEE_MICRO, decodeSpec, encodeLive, encodeSpec, fromMicro, LIVE_PLACEHOLDER, RULES, summarize, type Rule, type Spec } from "../../web-atproto/src/lib/campaign";
import { checkRule, identity } from "../../web-atproto/src/lib/check";
import { campaignFromTx, explainChainError, listCreated, listParticipated, phaseOf, readCampaign, readReceipt, specOf, waitForOutcome, type ChainCampaign, type Receipt } from "../../web-atproto/src/lib/chain";
import { icons } from "./dom";
import { CLAIM_MAX_FEE, planClaim } from "../../web-atproto/src/lib/claim";
import { append, copyButton, h, replace } from "../../web-atproto/src/lib/dom";
import { assess, settle, totals, type Assessment, type StepView } from "../../web-atproto/src/lib/quests";
import { connectWallet, dryRunInstructions, friendly, onWallet, sendInstructions, shortAddress, silentConnect, walletBalance, walletState } from "../../web-atproto/src/lib/wallet";
import { contractsOnNetwork, DEPLOYMENT, isPublished } from "../../web-atproto/src/data/deployment";

const unit = "tTARI";
const CREATOR = "https://atproto.tari.mw";
const QKEY = "skydrop-quests";
const HKEY = "skydrop-handle";
/** Campaigns someone removed, so finding their past campaigns doesn't bring them back. */
const HIDDEN = "skydrop-hidden";

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

const hashOf = (s: Spec): string => encodeSpec({ ...s }).slice(0, 180) + encodeSpec({ ...s }).length;
const loadTracked = (): Tracked[] => store.get<Tracked[]>(QKEY, []).filter((t) => t?.spec && Array.isArray(t.spec.rules));

/** Adds a campaign from a shared link's text. Everything in it is re-validated, and shown only as text. */
function trackFromText(text: string): { ok: true; name: string; isNew: boolean } | { ok: false; error: string } {
  const m = text.trim().match(/(?:#add=|\/c\/preview#|campaigns\/new#|^)([A-Za-z0-9_-]{20,})$/);
  if (!m) return { ok: false, error: "That doesn't look like a campaign link." };
  try {
    const spec = decodeSpec(m[1]!);
    const list = loadTracked();
    const id = spec.component ?? hashOf(spec);
    if (list.some((t) => t.id === id)) return { ok: true, name: spec.name, isNew: false };
    list.unshift({ id, spec, added: Date.now() });
    store.set(QKEY, list);
    return { ok: true, name: spec.name, isNew: true };
  } catch (e) {
    return { ok: false, error: `That link couldn't be read: ${(e as Error).message}` };
  }
}

// ---- state ------------------------------------------------------------------------------------------------
let actor: Actor | null = null;
const assessments = new Map<string, Assessment>();
/** What the chain says about tracked live campaigns. Their terms come from here, not from the link that added them. */
const liveData = new Map<string, { c: ChainCampaign; receipt: Receipt | null }>();
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
let lastCheck = 0;
let checking = false;

const handleInput = h("input", { placeholder: "yourname.bsky.social", "aria-label": "Your Bluesky handle", autocomplete: "off", autocapitalize: "off", spellcheck: "false", value: store.get(HKEY, "") });
const go = h("button", { class: "btn primary", type: "submit" }, "Show my quests");
const who = h("div", { class: "who" });
const summary = h("div", { class: "qsummary" });
const board = h("div");
const addMsg = h("p", { class: "muted small-text", "aria-live": "polite" });
const openBox = h("div");
const toastBox = h("div", { class: "qtoast", role: "status", "aria-live": "polite" });
let toastTimer = 0;

function toast(text: string): void {
  toastBox.textContent = text;
  toastBox.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastBox.classList.remove("on"), 5000);
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
  return h("li", { class: `qstep ${cls}` },
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

  async function begin(): Promise<void> {
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
    replace(body, say("Checking your records and the campaign…"));
    try {
      const c = await readCampaign(live.c.component);
      const plan = await planClaim(c, actor.did, w.key, w.account, t.spec.allocations);
      rechecks.delete(t.id);
      const stage = plan.kind === "ready" ? 3 : 2;
      if (panelStage.get(t.id) !== stage) {
        panelStage.set(t.id, stage);
        draw();
      }
      switch (plan.kind) {
        case "post": {
          rechecks.set(t.id, () => void begin());
          const again = h("button", { class: "btn small primary", type: "button", onclick: () => void begin() }, "I've posted it");
          replace(body,
            h("p", { class: "small-text", style: "margin:0" }, h("strong", null, plan.round > 0 ? `Round ${plan.round + 1}: post this to collect. ` : "One last step: post this. "), "It proves this Bluesky account chose your wallet, so nobody else can redirect the reward."),
            h("pre", { style: "white-space:pre-wrap;word-break:break-all;margin:0" }, plan.text),
            h("div", { class: "row" }, h("a", { class: "btn small ghost", href: composeUrl(plan.text), target: "_blank", rel: "noopener noreferrer" }, "Post on Bluesky"), copyButton(() => plan.text), again),
            say("This page checks for it when you come back. You can delete the post after you've collected."),
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
              await dryRunInstructions(plan.instructions, CLAIM_MAX_FEE, plan.inputs);
              const tx = await sendInstructions(plan.instructions, CLAIM_MAX_FEE, (s) => { status.textContent = s === "approve" ? "Approve it in your wallet…" : "Sending to the network…"; }, plan.inputs);
              status.textContent = "Waiting for the network to confirm…";
              const out = await waitForOutcome(tx);
              if (out.state === "rejected") throw new Error(`The network refused it, and only the fee was spent. ${out.reason}`);
              if (out.state === "pending") throw new Error(`It hasn't confirmed yet. Don't claim again: refresh in a few minutes. Transaction ${tx}`);
              reset(`Collected ${fromMicro(plan.amount)} ${unit} from “${t.spec.name}”.`);
            } catch (e) {
              status.className = "fielderr";
              status.textContent = explainChainError(friendly(e));
              go.disabled = false;
            }
          });
          const funds = h("div");
          replace(body, say("Your post is there. Last step:"), go, say(`Goes to your wallet. It pays the network fee, about ${fromMicro(CLAIM_FEE_MICRO)} ${unit} or more, and only the real cost is charged.`), funds, status);
          void walletBalance().then((have) => {
            if (have !== null && have < CLAIM_FEE_MICRO) replace(funds, h("p", { class: "note warn", style: "margin:0" }, `Your wallet has ${fromMicro(have)} ${unit}, which may not cover the fee. Add some first.`));
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
          replace(body, say("This link doesn't carry the campaign's real allocation list, so your amount can't be proven. Ask the creator for a fresh link.", "fielderr"));
          break;
      }
    } catch (e) {
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

/** Where someone is in a live campaign. Only shown while there's still something to do. */
function flowSteps(t: Tracked, a: Assessment): HTMLElement | null {
  if (!t.spec.component || !["progress", "ready", "unknown"].includes(a.state)) return null;
  const now = a.state === "ready" ? (panelStage.get(t.id) ?? 2) : 1;
  return h("ol", { class: "qflow", "aria-label": "Your progress" }, ["Do the steps", "Post once", "Collect"].map((label, i) =>
    h("li", { class: i + 1 < now ? "done" : i + 1 === now ? "now" : "", "aria-current": i + 1 === now ? "step" : null }, label)));
}

function questCard(t: Tracked, a?: Assessment): HTMLElement {
  const s = t.spec;
  const unread = !!s.component && !liveData.has(t.id);
  const lit = a ? a.steps.map((x) => x.status === "met") : [];
  const remove = h("button", { class: "linkbtn", type: "button" }, "Remove");
  remove.addEventListener("click", () => {
    store.set(QKEY, loadTracked().filter((x) => x.id !== t.id));
    store.set(HIDDEN, [...store.get<string[]>(HIDDEN, []), t.id]);
    assessments.delete(t.id);
    panels.delete(t.id);
    rechecks.delete(t.id);
    draw();
  });
  return h("article", { class: `questcard qcard${a?.state === "ready" ? " won" : ""}` },
    h("div", { class: "qart" }, questArt(s.name, s.rules, lit), a?.state === "claimed" ? h("span", { class: "qstamp" }, "Collected") : null),
    h("div", { class: "questbody" },
      h("div", { class: "row", style: "justify-content:space-between;gap:6px" },
        h("h3", null, s.name),
        t.example ? h("span", { class: "pill plain" }, "Example") : liveData.has(t.id) ? h("span", { class: "pill ok" }, "Live") : h("span", { class: "pill plain" }, "Preview"),
      ),
      unread ? null : h("p", { class: "questreward" }, s.allocations ? (a && a.perRound > 0n ? `${fromMicro(a.perRound)} ${unit}` : "Listed amounts") : `${fromMicro(s.reward)} ${unit}`, s.rounds > 1 ? h("small", { class: "muted" }, ` per round, ${s.rounds} rounds`) : null),
      s.about ? h("p", { class: "muted small-text" }, s.about) : null,
      liveErrors.has(t.id) ? h("p", { class: "fielderr" }, liveErrors.get(t.id)!) : null,
      a && a.paid > 0n ? h("p", { class: "small-text", style: "margin:0" }, h("strong", null, `Collected ${fromMicro(a.paid)} ${unit}`), a.fullAmount > a.paid ? `, ${fromMicro(a.fullAmount - a.paid)} ${unit} still possible.` : ".") : null,
      a
        ? [
            flowSteps(t, a) ?? h("div", { class: "meter big", role: "img", "aria-label": `${a.done} of ${a.total} steps done` }, h("i", { style: `width:${a.total ? (a.done / a.total) * 100 : a.state === "ready" ? 100 : 0}%` })),
            h("p", { class: "qhead" }, a.headline),
            h("ul", { class: "qsteps" }, a.steps.map(stepLine)),
            a.state === "ready" ? claimPanel(t) : null,
          ]
        : unread
          ? liveErrors.has(t.id) ? null : h("p", { class: "muted small-text" }, "Reading the contract…")
          : h("p", { class: "muted small-text" }, s.rules.length ? `${summarize(s.rules)[0]!.toUpperCase()}${summarize(s.rules).slice(1)}.` : "On an allocation list."),
      h("div", { class: "row", style: "justify-content:space-between;margin-top:4px" }, copyButton(() => `${location.origin}/quests#add=${s.component ? encodeLive(s.component, s.allocations) : encodeSpec(s)}`, "Share"), remove),
    ));
}

function section(title: string, note: string, items: HTMLElement[]): HTMLElement | null {
  if (!items.length) return null;
  return h("section", { class: "qsection" }, h("h2", null, title, h("span", { class: "qcount" }, String(items.length))), h("p", { class: "muted small-text" }, note), h("div", { class: "questgrid" }, items));
}

function draw(): void {
  const list = loadTracked();
  if (!list.length) {
    replace(summary);
    replace(board, h("div", { class: "qempty" },
      h("h2", null, "No quests yet"),
      h("p", { class: "muted" }, "Pick an open campaign below, or open a link someone shared. It'll appear here with what you've done and what's left. Your list stays in this browser."),
      h("div", { class: "row", style: "justify-content:center" }, h("button", { class: "btn ghost small", type: "button", onclick: () => void addExample() }, "Try a pretend example")),
    ));
    drawOpen();
    return;
  }
  const seen = list.map((t) => assessments.get(t.id));
  const known = seen.filter((a): a is Assessment => !!a);
  if (known.length && actor) {
    const t = totals(known);
    replace(summary,
      t.readyCount
        ? h("div", { class: "qtile big" }, h("span", null, "Ready to claim"), h("strong", null, `${fromMicro(t.readyNow)} ${unit}`), h("small", null, `${t.readyCount} campaign${t.readyCount === 1 ? "" : "s"}`))
        : h("div", { class: "qtile" }, h("span", null, "Ready to claim"), h("strong", null, "Nothing yet"), h("small", null, t.progressCount ? "Finish the steps below" : "Add a campaign to start")),
      h("div", { class: "qtile" }, h("span", null, "Still to earn"), h("strong", null, `${fromMicro(t.toEarn)} ${unit}`), h("small", null, `${t.progressCount} in progress`)),
      t.collected > 0n
        ? h("div", { class: "qtile" }, h("span", null, "Collected"), h("strong", null, `${fromMicro(t.collected)} ${unit}`), h("small", null, "paid to your wallet"))
        : h("div", { class: "qtile" }, h("span", null, "Tracking"), h("strong", null, String(list.length)), h("small", null, t.blockedCount ? `${t.blockedCount} you can't complete yourself` : list.length === 1 ? "campaign" : "campaigns")),
    );
  } else {
    replace(summary);
  }
  const cards = (state: string[]) => list.filter((t) => state.includes(assessments.get(t.id)?.state ?? "new")).map((t) => questCard(t, assessments.get(t.id)));
  replace(board,
    section("Ready to claim", "You've done every step.", cards(["ready"])),
    section("In progress", "Here's what's left. Do them on Bluesky, and this page checks again when you come back.", cards(["progress", "unknown"])),
    section("Coming up", "Nothing to do until these open.", cards(["waiting"])),
    section("Needs someone else", "These depend on a list or a voucher, so you can't complete them yourself.", cards(["blocked"])),
    section("Finished", "Nothing more to collect from these.", cards(["claimed", "over"])),
    section(actor ? "Not checked yet" : "Your campaigns", actor ? "Checking your Bluesky records…" : "Enter your handle above to see where you stand.", cards(["new"])),
  );
  drawOpen();
}

// ---- finding campaigns --------------------------------------------------------------------------------------

/** Open campaigns made with this contract, read back from the chain. Those with a private list can't be joined from here. */
async function loadOpen(): Promise<void> {
  try {
    const created = (await listCreated()).slice(0, 24);
    const read = await Promise.all(created.map((e) => campaignFromTx(e.tx).catch(() => null)));
    openCampaigns = read.filter((c): c is ChainCampaign => !!c && !c.root && phaseOf(c) !== "closed" && c.balance >= c.reward && c.reward > 0n);
  } catch {
    openCampaigns = [];
  }
  drawOpen();
}

function openCard(c: ChainCampaign): HTMLElement {
  const add = h("button", { class: "btn small primary", type: "button" }, "Add to my quests");
  add.addEventListener("click", () => {
    const r = trackFromText(encodeLive(c.component));
    if (r.ok) toast(`Added “${c.name}”.`);
    draw();
    void (actor ? checkAll() : readLiveTerms());
  });
  return h("article", { class: "qopen" },
    h("h3", null, c.name),
    h("p", { class: "questreward" }, `${fromMicro(c.reward)} ${unit}`, c.rounds > 1 ? h("small", { class: "muted" }, ` per round, ${c.rounds} rounds`) : null),
    h("p", { class: "muted small-text" }, c.rules.length ? `${summarize(c.rules)[0]!.toUpperCase()}${summarize(c.rules).slice(1)}.` : ""),
    c.reward <= CLAIM_FEE_MICRO * 2n ? h("p", { class: "qfeenote" }, `Collecting costs about ${fromMicro(CLAIM_FEE_MICRO)} ${unit} in fees, so this may not be worth it.`) : null,
    h("p", { class: "muted small-text" }, `${c.claimants.toLocaleString("en-US")} claimed · ${fromMicro(c.balance)} ${unit} left · `, h("a", { href: `${CREATOR}/c/${c.component}`, target: "_blank", rel: "noopener" }, "Details")),
    add,
  );
}

function drawOpen(): void {
  if (openCampaigns === null) {
    replace(openBox, h("section", { class: "qsection" }, h("h2", null, "Open campaigns"), h("p", { class: "muted small-text" }, "Reading the network…")));
    return;
  }
  const tracked = new Set(loadTracked().map((t) => t.id));
  const fresh = openCampaigns.filter((c) => !tracked.has(c.component));
  replace(openBox, fresh.length
    ? h("section", { class: "qsection" },
        h("h2", null, "Open campaigns", h("span", { class: "qcount" }, String(fresh.length))),
        h("p", { class: "muted small-text" }, "Anyone can create a campaign and nobody has vetted these. Their rewards and rules are real; check a post before you engage with it."),
        h("div", { class: "questgrid" }, fresh.map(openCard)))
    : null);
}

/** Adds campaigns this account has already been paid by, so they show up on any device. */
async function findMine(did: string): Promise<void> {
  const hidden = new Set(store.get<string[]>(HIDDEN, []));
  const known = new Set(loadTracked().map((t) => t.id));
  const found = (await listParticipated(did).catch(() => [] as string[])).filter((c) => !known.has(c) && !hidden.has(c));
  if (!found.length) return;
  for (const c of found) trackFromText(encodeLive(c));
  toast(`Found ${found.length} campaign${found.length === 1 ? "" : "s"} you've collected from.`);
}

/** Puts what each step points at into words, so people can see what they're being asked to engage with. */
async function describeTargets(): Promise<void> {
  const rules = loadTracked().flatMap((t) => t.spec.rules);
  const posts = [...new Set(rules.filter((r) => RULES[r.kind]?.input === "post").map((r) => r.target))].filter((x) => !targetInfo.has(x));
  const people = [...new Set(rules.filter((r) => RULES[r.kind]?.input === "did").map((r) => r.target))].filter((x) => !targetInfo.has(x));
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
async function refreshLive(t: Tracked, did: string | null): Promise<{ c: ChainCampaign; receipt: Receipt | null } | null> {
  try {
    const c = await readCampaign(t.spec.component!);
    const receipt = did ? await readReceipt(c, did) : null;
    liveData.set(t.id, { c, receipt });
    liveErrors.delete(t.id);
    t.spec = specOf(c, t.spec.allocations);
    store.set(QKEY, loadTracked().map((x) => (x.id === t.id ? t : x)));
    return { c, receipt };
  } catch (e) {
    liveData.delete(t.id);
    liveErrors.set(t.id, `This campaign couldn't be read from the network: ${(e as Error).message}`);
    return null;
  }
}

async function checkAll(): Promise<void> {
  if (!actor || checking) return;
  checking = true;
  go.disabled = true;
  go.textContent = "Checking…";
  try {
    await findMine(actor.did);
    const me = await identity(actor.did);
    for (const t of loadTracked()) {
      const live = t.spec.component ? await refreshLive(t, actor.did) : null;
      // Without the contract there are no trustworthy terms to check against.
      if (t.spec.component && !live) {
        assessments.delete(t.id);
        draw();
        continue;
      }
      const spec = t.spec;
      const results = await Promise.all(spec.rules.map((r) => checkRule(r, me)));
      let a = assess(spec, actor.did, results.map((r) => ({ status: r.status, detail: r.detail })));
      if (live) {
        const { c, receipt } = live;
        const phase = phaseOf(c);
        const roundsPaid = receipt?.roundsPaid ?? 0;
        const waitEpochs = phase === "upcoming" ? c.openEpoch - c.epoch : receipt ? Math.max(0, receipt.lastEpoch + c.roundEpochs - c.epoch) : 0;
        a = settle(a, { roundsPaid, rounds: c.rounds, phase, waitEpochs, waitText: approxTime(waitEpochs), funded: a.perRound === 0n || c.balance >= a.perRound });
      }
      assessments.set(t.id, a);
      draw();
    }
    await describeTargets();
    lastCheck = Date.now();
  } catch (e) {
    replace(who, h("p", { class: "fielderr" }, (e as Error).message));
  } finally {
    checking = false;
    go.disabled = false;
    go.textContent = "Refresh";
    draw();
  }
}

async function useHandle(text: string): Promise<void> {
  if (!text.trim()) {
    handleInput.focus();
    return;
  }
  replace(who);
  try {
    actor = await resolveActor(text);
  } catch (e) {
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
  assessments.clear();
  panels.clear();
  panelStage.clear();
  rechecks.clear();
  replace(who, actor.avatar ? h("img", { src: actor.avatar, alt: "", width: "40", height: "40", referrerpolicy: "no-referrer" }) : null, h("div", null, h("strong", null, actor.displayName), h("div", { class: "muted small-text" }, `@${actor.handle}`)));
  draw();
  await checkAll();
}

// ---- page -------------------------------------------------------------------------------------------------
const chip = h("div", { class: "walletchip" });
onWallet((w) => {
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
  h("header", { class: "top" }, h("div", { class: "wrap bar" },
    h("a", { class: "brand", href: "/" }, h("span", { class: "logo" }, icons.drop(20)), h("span", { class: "brand-name" }, "Skydrop")),
    h("nav", { class: "links qnav", "aria-label": "Main" }, h("a", { href: "/quests", "aria-current": "page" }, "My quests"), h("a", { href: "/#/how" }, "How it works"), h("a", { href: CREATOR, target: "_blank", rel: "noopener" }, "Create a campaign")),
    chip,
  )),
  h("main", { class: "wrap qmain" },
    h("span", { class: "kicker" }, "My quests"),
    h("h1", null, "What you've earned, and what's left"),
    h("p", { class: "lede" }, "Enter your handle to see every campaign you're tracking. Each step is checked against your own signed Bluesky data, right here in your browser."),
    form,
    who,
    summary,
    board,
    openBox,
    h("section", { class: "qadd" }, h("h2", null, "Have a link?"), addForm, addMsg),
    !isPublished()
      ? h("div", { class: "note warn" }, h("strong", null, "Testnet preview. "), `${contractsOnNetwork() ? `The campaign contract is on ${DEPLOYMENT.network}, but funding and claiming from these sites is still being built.` : `The campaign contract isn't published on ${DEPLOYMENT.network} yet.`} Campaigns here are previews with no funds behind them, so nothing can be collected.`)
      : h("div", { class: "note warn" }, h("strong", null, "Testnet only. "), `Rewards here are ${unit} on the ${DEPLOYMENT.network}, with no real value. The contracts haven't had an outside audit. Anyone can create a campaign, so judge what it asks you to do yourself.`),
  ),
  toastBox,
]);

// A link like /quests#add=<campaign> adds it, then leaves the hash clean. It can also arrive while the page is open.
function addFromHash(): boolean {
  if (!location.hash.startsWith("#add=")) return false;
  const r = trackFromText(location.hash.slice(5));
  if (r.ok) toast(addedText(r));
  else addMsg.textContent = r.error;
  history.replaceState(null, "", location.pathname);
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
}
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
