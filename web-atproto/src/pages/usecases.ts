import { STATUS_LABEL, STATUS_TEXT, USE_CASES, type UseStatus } from "../data/usecases";
import { h, pageHead, pill, replace } from "../lib/dom";
import type { Page } from "../main";

const KIND: Record<UseStatus, "ok" | "info" | "plain" | "warn"> = { campaign: "ok", policy: "info", buildable: "plain", attested: "warn" };
const ORDER: UseStatus[] = ["campaign", "policy", "buildable", "attested"];

export function useCasesPage(): Page {
  let status: UseStatus | "all" = "all";
  let area = "All";
  let query = "";
  const areas = ["All", ...new Set(USE_CASES.map((u) => u.area))];
  const grid = h("div", { class: "grid g3" });
  const chips = h("div", { class: "chips", role: "group", "aria-label": "Filter by readiness" });
  const areaChips = h("div", { class: "chips", role: "group", "aria-label": "Filter by area" });
  const count = h("p", { class: "muted small-text", style: "margin-top:16px", "aria-live": "polite" });

  const draw = () => {
    const q = query.trim().toLowerCase();
    const list = USE_CASES.filter((u) => (status === "all" || u.status === status) && (area === "All" || u.area === area) && (!q || `${u.name} ${u.text} ${u.uses}`.toLowerCase().includes(q)));
    count.textContent = `${list.length} of ${USE_CASES.length}`;
    replace(grid, list.length ? list.map((u) => {
      const inner = [
        pill(KIND[u.status], STATUS_LABEL[u.status]),
        h("h3", null, u.name),
        h("p", null, u.text),
        h("div", { class: "foot-line" }, u.uses),
      ];
      return u.playbook ? h("a", { class: "card", href: `/campaigns/new?playbook=${u.playbook}` }, inner) : h("div", { class: "card" }, inner);
    }) : h("p", { class: "muted" }, "Nothing matches. Try fewer filters."));
    replace(chips,
      h("button", { class: "chip", type: "button", "aria-pressed": String(status === "all"), onclick: () => { status = "all"; draw(); } }, "All"),
      ORDER.map((s) => h("button", { class: "chip", type: "button", "aria-pressed": String(status === s), title: STATUS_TEXT[s], onclick: () => { status = s; draw(); } }, `${STATUS_LABEL[s]} (${USE_CASES.filter((u) => u.status === s).length})`)));
    replace(areaChips, areas.map((a) => h("button", { class: "chip", type: "button", "aria-pressed": String(area === a), onclick: () => { area = a; draw(); } }, a)));
  };
  draw();

  return {
    title: "Use cases",
    body: h("div", { class: "wrap" },
      pageHead("Use cases", "What this can be used for", `${USE_CASES.length} ideas sorted by how ready they are, including the ones that can't be done trustlessly and what to use instead.`),
      h("div", { class: "tablewrap", style: "margin-top:0" }, h("table", null, h("tbody", null, ORDER.map((s) => h("tr", null, h("td", { style: "white-space:nowrap" }, pill(KIND[s], STATUS_LABEL[s])), h("td", { class: "muted" }, STATUS_TEXT[s])))))),
      h("label", { class: "field", style: "margin-top:24px;max-width:420px" }, "Search", h("input", { type: "search", placeholder: "airdrop, voting, service-auth…", oninput: (e: Event) => { query = (e.target as HTMLInputElement).value; draw(); } })),
      chips,
      areaChips,
      count,
      grid,
      h("div", { class: "spacer" }),
    ),
  };
}
