/**
 * Skydrop's participant side: the campaigns someone is in, what they can claim now and what's left to do. Creating
 * campaigns happens on atproto.tari.mw; both sites share the verifier and the eligibility checks in web-atproto/src/lib.
 */
import "./quests.css";
import { questArt } from "../../web-atproto/src/lib/art";
import { composeUrl, latestPost, resolveActor, targetLink, type Actor } from "../../web-atproto/src/lib/atproto";
import { decodeSpec, encodeSpec, fromMicro, RULES, summarize, type Rule, type Spec } from "../../web-atproto/src/lib/campaign";
import { checkRule, identity } from "../../web-atproto/src/lib/check";
import { append, copyButton, h, replace } from "../../web-atproto/src/lib/dom";
import { assess, totals, type Assessment, type StepView } from "../../web-atproto/src/lib/quests";
import { connectWallet, friendly, onWallet, shortAddress, silentConnect } from "../../web-atproto/src/lib/wallet";
import { DEPLOYMENT, isPublished } from "../../web-atproto/src/data/deployment";

const unit = "tTARI";
const CREATOR = "https://atproto.tari.mw";
const QKEY = "skydrop-quests";
const HKEY = "skydrop-handle";

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
    const id = hashOf(spec);
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
let checking = false;

const handleInput = h("input", { placeholder: "yourname.bsky.social", "aria-label": "Your Bluesky handle", autocomplete: "off", autocapitalize: "off", spellcheck: "false", value: store.get(HKEY, "") });
const go = h("button", { class: "btn primary", type: "submit" }, "Show my quests");
const who = h("div", { class: "who" });
const summary = h("div", { class: "qsummary" });
const board = h("div");
const addMsg = h("p", { class: "muted small-text", "aria-live": "polite" });

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
      s.status === "met" ? null : h("small", null, s.covered ? "Not needed: you've done the other option." : !s.actionable && s.status === "unmet" ? "Someone else decides this one." : s.detail),
    ),
    s.status === "met" || s.covered ? null : stepAction(s.rule),
  );
}

function claimPanel(t: Tracked): HTMLElement {
  // Collecting is added with the first published deployment, so it can be tested against the real contract.
  return h("div", { class: "qclaim" }, h("p", { class: "muted small-text" }, h("strong", null, "Nothing to collect yet. "),
    t.example ? "This is an example, with no money behind it." : "This is a preview: no funds exist behind it until the contract is published. Your progress here is real."));
}

function questCard(t: Tracked, a?: Assessment): HTMLElement {
  const s = t.spec;
  const lit = a ? a.steps.map((x) => x.status === "met") : [];
  const remove = h("button", { class: "linkbtn", type: "button" }, "Remove");
  remove.addEventListener("click", () => {
    store.set(QKEY, loadTracked().filter((x) => x.id !== t.id));
    assessments.delete(t.id);
    draw();
  });
  return h("article", { class: `questcard qcard${a?.state === "ready" ? " won" : ""}` },
    questArt(s.name, s.rules, lit),
    h("div", { class: "questbody" },
      h("div", { class: "row", style: "justify-content:space-between;gap:6px" },
        h("h3", null, s.name),
        t.example ? h("span", { class: "pill plain" }, "Example") : h("span", { class: "pill plain" }, "Preview"),
      ),
      h("p", { class: "questreward" }, s.allocations ? (a && a.perRound > 0n ? `${fromMicro(a.perRound)} ${unit}` : "Listed amounts") : `${fromMicro(s.reward)} ${unit}`, s.rounds > 1 ? h("small", { class: "muted" }, ` per round, ${s.rounds} rounds`) : null),
      s.about ? h("p", { class: "muted small-text" }, s.about) : null,
      a
        ? [
            h("div", { class: "meter big", role: "img", "aria-label": `${a.done} of ${a.total} steps done` }, h("i", { style: `width:${a.total ? (a.done / a.total) * 100 : a.state === "ready" ? 100 : 0}%` })),
            h("p", { class: "qhead" }, a.headline),
            h("ul", { class: "qsteps" }, a.steps.map(stepLine)),
            a.state === "ready" ? claimPanel(t) : null,
          ]
        : h("p", { class: "muted small-text" }, s.rules.length ? `${summarize(s.rules)[0]!.toUpperCase()}${summarize(s.rules).slice(1)}.` : "On an allocation list."),
      h("div", { class: "row", style: "justify-content:space-between;margin-top:4px" }, copyButton(() => `${location.origin}/quests#add=${encodeSpec(s)}`, "Share"), remove),
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
      h("p", { class: "muted" }, "Open a campaign link and it'll appear here, with what you've done and what's left. Nobody can see your list: it stays in this browser."),
      h("div", { class: "row", style: "justify-content:center" }, h("button", { class: "btn ghost", type: "button", onclick: () => void addExample() }, "Try an example")),
    ));
    return;
  }
  const seen = list.map((t) => assessments.get(t.id));
  const known = seen.filter((a): a is Assessment => !!a);
  if (known.length && actor) {
    const t = totals(known);
    replace(summary,
      h("div", { class: "qtile big" }, h("span", null, "Ready to claim"), h("strong", null, `${fromMicro(t.readyNow)} ${unit}`), h("small", null, `${t.readyCount} campaign${t.readyCount === 1 ? "" : "s"}`)),
      h("div", { class: "qtile" }, h("span", null, "Still to earn"), h("strong", null, `${fromMicro(t.toEarn)} ${unit}`), h("small", null, `${t.progressCount} in progress`)),
      h("div", { class: "qtile" }, h("span", null, "Tracking"), h("strong", null, String(list.length)), h("small", null, t.blockedCount ? `${t.blockedCount} you can't complete yourself` : "campaigns")),
    );
  } else {
    replace(summary);
  }
  const cards = (state: string[]) => list.filter((t) => state.includes(assessments.get(t.id)?.state ?? "new")).map((t) => questCard(t, assessments.get(t.id)));
  replace(board,
    section("Ready to claim", "You've done every step.", cards(["ready"])),
    section("In progress", "Here's what's left. Links open Bluesky; come back and refresh.", cards(["progress", "unknown"])),
    section("Needs someone else", "These depend on a list or a voucher, so you can't complete them yourself.", cards(["blocked"])),
    section(actor ? "Not checked yet" : "Your campaigns", actor ? "Checking…" : "Enter your handle above to see where you stand.", cards(["new"])),
  );
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

async function checkAll(): Promise<void> {
  if (!actor || checking) return;
  checking = true;
  go.disabled = true;
  go.textContent = "Checking…";
  try {
    const me = await identity(actor.did);
    for (const t of loadTracked()) {
      const results = await Promise.all(t.spec.rules.map((r) => checkRule(r, me)));
      assessments.set(t.id, assess(t.spec, actor.did, results.map((r) => ({ status: r.status, detail: r.detail }))));
      draw();
    }
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
    replace(who, h("p", { class: "fielderr" }, (e as Error).message));
    return;
  }
  store.set(HKEY, actor.handle);
  handleInput.value = actor.handle;
  assessments.clear();
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
  addMsg.textContent = r.ok ? (r.isNew ? `Added “${r.name}”.` : `“${r.name}” is already on your list.`) : r.error;
  if (r.ok) {
    addInput.value = "";
    draw();
    void checkAll();
  }
});

append(document.getElementById("app")!, [
  h("header", { class: "top" }, h("div", { class: "wrap bar" },
    h("a", { class: "brand", href: "/" }, h("span", { class: "dot" }), "skydrop"),
    h("nav", { class: "links qnav", "aria-label": "Main" }, h("a", { href: "/" }, "Send"), h("a", { href: "/quests", "aria-current": "page" }, "My quests"), h("a", { href: CREATOR, target: "_blank", rel: "noopener" }, "Create a campaign")),
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
    h("section", { class: "qadd" }, h("h2", null, "Add a campaign"), addForm, addMsg),
    !isPublished() ? h("div", { class: "note warn" }, h("strong", null, "Testnet preview. "), `The campaign contract isn't published on ${DEPLOYMENT.network} yet. Campaigns here are previews with no funds behind them, so nothing can be collected. Once it's live, this page will also show what you've already claimed and when your next round opens.`) : null,
  ),
]);

// A link like /quests#add=<campaign> adds it, then leaves the hash clean. It can also arrive while the page is open.
function addFromHash(): boolean {
  if (!location.hash.startsWith("#add=")) return false;
  const r = trackFromText(location.hash.slice(5));
  addMsg.textContent = r.ok ? (r.isNew ? `Added “${r.name}”.` : `“${r.name}” is already on your list.`) : r.error;
  history.replaceState(null, "", location.pathname);
  return r.ok;
}
addEventListener("hashchange", () => {
  if (addFromHash()) {
    draw();
    void checkAll();
  }
});
addFromHash();
draw();
if (handleInput.value) void useHandle(handleInput.value);
