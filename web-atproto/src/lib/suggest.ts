/** Suggests Bluesky accounts as someone types, so nobody has to remember their exact handle. Works with the keyboard and
 * screen readers. Suggestions are a convenience: picking one only fills in the handle, which is looked up as usual. */
import "./suggest.css";
import { h, replace } from "./dom";

interface Suggestion { handle: string; displayName?: string; avatar?: string }

const API = "https://public.api.bsky.app/xrpc/app.bsky.actor.searchActorsTypeahead";
let nextId = 0;

async function search(q: string): Promise<Suggestion[]> {
  const r = await fetch(`${API}?q=${encodeURIComponent(q)}&limit=6`, { signal: AbortSignal.timeout(6000) });
  if (!r.ok) return [];
  const j = (await r.json()) as { actors?: Suggestion[] };
  return j.actors ?? [];
}

/** `onPick` runs when an account is chosen. The input's parent must be positioned, which `.suggestwrap` does. */
export function attachSuggest(input: HTMLInputElement, onPick: (handle: string) => void): void {
  const id = `suggest-${++nextId}`;
  const list = h("ul", { class: "suggest", id, role: "listbox", "aria-label": "Matching Bluesky accounts", hidden: true });
  input.parentElement!.classList.add("suggestwrap");
  input.parentElement!.append(list);
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", id);
  input.setAttribute("aria-expanded", "false");

  let items: Suggestion[] = [];
  let active = -1;
  let timer = 0;
  let latest = 0;

  const close = (): void => {
    latest++;
    clearTimeout(timer);
    items = [];
    active = -1;
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  };

  const pick = (s: Suggestion): void => {
    input.value = s.handle;
    close();
    onPick(s.handle);
  };

  const draw = (): void => {
    replace(list, items.map((s, i) => {
      const li = h("li", { id: `${id}-${i}`, role: "option", class: "suggestitem", "aria-selected": i === active ? "true" : "false" },
        s.avatar ? h("img", { src: s.avatar, alt: "", width: "28", height: "28", loading: "lazy", referrerpolicy: "no-referrer" }) : h("span", { class: "suggestblank", "aria-hidden": "true" }),
        h("span", { class: "suggesttext" }, s.displayName ? h("strong", null, s.displayName) : null, h("small", null, `@${s.handle}`)));
      // pointerdown, so choosing doesn't blur the field and close the list first
      li.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        pick(s);
      });
      return li;
    }));
    list.hidden = !items.length;
    input.setAttribute("aria-expanded", String(!!items.length));
    if (active >= 0) input.setAttribute("aria-activedescendant", `${id}-${active}`);
    else input.removeAttribute("aria-activedescendant");
  };

  input.addEventListener("input", () => {
    const q = input.value.trim().replace(/^@/, "");
    clearTimeout(timer);
    if (q.length < 2 || q.startsWith("did:") || q.includes("/")) {
      close();
      return;
    }
    const mine = ++latest;
    timer = window.setTimeout(() => {
      void search(q).catch(() => [] as Suggestion[]).then((found) => {
        // a slower, older answer must not replace a newer one
        if (mine !== latest) return;
        items = found;
        active = -1;
        draw();
      });
    }, 160);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (items.length) e.preventDefault();
      close();
    } else if (e.key === "Enter") {
      // with nothing highlighted, Enter submits exactly what was typed
      if (active >= 0 && items[active]) {
        e.preventDefault();
        pick(items[active]!);
      } else {
        close();
      }
    } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && items.length) {
      e.preventDefault();
      active = e.key === "ArrowDown" ? (active + 1) % items.length : (active - 1 + items.length) % items.length;
      draw();
    }
  });
  input.addEventListener("blur", close);
}
