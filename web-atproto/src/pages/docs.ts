import architecture from "../docs/architecture.html?raw";
import campaign from "../docs/campaign.html?raw";
import integrate from "../docs/integrate.html?raw";
import overview from "../docs/overview.html?raw";
import security from "../docs/security.html?raw";
import skydrop from "../docs/skydrop.html?raw";
import { h } from "../lib/dom";
import type { Page } from "../main";

const PAGES: { slug: string; title: string; html: string }[] = [
  { slug: "", title: "Overview", html: overview },
  { slug: "campaign", title: "Campaign contract", html: campaign },
  { slug: "architecture", title: "Architecture", html: architecture },
  { slug: "integrate", title: "Integration guide", html: integrate },
  { slug: "security", title: "Trust boundaries", html: security },
  { slug: "skydrop", title: "Skydrop", html: skydrop },
];

export function docsPage(slug: string): Page {
  const page = PAGES.find((p) => p.slug === slug.replace(/^\/+/, ""));
  const nav = h("nav", { class: "docnav", "aria-label": "Docs" }, PAGES.map((p) => h("a", { href: p.slug ? `/docs/${p.slug}` : "/docs", "aria-current": p === page ? "page" : undefined }, p.title)));
  const article = h("article", { class: "doc" });
  // First-party content written in this repo, never user data.
  article.innerHTML = page ? page.html : "<h1>That doc doesn't exist</h1><p>Pick one from the list.</p>";
  return { title: page ? `${page.title} docs` : "Docs", body: h("div", { class: "wrap docs" }, nav, article) };
}
