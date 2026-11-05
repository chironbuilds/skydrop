import { DEPLOYMENT, isPublished, participantLink } from "../data/deployment";
import { PLAYBOOKS } from "../data/playbooks";
import { questArt } from "../lib/art";
import { fetchPost, resolveActor, parseAtUri, targetLink, toTarget, type PostInfo } from "../lib/atproto";
import { buildAllocationTree, createArgs, decodeSpec, encodeSpec, EPOCHS_PER_DAY, exposure, fromMicro, MAX_RULES, newSpec, PALETTE, POINTS_LIMIT, project, questName, ruleDef, summarize, toMicro, validate, type Allocation, type Rule, type RuleKind, type Spec } from "../lib/campaign";
import { compose, EXAMPLES } from "../lib/compose";
import { copyButton, download, h, pageHead, replace } from "../lib/dom";
import { allDrafts, getDraft, newDraftId, saveDraft, timeAgo } from "../lib/library";
import { walletState } from "../lib/wallet";
import type { Page } from "../main";
import { exposurePill, specFromPlaybook } from "./campaigns";

/** Parses "handle-or-did, amount" lines. */
export function parseAllocationLines(text: string): { who: string; amount: bigint }[] {
  const out: { who: string; amount: bigint }[] = [];
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(\S+?)[,\s]+([\d.]+)$/);
    if (!m) throw new Error(`Line ${i + 1}: expected "handle, amount"`);
    out.push({ who: m[1]!, amount: toMicro(m[2]!) });
  }
  return out;
}

const unit = "tTARI";
const row = (k: string, v: string): HTMLElement => h("div", null, h("dt", null, k), h("dd", null, v));
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "campaign";
const iconOf = (kind: number): string => PALETTE.find((p) => p.kind === kind)?.icon ?? "•";
const labelOf = (kind: number): string => PALETTE.find((p) => p.kind === kind)?.label ?? "Step";
const isPostStep = (kind: number): boolean => ruleDef(kind).input === "post";

/** A post shown back to the person setting up the campaign, so they can see they picked the right one. */
export function postCard(p: PostInfo): HTMLElement {
  return h("div", { class: "postcard" },
    p.avatar ? h("img", { src: p.avatar, alt: "", width: "38", height: "38", loading: "lazy", referrerpolicy: "no-referrer" }) : h("span", { class: "noavatar" }),
    h("div", null,
      h("strong", null, p.displayName), " ", h("span", { class: "muted small-text" }, `@${p.handle}`),
      h("p", null, p.text.length > 220 ? `${p.text.slice(0, 220)}…` : p.text || "(no text)"),
      h("a", { class: "small-text", href: targetLink(p.uri) ?? "#", target: "_blank", rel: "noopener noreferrer" }, "Open on Bluesky"),
    ));
}

type Source = { type: "new"; kind: RuleKind } | { type: "move"; index: number };

export function builderPage(): Page {
  const params = new URLSearchParams(location.search);
  const pb = PLAYBOOKS.find((p) => p.id === params.get("playbook"));
  // Where this campaign comes from: a saved draft, a shared link, a playbook, or a blank board.
  const draftParam = params.get("draft");
  const saved = draftParam ? getDraft(draftParam) : undefined;
  let fromLink: Spec | null = null;
  if (location.hash.length > 1) {
    try {
      fromLink = decodeSpec(location.hash.slice(1));
    } catch {
      fromLink = null;
    }
  }
  const spec: Spec = saved?.spec ?? fromLink ?? (pb ? specFromPlaybook(pb) : newSpec());
  const draftId = saved?.id ?? newDraftId();
  const earlier = !saved && !fromLink && !pb && !params.get("do") ? allDrafts()[0] : undefined;
  const useAllocation = { on: !!pb?.usesAllocation || !!spec.root };
  let allocationText = "";
  let proofs: Record<string, { amount: string; path: string[] }> | null = null;
  let nameTouched = !!pb || !!saved || !!fromLink;

  // Links like /campaigns/new?do=0,1,4 start with those steps on the board.
  for (const k of (params.get("do") ?? "").split(",").filter(Boolean)) {
    const kind = Number(k);
    if (PALETTE.some((p) => p.kind === kind) && spec.rules.length < MAX_RULES) spec.rules.push({ kind: kind as RuleKind, target: "" });
  }

  const posts = new Map<string, PostInfo | null>();
  const handles = new Map<string, string>();
  const errors = new WeakMap<Rule, string>();

  const preview = h("div", { class: "side" });
  const palette = h("div", { class: "palette", role: "group", "aria-label": "Step types. Drag onto the board, or press to add." });
  const board = h("div", { class: "board" });
  const sentence = h("p", { class: "sentence", "aria-live": "polite" });
  const announcer = h("div", { class: "sr", "aria-live": "assertive" });
  const nameInput = h("input", { value: spec.name, maxlength: "64", placeholder: "Named for you as you add steps", oninput: () => { nameTouched = true; edited = true; spec.name = nameInput.value; drawSide(); autosave(); } });

  const say = (text: string) => { announcer.textContent = text; };

  // Undo: a snapshot before every change to the steps.
  const history: string[] = [];
  const undoBtn = h("button", { class: "btn small ghost", type: "button", disabled: true, onclick: () => undo() }, "Undo");
  const remember = () => {
    history.push(JSON.stringify(spec.rules));
    if (history.length > 50) history.shift();
    undoBtn.disabled = false;
  };
  function undo(): void {
    const last = history.pop();
    if (!last) return;
    spec.rules = JSON.parse(last) as Rule[];
    undoBtn.disabled = !history.length;
    say("Undone.");
    drawBoard();
    refresh();
    void hydrate();
  }

  let edited = !!saved;
  const saveNote = h("span", { class: "muted small-text", "aria-live": "off" });
  let saveTimer = 0;
  function autosave(): void {
    // Opening the builder saves nothing: a draft starts with the first real edit.
    if (!edited) return;
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      const ok = saveDraft(draftId, spec, walletState().key);
      saveNote.textContent = ok ? "Saved in this browser" : "Couldn't save in this browser";
    }, 350);
  }

  function refresh(): void {
    if (!nameTouched) {
      spec.name = questName(spec.rules.map((r) => r.kind));
      nameInput.value = spec.name;
    }
    sentence.textContent = spec.rules.length ? `To earn the reward: ${summarize(spec.rules)}.` : "Add at least one step.";
    drawSide();
    autosave();
  }

  const distinctPosts = (): string[] => [...new Set(spec.rules.filter((r) => isPostStep(r.kind) && r.target).map((r) => r.target))];
  const postNumber = (t: string): number => distinctPosts().indexOf(t) + 1;
  const isTaken = (kind: number, target: string, self?: Rule) => spec.rules.some((r) => r !== self && r.kind === kind && r.target === target);

  /** A new step starts on the most recent post, unless that step already exists there. */
  function makeStep(kind: RuleKind): Rule {
    const rule: Rule = { kind, target: "" };
    const list = distinctPosts();
    const last = list[list.length - 1];
    if (last && isPostStep(kind) && !isTaken(kind, last)) rule.target = last;
    if (last && kind === 2 && !isTaken(2, parseAtUri(last)!.did)) rule.target = parseAtUri(last)!.did;
    return rule;
  }

  function addStep(kind: RuleKind, at = spec.rules.length): void {
    if (spec.rules.length >= MAX_RULES) {
      say(`That's the maximum of ${MAX_RULES} steps.`);
      return;
    }
    remember();
    spec.rules.splice(at, 0, makeStep(kind));
    say(`Added ${labelOf(kind)} as step ${at + 1}.`);
    drawBoard();
    refresh();
  }

  function moveStep(from: number, to: number): void {
    if (to < 0 || to >= spec.rules.length || from === to) return;
    remember();
    const [rule] = spec.rules.splice(from, 1);
    spec.rules.splice(to, 0, rule!);
    say(`Moved to step ${to + 1}.`);
    drawBoard();
    refresh();
  }

  async function setTarget(rule: Rule, text: string): Promise<void> {
    const def = ruleDef(rule.kind);
    let v = text.trim();
    errors.delete(rule);
    // Several links pasted at once become one step each.
    if (def.input === "post") {
      const links = v.match(/(https?:\/\/)?(www\.)?bsky\.app\/profile\/[^/\s]+\/post\/[^/?#\s,]+/gi) ?? [];
      if (links.length > 1) {
        remember();
        v = links[0]!;
        const at = spec.rules.indexOf(rule);
        const extra = links.slice(1, 1 + MAX_RULES - spec.rules.length).map((link) => ({ kind: rule.kind, target: "", pending: link }));
        spec.rules.splice(at + 1, 0, ...extra.map(({ kind, target }) => ({ kind, target })));
        await Promise.all(extra.map((e, i) => toTarget(e.pending, "post").then(async (t) => {
          spec.rules[at + 1 + i]!.target = t;
          if (!posts.has(t)) posts.set(t, await fetchPost(t).catch(() => null));
        }).catch(() => undefined)));
      }
    }
    if (def.input === "text" || !v) {
      rule.target = v;
      refresh();
      return;
    }
    try {
      rule.target = await toTarget(v, def.input);
      if (def.input === "post") {
        if (!posts.has(rule.target)) posts.set(rule.target, await fetchPost(rule.target).catch(() => null));
        if (!posts.get(rule.target)) errors.set(rule, "No post found at that link. It may have been deleted.");
        else {
          // Pasting once fills the other empty steps: different actions on one post is the common case.
          const author = parseAtUri(rule.target)!.did;
          for (const r of spec.rules) {
            if (r.target) continue;
            if (isPostStep(r.kind) && !isTaken(r.kind, rule.target, r)) r.target = rule.target;
            else if (r.kind === 2 && !isTaken(2, author, r)) r.target = author;
          }
        }
      }
      if (def.input === "did" && !handles.has(rule.target)) handles.set(rule.target, (await resolveActor(rule.target)).handle);
    } catch (e) {
      rule.target = "";
      errors.set(rule, (e as Error).message);
    }
    drawBoard();
    refresh();
  }

  function stepCard(rule: Rule, i: number): HTMLElement {
    const def = ruleDef(rule.kind);
    const input = h("input", {
      value: def.input === "text" ? rule.target : rule.target ? (targetLink(rule.target) ?? rule.target) : "",
      placeholder: rule.label ? `${rule.label}: ${def.placeholder}` : def.placeholder,
      "aria-label": `Step ${i + 1}: ${def.name}`,
      spellcheck: "false",
      autocomplete: "off",
      onchange: () => void setTarget(rule, input.value),
      onpaste: () => setTimeout(() => void setTarget(rule, input.value), 0),
    });

    const handle = h("button", { class: "grip", type: "button", "aria-label": `Drag step ${i + 1} to reorder`, title: "Drag to reorder" }, "⠿");
    handle.addEventListener("pointerdown", (e) => startDrag(e, { type: "move", index: i }, card));

    const otherPosts = isPostStep(rule.kind) ? distinctPosts().filter((t) => t !== rule.target && !isTaken(rule.kind, t, rule)) : [];
    const authors = rule.kind === 2 ? [...new Set(distinctPosts().map((t) => parseAtUri(t)!.did))].filter((d) => d !== rule.target) : [];
    const post = rule.target ? posts.get(rule.target) : null;

    const card = h("div", { class: "stepbox", "data-index": String(i) },
      h("div", { class: "stephead" },
        handle,
        h("span", { class: "num" }, String(i + 1)),
        h("span", { class: "ico", "aria-hidden": "true" }, iconOf(rule.kind)),
        h("strong", null, def.name),
        isPostStep(rule.kind) && rule.target ? h("span", { class: "pill plain" }, `Post ${postNumber(rule.target)}`) : null,
        h("span", { class: "stepbtns" },
          h("button", { class: "iconbtn s", type: "button", disabled: i === 0, "aria-label": `Move step ${i + 1} up`, onclick: () => moveStep(i, i - 1) }, "↑"),
          h("button", { class: "iconbtn s", type: "button", disabled: i === spec.rules.length - 1, "aria-label": `Move step ${i + 1} down`, onclick: () => moveStep(i, i + 1) }, "↓"),
          h("button", { class: "iconbtn s", type: "button", disabled: spec.rules.length >= MAX_RULES, title: "Duplicate", "aria-label": `Duplicate step ${i + 1}`, onclick: () => { remember(); spec.rules.splice(i + 1, 0, { kind: rule.kind, target: "", text: rule.text }); say(`Duplicated step ${i + 1}.`); drawBoard(); refresh(); } }, "⧉"),
          h("button", { class: "iconbtn s", type: "button", "aria-label": `Remove step ${i + 1}`, onclick: () => { remember(); spec.rules.splice(i, 1); say(`Removed step ${i + 1}. Undo is available.`); drawBoard(); refresh(); } }, "✕"),
        ),
      ),
      input,
      errors.get(rule) ? h("p", { class: "fielderr" }, errors.get(rule)) : null,
      otherPosts.length ? h("div", { class: "reuse" }, "Use ", otherPosts.map((t) => h("button", { class: "chip mini", type: "button", onclick: () => void setTarget(rule, t) }, `Post ${postNumber(t)}`))) : null,
      authors.length ? h("div", { class: "reuse" }, "Use ", authors.map((d) => h("button", { class: "chip mini", type: "button", onclick: () => void setTarget(rule, d) }, handles.get(d) ? `@${handles.get(d)}` : "the post's author"))) : null,
      post ? postCard(post) : null,
      rule.kind === 4 || rule.kind === 5 ? h("label", { class: "field" }, "Must say (optional)",
        h("input", { value: rule.text ?? "", maxlength: "200", placeholder: "#OotleLaunch", oninput: (e: Event) => { const t = (e.target as HTMLInputElement).value; if (t) rule.text = t; else delete rule.text; refresh(); } }),
        h("small", null, rule.kind === 4 ? "The comment itself has to contain this, capitals included." : "The quote itself has to contain this, capitals included.")) : null,
      def.input === "did" && rule.target && handles.get(rule.target) ? h("p", { class: "muted small-text" }, `@${handles.get(rule.target)}`) : null,
      def.side === "voucher" ? snapshotField(rule) : null,
    );
    return card;
  }

  function drawBoard(): void {
    replace(board,
      spec.rules.length
        ? spec.rules.map((r, i) => [i > 0 ? h("button", { class: `andline${r.or ? " or" : ""}`, type: "button", "aria-pressed": String(!!r.or), title: "Click to switch between and / or", "aria-label": `Steps ${i} and ${i + 1}: ${r.or ? "either one" : "both"}. Press to switch.`, onclick: () => { remember(); if (r.or) delete r.or; else r.or = true; drawBoard(); refresh(); } }, r.or ? "or" : "and") : null, stepCard(r, i)])
        : h("div", { class: "emptyboard" }, h("strong", null, "Drag a step here"), h("span", { class: "muted small-text" }, "or press one above to add it")),
    );
    for (const b of palette.querySelectorAll("button")) (b as HTMLButtonElement).disabled = spec.rules.length >= MAX_RULES;
  }

  // Steps restored from a draft or a link name posts and accounts this page hasn't looked up yet.
  async function hydrate(): Promise<void> {
    let changed = false;
    await Promise.all(spec.rules.map(async (r) => {
      if (!r.target) return;
      const def = ruleDef(r.kind);
      if (def.input === "post" && !posts.has(r.target)) {
        posts.set(r.target, await fetchPost(r.target).catch(() => null));
        changed = true;
      } else if (def.input === "did" && !handles.has(r.target)) {
        handles.set(r.target, await resolveActor(r.target).then((a) => a.handle).catch(() => ""));
        changed = true;
      }
    }));
    if (changed) drawBoard();
  }

  // ---- describe it in words ----------------------------------------------------------------------------
  const magicInput = h("textarea", { rows: "2", class: "magic", "aria-label": "Describe your campaign", placeholder: "Like, repost and comment on <post link>, 5 tTARI each, pool 500, for 7 days" });
  const magicOut = h("div", { class: "small-text", "aria-live": "polite" });
  async function buildFromWords(text: string): Promise<void> {
    const c = compose(text);
    if (!c.steps.length) {
      replace(magicOut, h("p", { class: "fielderr" }, "I couldn't find any steps in that. Try words like like, repost, comment, quote or follow, with a post link."));
      return;
    }
    remember();
    edited = true;
    magicOut.textContent = "Building…";
    const problems = [...c.notes];
    const built: Rule[] = [];
    for (const s of c.steps.slice(0, MAX_RULES)) {
      const def = ruleDef(s.kind);
      const rule: Rule = { kind: s.kind, target: "" };
      if (s.text) rule.text = s.text;
      if (s.or) rule.or = true;
      if (def.input === "text") rule.target = s.raw;
      else if (s.raw) {
        try {
          rule.target = await toTarget(s.raw, def.input);
        } catch (e) {
          problems.push(`${def.name}: ${(e as Error).message}`);
        }
      }
      built.push(rule);
    }
    if (c.steps.length > MAX_RULES) problems.push(`A campaign holds ${MAX_RULES} steps, so the rest were left out.`);
    // a follow with no account named means the author of the first post
    const firstPost = built.find((r) => ruleDef(r.kind).input === "post" && r.target)?.target;
    for (const r of built) if (r.kind === 2 && !r.target && firstPost) r.target = parseAtUri(firstPost)!.did;
    spec.rules = built;
    if (c.reward) spec.reward = toMicro(c.reward).toString();
    if (c.budget) spec.budget = toMicro(c.budget).toString();
    if (c.days) spec.days = c.days;
    if (c.rounds) spec.rounds = c.rounds;
    if (c.roundDays) spec.roundDays = c.roundDays;
    if (c.rounds && !c.days) spec.days = Math.max(spec.days, c.rounds * (c.roundDays ?? spec.roundDays) + 1);
    drawMoney();
    drawBoard();
    refresh();
    await hydrate();
    replace(magicOut,
      h("p", { class: "muted" }, `Built ${built.length} step${built.length === 1 ? "" : "s"}. Check them below.`),
      problems.map((p) => h("p", { class: "fielderr" }, p)));
  }
  const moneyBox = h("div", { class: "fields" });
  const advBox = h("div", { class: "fields", style: "margin-top:14px" });
  function drawMoney(): void {
    replace(moneyBox,
      amount(`Each person earns (${unit})`, "Ignored when using an allocation list.", "reward"),
      amount(`Total pool (${unit})`, "The most you can spend. Locked until the close date.", "budget"),
      num("Opens in (days)", "0 opens at once.", () => String(spec.startsInDays), (v) => { spec.startsInDays = Number(v) || 0; }),
      num("Open for (days)", "After this, the funder can take back what's left.", () => String(spec.days), (v) => { spec.days = Number(v) || 0; }),
    );
    replace(advBox,
      num("Rounds", "1 pays once. More pays repeatedly, for up to 52 rounds.", () => String(spec.rounds), (v) => { spec.rounds = Number(v) || 0; }),
      num("Days between rounds", "Each round needs a new post and fresh proofs.", () => String(spec.roundDays), (v) => { spec.roundDays = Number(v) || 0; }),
      amount(`Referral bonus (${unit})`, "Paid to whoever referred a new claimant. 0 turns it off.", "bonus"),
      num("Referrals per person", "The most one account can earn from.", () => String(spec.maxReferrals), (v) => { spec.maxReferrals = Number(v) || 0; }),
    );
  }

  // ---- drag: pointer events rather than HTML5 drag, which doesn't work on touch screens ----------------
  function dropIndex(y: number): number {
    const boxes = [...board.querySelectorAll<HTMLElement>(".stepbox")];
    for (let i = 0; i < boxes.length; i++) {
      const r = boxes[i]!.getBoundingClientRect();
      if (y < r.top + r.height / 2) return i;
    }
    return boxes.length;
  }

  function startDrag(down: PointerEvent, source: Source, el: HTMLElement): void {
    if (down.button !== 0) return;
    const startX = down.clientX;
    const startY = down.clientY;
    let ghost: HTMLElement | null = null;
    let line: HTMLElement | null = null;
    let target = -1;
    const pointer = down.pointerId;
    let last: PointerEvent = down;
    // keeps scrolling while the pointer rests near an edge, so a long board stays reachable
    const scroller = setInterval(() => {
      if (!ghost) return;
      const dy = last.clientY < 110 ? -12 : last.clientY > innerHeight - 70 ? 12 : 0;
      if (dy) {
        scrollBy(0, dy);
        place(last);
      }
    }, 24);

    const cleanup = () => {
      clearInterval(scroller);
      removeEventListener("pointermove", onMove);
      removeEventListener("pointerup", onUp);
      removeEventListener("pointercancel", onCancel);
      ghost?.remove();
      line?.remove();
      board.classList.remove("over");
      document.body.classList.remove("dragging");
      el.classList.remove("lifted");
    };
    const place = (e: PointerEvent) => {
      const r = board.getBoundingClientRect();
      const inside = e.clientX >= r.left - 40 && e.clientX <= r.right + 40 && e.clientY >= r.top - 40 && e.clientY <= r.bottom + 40;
      board.classList.toggle("over", inside);
      target = inside ? dropIndex(e.clientY) : -1;
      if (!line) return;
      line.style.display = inside ? "block" : "none";
      if (!inside) return;
      const boxes = [...board.querySelectorAll<HTMLElement>(".stepbox")];
      const y = !boxes.length ? 8 : target < boxes.length ? boxes[target]!.getBoundingClientRect().top - r.top - 6 : boxes[boxes.length - 1]!.getBoundingClientRect().bottom - r.top + 5;
      line.style.top = `${y}px`;
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      last = e;
      if (!ghost) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < 6) return;
        ghost = h("div", { class: "dragghost" }, source.type === "new" ? `${iconOf(source.kind)} ${labelOf(source.kind)}` : `${iconOf(spec.rules[source.index]!.kind)} ${labelOf(spec.rules[source.index]!.kind)}`);
        line = h("div", { class: "dropline" });
        board.appendChild(line);
        document.body.appendChild(ghost);
        document.body.classList.add("dragging");
        if (source.type === "move") el.classList.add("lifted");
      }
      e.preventDefault();
      ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 8}px)`;
      place(e);
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      const dragged = !!ghost;
      if (dragged) place(e);
      const at = target;
      cleanup();
      if (!dragged) {
        // a press without movement: palette tiles add at the end, handles do nothing
        if (source.type === "new") addStep(source.kind);
        return;
      }
      if (at < 0) return;
      if (source.type === "new") addStep(source.kind, at);
      else moveStep(source.index, at > source.index ? at - 1 : at);
    };
    const onCancel = (e: PointerEvent) => {
      if (e.pointerId === pointer) cleanup();
    };
    addEventListener("pointermove", onMove, { passive: false });
    addEventListener("pointerup", onUp);
    addEventListener("pointercancel", onCancel);
    down.preventDefault();
  }

  replace(palette, ["claimant", "voucher"].map((side) => [
    h("span", { class: "palhead" }, side === "claimant" ? "What they do" : "Who vouches for them"),
    PALETTE.filter((p) => ruleDef(p.kind).side === side).map((p) => {
      const b = h("button", { class: "paltile", type: "button", title: ruleDef(p.kind).help }, h("span", { class: "ico", "aria-hidden": "true" }, p.icon), h("span", null, p.label));
      b.addEventListener("pointerdown", (e) => startDrag(e, { type: "new", kind: p.kind }, b));
      // Keyboard activation has no pointer press; a pointer press is handled on release above.
      b.addEventListener("click", (e) => { if (e.detail === 0) addStep(p.kind); });
      return b;
    }),
  ]));

  function snapshotField(rule: Rule): HTMLElement {
    const toLocal = (us?: number) => (us ? new Date(us / 1000).toISOString().slice(0, 16) : "");
    return h("label", { class: "field" }, "Snapshot (optional)",
      h("input", { type: "datetime-local", value: toLocal(rule.snapshot), onchange: (e: Event) => { const v = (e.target as HTMLInputElement).value; rule.snapshot = v ? new Date(`${v}Z`).getTime() * 1000 : undefined; drawSide(); } }),
      h("small", null, "UTC. Proofs must come from the voucher's commits at or after this time. Set it when the list is final."));
  }

  const num = (label: string, hint: string, get: () => string, set: (v: string) => void) =>
    h("label", { class: "field" }, label,
      h("input", { value: get(), inputmode: "decimal", oninput: (e: Event) => { set((e.target as HTMLInputElement).value); drawSide(); autosave(); } }),
      h("small", null, hint));

  const amountError = { reward: "", budget: "", bonus: "" };
  const amount = (label: string, hint: string, key: "reward" | "budget" | "bonus") =>
    num(label, hint, () => fromMicro(spec[key]).replace(/,/g, ""), (v) => {
      try {
        spec[key] = toMicro(v || "0").toString();
        amountError[key] = "";
      } catch {
        amountError[key] = `${label}: use a plain number with at most 6 decimals.`;
      }
    });

  const allocationStatus = h("div", { class: "muted small-text" });
  async function applyAllocations(): Promise<void> {
    allocationStatus.textContent = "Resolving accounts…";
    proofs = null;
    try {
      const lines = parseAllocationLines(allocationText);
      if (lines.length > 2000) throw new Error("Use the script for lists over 2,000 lines. The browser would hit Bluesky's rate limit.");
      const list: Allocation[] = [];
      for (const [i, l] of lines.entries()) {
        const did = l.who.startsWith("did:plc:") ? l.who : (await resolveActor(l.who)).did;
        list.push({ did, amount: l.amount.toString() });
        if (i % 20 === 0) allocationStatus.textContent = `Resolving accounts… ${i + 1}/${lines.length}`;
      }
      const tree = await buildAllocationTree(list);
      spec.root = tree.root;
      spec.allocations = list;
      proofs = tree.proofs;
      const total = list.reduce((n, a) => n + BigInt(a.amount), 0n);
      replace(allocationStatus, `${list.length} accounts, ${fromMicro(total)} ${unit} in total. Root ${tree.root.slice(0, 16)}… `,
        h("button", { class: "btn small ghost", type: "button", onclick: () => download("allocation-proofs.json", JSON.stringify({ root: tree.root, proofs: tree.proofs }, null, 2)) }, "Download proofs"));
    } catch (e) {
      spec.root = undefined;
      spec.allocations = undefined;
      allocationStatus.textContent = (e as Error).message;
    }
    drawSide();
  }

  const allocationPanel = h("div", { style: "display:grid;gap:10px" });
  function drawAllocation(): void {
    replace(allocationPanel,
      h("label", { class: "row", style: "gap:9px;font-size:14px;font-weight:600" }, h("input", { type: "checkbox", style: "width:auto;min-height:0", checked: useAllocation.on, onchange: (e: Event) => { useAllocation.on = (e.target as HTMLInputElement).checked; if (!useAllocation.on) { spec.root = undefined; spec.allocations = undefined; } drawAllocation(); drawSide(); } }), "Pay each account its own amount"),
      useAllocation.on && h("label", { class: "field" }, "Who gets what",
        h("textarea", { class: "mono", rows: "6", placeholder: "alice.bsky.social, 25\nbob.example.com, 10.5\ndid:plc:…, 100", oninput: (e: Event) => { allocationText = (e.target as HTMLTextAreaElement).value; } }, allocationText),
        h("small", null, "One account per line. Only a 32-byte fingerprint of the list goes on-chain, so size doesn't matter. Publish the list so anyone can check it.")),
      useAllocation.on && h("div", { class: "row" }, h("button", { class: "btn small ghost", type: "button", onclick: applyAllocations }, "Build list"), allocationStatus),
    );
  }

  let whatIf = -1;
  function drawSide(): void {
    const problems = [...Object.values(amountError).filter(Boolean).map((text) => ({ level: "error" as const, text })), ...validate(spec)];
    const blocking = problems.filter((p) => p.level === "error");
    const exp = useAllocation.on && !spec.root ? { level: "Low" as const, why: "Only the accounts on your list will be able to claim." } : exposure(spec);
    let proj: ReturnType<typeof project> | null = null;
    try {
      proj = project(spec);
    } catch {
      proj = null;
    }
    const link = `${location.origin}/c/preview#${encodeSpec(spec)}`;
    const overBudget = proj && spec.root && proj.allocated > BigInt(spec.budget || "0");

    // the slider keeps its place while everything around it redraws
    const cap = proj ? Number(proj.maxClaimants > 100000n ? 100000n : proj.maxClaimants) : 0;
    whatIf = Math.min(whatIf < 0 ? Math.round(cap / 2) : whatIf, cap);
    const perHead = proj ? (spec.root && proj.maxClaimants > 0n ? proj.allocated / proj.maxClaimants : proj.perClaimant) : 0n;
    const budgetNum = BigInt(spec.budget || "0");
    const whatIfOut = h("div", { class: "whatifout" });
    const drawWhatIf = () => {
      const spent = perHead * BigInt(whatIf);
      const left = budgetNum > spent ? budgetNum - spent : 0n;
      const pct = budgetNum > 0n ? Math.min(100, Number((spent * 1000n) / budgetNum) / 10) : 0;
      replace(whatIfOut,
        h("div", { class: "meter big" }, h("i", { style: `width:${pct}%` })),
        h("p", { class: "muted small-text" }, h("strong", null, whatIf.toLocaleString("en-US")), ` ${whatIf === 1 ? "person claims" : "people claim"}: ${fromMicro(spent)} ${unit} paid, ${fromMicro(left)} ${unit} comes back to you.`));
    };
    drawWhatIf();

    replace(preview,
      h("div", { class: "questcard" },
        questArt(spec.name, spec.rules),
        h("div", { class: "questbody" },
          h("span", { class: "tag" }, "what people will see"),
          h("h3", null, spec.name || "Your campaign"),
          h("p", { class: "questreward" }, spec.root ? "Listed amounts" : `${fromMicro(proj?.perClaimant ?? 0n)} ${unit}`),
          h("p", { class: "muted small-text" }, spec.rules.length ? `${summarize(spec.rules)[0]!.toUpperCase()}${summarize(spec.rules).slice(1)}.` : "Add steps to see them here."),
        ),
      ),
      cap > 0 ? h("div", { class: "panel" },
        h("h2", null, "What if…"),
        h("input", { type: "range", min: "0", max: String(cap), value: whatIf, "aria-label": "How many people claim", oninput: (e: Event) => { whatIf = Number((e.target as HTMLInputElement).value); drawWhatIf(); } }),
        whatIfOut,
      ) : null,
      h("div", { class: "panel" },
        h("h2", null, "What this campaign does"),
        proj && h("dl", { class: "statlist" },
          spec.root
            ? [row("Accounts on the list", String(proj.maxClaimants)), row("Listed total", `${fromMicro(proj.allocated)} ${unit}`)]
            : [row("Each person earns", `${fromMicro(proj.perClaimant)} ${unit}`), row("Pool covers", `${proj.maxClaimants.toLocaleString("en-US")} people`)],
          BigInt(spec.bonus || "0") > 0n && spec.maxReferrals > 0 ? row("Top referrer earns", `+${fromMicro(BigInt(spec.bonus) * BigInt(spec.maxReferrals))} ${unit}`) : null,
          row("Open for", `${spec.days} days, about ${Math.round(spec.days * EPOCHS_PER_DAY).toLocaleString("en-US")} epochs`),
          row("Your maximum cost", `${fromMicro(spec.budget || "0")} ${unit}`),
        ),
        overBudget ? h("p", { class: "note bad", style: "margin:0" }, "The pool is smaller than the list. Late claimers would find it empty.") : null,
        h("p", { class: "muted small-text" }, "Unclaimed funds come back after the campaign closes. The epoch estimate assumes about one epoch an hour."),
      ),
      h("div", { class: "panel" },
        h("h2", null, "Farming risk"),
        exposurePill(exp.level),
        h("p", { class: "muted small-text" }, exp.why),
      ),
      proj && h("div", { class: "panel" },
        h("h2", null, "Fits in a transaction?"),
        h("div", { class: "meter", role: "img", "aria-label": `${Math.round(proj.computeShare * 100)} percent of the compute limit` }, h("i", { style: `width:${Math.min(100, proj.computeShare * 100).toFixed(1)}%` })),
        h("p", { class: "muted small-text" }, `A claim takes about ${Math.round(proj.computeM)}M of the ${POINTS_LIMIT}M compute limit, measured with common keys and a one-operation identity log. Accounts with long logs or P-256 keys cost more.`),
      ),
      problems.length ? h("div", { class: "panel" }, h("h2", null, blocking.length ? "Before this can launch" : "Worth a look"), h("ul", { class: "problems" }, problems.map((p) => h("li", { class: p.level }, p.text)))) : null,
      h("div", { class: "panel" },
        h("h2", null, "Take it further"),
        blocking.length
          ? h("p", { class: "muted small-text" }, "Fix the items above to unlock the preview and the launch files.")
          : [
              h("a", { class: "btn primary", href: `/c/preview#${encodeSpec(spec)}` }, "Preview the claim page"),
              h("p", { class: "muted small-text" }, "Test the rules against any real account. No funds involved. Participants follow their progress and claim on Skydrop."),
              h("div", { class: "row" },
                copyButton(() => participantLink(encodeSpec(spec)), "Copy link for participants"),
                copyButton(() => link, "Copy preview link"),
                h("button", { class: "btn small ghost", type: "button", onclick: () => download(`${slug(spec.name)}.campaign.json`, JSON.stringify({ spec, create: createArgs(spec, 0, "<your key>", DEPLOYMENT.linkRegistry || "<link registry>"), proofs }, null, 2)) }, "Download manifest"),
              ),
              isPublished()
                ? h("p", { class: "muted small-text" }, "Launch with: node scripts/create-campaign.mjs manifest.json")
                : h("p", { class: "note warn", style: "margin:0" }, h("strong", null, "Can't be funded yet."), " The contract isn't published on the network, so this stops at the preview and manifest."),
            ],
      ),
    );
  }

  drawMoney();
  drawBoard();
  drawAllocation();
  refresh();
  void hydrate();

  function markEdited(e: Event): void {
    // links and the preview panel don't count as editing
    if ((e.target as Element).closest?.(".side")) return;
    edited = true;
  }

  const advancedOpen = !!(pb?.rounds || pb?.bonus || pb?.usesAllocation);

  return {
    title: "Campaign builder",
    body: h("div", { class: "wrap" },
      announcer,
      pageHead("Campaign builder", pb ? `Start from: ${pb.name}` : "Build your campaign", pb ? pb.how : "Drag steps onto the board and paste a post into each. Like one post, repost another, follow someone: a claim has to prove every step."),
      pb ? h("div", { class: "note warn", style: "margin:-8px 0 24px" }, h("strong", null, "Where this can be gamed: "), pb.caution) : null,
      earlier ? h("div", { class: "note", style: "margin:-8px 0 24px" }, h("strong", null, "Pick up where you left off? "), `“${earlier.spec.name || "Untitled"}”, edited ${timeAgo(earlier.updated)}. `, h("a", { href: `/campaigns/new?draft=${earlier.id}` }, "Continue it"), " or see ", h("a", { href: "/me" }, "all your campaigns"), ".") : null,
      h("div", { class: "panel magicbox" },
        h("h2", null, "Describe it, and the board builds itself"),
        magicInput,
        h("div", { class: "row" },
          h("button", { class: "btn primary small", type: "button", onclick: () => void buildFromWords(magicInput.value) }, "Build it"),
          h("button", { class: "chip mini", type: "button", onclick: () => { magicInput.value = EXAMPLES[0]!; magicInput.focus(); } }, "Example"),
          h("button", { class: "chip mini", type: "button", onclick: () => { magicInput.value = EXAMPLES[1]!; magicInput.focus(); } }, "Three posts"),
          h("button", { class: "chip mini", type: "button", onclick: () => { magicInput.value = EXAMPLES[2]!; magicInput.focus(); } }, "With wording"),
        ),
        magicOut,
      ),
      h("div", { class: "builder", onpointerdown: markEdited, oninput: markEdited, onchange: markEdited, onkeydown: markEdited },
        h("div", null,
          h("div", { class: "panel" },
            h("div", { class: "row", style: "justify-content:space-between" }, h("h2", { style: "font:700 16.5px var(--body)" }, "1. Build the steps"), h("div", { class: "row" }, saveNote, undoBtn)),
            palette,
            board,
            sentence,
            h("p", { class: "muted small-text" }, `Up to ${MAX_RULES} steps. Click “and” between two steps to make them either/or. People can do the steps in any order: the contract can check that each one happened, not which came first.`),
          ),
          h("div", { class: "panel" },
            h("h2", null, "2. Set the reward"),
            moneyBox,
          ),
          h("div", { class: "panel" },
            h("h2", null, "3. Name it"),
            h("label", { class: "field" }, "Name", nameInput),
            h("label", { class: "field" }, "What it's for (optional)", h("textarea", { rows: "2", maxlength: "256", oninput: (e: Event) => { spec.about = (e.target as HTMLTextAreaElement).value; autosave(); } }, spec.about), h("small", null, "Shown on the claim page.")),
          ),
          h("details", { class: "panel more", open: advancedOpen },
            h("summary", null, "Advanced: repeat rounds, referrals, per-person amounts"),
            advBox,
            h("div", { style: "margin-top:14px" }, allocationPanel),
          ),
        ),
        preview,
      ),
    ),
  };
}
