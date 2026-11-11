import "./styles.css";
import { append, clear, h, replace } from "./lib/dom";
import { initMotion, pageChange, themeChange } from "./lib/motion";
import { builderPage } from "./pages/builder";
import { campaignPage } from "./pages/campaign";
import { campaignsPage } from "./pages/campaigns";
import { docsPage } from "./pages/docs";
import { connectWallet, friendly, onWallet, shortAddress, silentConnect } from "./lib/wallet";
import { watchForMainnet } from "./lib/cutover";
import { DEPLOYMENT } from "./data/deployment";
import { homePage } from "./pages/home";
import { mePage } from "./pages/me";
import { statusPage } from "./pages/status";
import { tipsPage } from "./pages/tips";
import { useCasesPage } from "./pages/usecases";
import { verifyPage } from "./pages/verify";

export type Page = { title: string; body: Node };

const NAV = [
  ["/campaigns", "Campaigns"],
  ["/me", "My campaigns"],
  ["/tips", "Send a gift"],
  ["/verify", "Live proof"],
  ["/docs", "Docs"],
] as const;

function route(path: string): Page {
  const p = path.replace(/\/+$/, "") || "/";
  if (p === "/") return homePage();
  if (p === "/campaigns") return campaignsPage();
  if (p === "/campaigns/new") return builderPage();
  if (p.startsWith("/c/")) return campaignPage(p.slice(3));
  if (p === "/me") return mePage();
  if (p === "/tips") return tipsPage();
  if (p === "/verify") return verifyPage();
  if (p === "/use-cases") return useCasesPage();
  if (p === "/docs" || p.startsWith("/docs/")) return docsPage(p.slice(6));
  if (p === "/status") return statusPage();
  return {
    title: "Not found",
    body: h("div", { class: "wrap narrow notfound" }, h("h1", null, "That page doesn't exist"), h("p", { class: "lede" }, "It may have moved when the site was rebuilt."), h("a", { class: "btn primary", href: "/" }, "Back to the start")),
  };
}

const app = document.getElementById("app")!;
const chip = h("div", { class: "walletchip" });
onWallet((w) => {
  if (w.connected) {
    replace(chip, h("a", { class: "chipbtn on", href: "/me", title: w.address ?? w.account ?? "" }, h("span", { class: "dot2", "aria-hidden": "true" }), shortAddress(w.address ?? w.account ?? "").slice(0, 16)));
  } else if (w.available) {
    replace(chip, h("button", { class: "chipbtn", type: "button", onclick: async () => { try { await connectWallet(); } catch (e) { alertInline(friendly(e)); } } }, `Connect ${w.name}`));
  } else {
    replace(chip);
  }
});
void silentConnect();
watchForMainnet();
function alertInline(text: string): void {
  const t = h("div", { class: "toast", role: "status" }, text);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4200);
}
const main = h("main", { id: "main", tabindex: "-1" });

function themeButton(): HTMLButtonElement {
  const b = h("button", { class: "iconbtn", type: "button", "aria-label": "Switch between light and dark" }, "◐");
  b.addEventListener("click", () => {
    const root = document.documentElement;
    const dark = root.getAttribute("data-theme") ? root.getAttribute("data-theme") === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "light" : "dark";
    themeChange(b, () => root.setAttribute("data-theme", next));
    try {
      localStorage.setItem("atp-theme", next);
    } catch {
      /* private window: theme just won't be remembered */
    }
  });
  return b;
}

const links = h("nav", { class: "links", "aria-label": "Main" }, NAV.map(([href, text]) => h("a", { href, "data-nav": href }, text)));
const menu = h("button", { class: "iconbtn menu", type: "button", "aria-label": "Menu", "aria-expanded": "false" }, "☰");
menu.addEventListener("click", () => {
  const open = links.classList.toggle("open");
  menu.setAttribute("aria-expanded", String(open));
});

append(app, [
  h("header", { class: "top" }, h("div", { class: "wrap bar" },
    h("a", { class: "brand", href: "/" }, h("span", { class: "dot" }), "atproto", h("span", { class: "sep" }, "·"), "ootle"),
    links,
    h("a", { class: "btn small primary cta", href: "/campaigns/new" }, "Start a campaign"),
    chip,
    themeButton(),
    menu,
  )),
  main,
  h("footer", { class: "foot" }, h("div", { class: "wrap footgrid" },
    h("div", null, h("strong", { class: "mono" }, "atproto · ootle"), h("p", null, `A trustless Bluesky identity layer for the Ootle VM. ${DEPLOYMENT.isMainnet ? "" : "Testnet only. "}Reviewed internally; no third-party audit yet.`)),
    h("div", null, h("h2", null, "Run"), h("a", { href: "/campaigns" }, "Playbooks"), h("a", { href: "/campaigns/new" }, "Campaign builder"), h("a", { href: "/tips" }, "Send a gift"), h("a", { href: "https://skydrop.tari.mw/quests" }, "Skydrop: track and claim")),
    h("div", null, h("h2", null, "Check"), h("a", { href: "/verify" }, "Live proof"), h("a", { href: "/status" }, "Status and tests"), h("a", { href: "/docs/security" }, "Trust boundaries")),
    h("div", null, h("h2", null, "Build"), h("a", { href: "/use-cases" }, "Use cases"), h("a", { href: "/docs/integrate" }, "Integration guide"), h("a", { href: "/docs/campaign" }, "Campaign reference"), h("a", { href: "https://github.com/chironbuilds/skydrop" }, "Source")),
  )),
]);

const header = app.querySelector<HTMLElement>(".top")!;
addEventListener("scroll", () => header.classList.toggle("scrolled", scrollY > 8), { passive: true });

function render(): void {
  pageChange(paint);
}

function paint(): void {
  links.classList.remove("open");
  menu.setAttribute("aria-expanded", "false");
  const path = location.pathname;
  let page: Page;
  try {
    page = route(path);
  } catch (e) {
    console.error(e);
    page = { title: "Something went wrong", body: h("div", { class: "wrap narrow notfound" }, h("h1", null, "This page couldn't load"), h("p", { class: "lede" }, (e as Error).message)) };
  }
  clear(main);
  main.appendChild(page.body);
  document.title = page.title === "ATProto for Ootle" ? page.title : `${page.title} · ATProto for Ootle`;
  for (const a of links.querySelectorAll("a")) {
    const nav = a.getAttribute("data-nav")!;
    if (path === nav || path.startsWith(`${nav}/`)) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  if (location.hash && !location.pathname.startsWith("/c/") && !location.pathname.startsWith("/campaigns/new")) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  else scrollTo(0, 0);
}

/** Internal links change pages without a reload, so the WASM verifier and fetched data stay in memory. */
document.addEventListener("click", (e) => {
  const a = (e.target as Element).closest?.("a");
  if (!a || a.target || a.hasAttribute("download") || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin) return;
  if (url.pathname === location.pathname && url.hash) return;
  e.preventDefault();
  history.pushState(null, "", url.pathname + url.search + url.hash);
  render();
});
addEventListener("popstate", render);

paint();
initMotion(main);
