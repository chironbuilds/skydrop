/** Small DOM helpers. All user data goes through text nodes; raw HTML is only ever first-party docs. */
type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === "class") el.className = String(v);
    else if (k === "value") (el as unknown as HTMLInputElement).value = String(v);
    else if (k === "checked" || k === "disabled" || k === "selected" || k === "open") (el as unknown as Record<string, unknown>)[k] = !!v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function replace(el: Element, ...children: Child[]): void {
  clear(el);
  append(el, children);
}

/** Copy-to-clipboard button; says "Copied" for a moment. */
export function copyButton(text: () => string, label = "Copy"): HTMLButtonElement {
  const b = h("button", { class: "btn small ghost", type: "button" }, label);
  b.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text());
      b.textContent = "Copied";
    } catch {
      b.textContent = "Press Ctrl+C";
    }
    setTimeout(() => (b.textContent = label), 1500);
  });
  return b;
}

/** Saves text as a file. */
export function download(name: string, text: string, type = "application/json"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h("a", { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export const pill = (kind: "ok" | "warn" | "bad" | "info" | "plain", text: string): HTMLElement => h("span", { class: `pill ${kind}` }, text);

/** A page heading block. */
export const pageHead = (kicker: string, title: string, lede?: Child): HTMLElement =>
  h("header", { class: "pagehead" }, h("span", { class: "kicker" }, kicker), h("h1", null, title), lede ? h("p", { class: "lede" }, lede) : null);
