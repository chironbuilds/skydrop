import { contractsOnNetwork, DEPLOYMENT, isPublished } from "../data/deployment";
import { questArt } from "../lib/art";
import { encodeSpec, fromMicro, summarize } from "../lib/campaign";
import { h, pageHead, pill, replace } from "../lib/dom";
import { campaignFromTx, listCreated, phaseOf, type ChainCampaign } from "../lib/chain";
import { allDrafts, deleteDraft, timeAgo, type Draft } from "../lib/library";
import { connectWallet, disconnectWallet, friendly, onWallet, shortAddress, walletBalance, type WalletState } from "../lib/wallet";
import type { Page } from "../main";

function draftCard(d: Draft, redraw: () => void): HTMLElement {
  const s = d.spec;
  const del = h("button", { class: "btn small ghost", type: "button" }, "Delete");
  del.addEventListener("click", () => {
    if (del.dataset.armed) {
      deleteDraft(d.id);
      redraw();
      return;
    }
    del.dataset.armed = "1";
    del.textContent = "Tap again to delete";
    setTimeout(() => {
      delete del.dataset.armed;
      del.textContent = "Delete";
    }, 3000);
  });
  return h("div", { class: "questcard small" },
    questArt(s.name, s.rules),
    h("div", { class: "questbody" },
      h("h3", null, s.name || "Untitled campaign"),
      h("p", { class: "muted small-text" }, s.rules.length ? `${summarize(s.rules)}.` : "No steps yet."),
      h("p", { class: "muted small-text" }, `${fromMicro(s.reward)} tTARI each · pool ${fromMicro(s.budget)} · edited ${timeAgo(d.updated)}`),
      h("div", { class: "row" },
        h("a", { class: "btn small primary", href: `/campaigns/new?draft=${d.id}` }, "Keep editing"),
        h("a", { class: "btn small ghost", href: `/c/preview#${encodeSpec(s)}` }, "Preview"),
        del,
      ),
    ));
}

function liveCard(c: ChainCampaign): HTMLElement {
  const phase = phaseOf(c);
  return h("a", { class: "card", href: `/c/${c.component}` },
    pill(phase === "open" ? "ok" : phase === "upcoming" ? "info" : "plain", phase === "open" ? "Open" : phase === "upcoming" ? "Not open yet" : "Closed"),
    h("h3", null, c.name),
    h("p", null, `${c.claimants.toLocaleString("en-US")} claimed · ${fromMicro(c.paid)} paid · ${fromMicro(c.balance)} left in the pool`),
    phase === "closed" && c.balance > 0n ? h("p", { class: "muted small-text" }, "It has closed. Open it to take back what's left.") : null,
  );
}

export function mePage(): Page {
  const walletBox = h("div");
  const mine = h("div");
  const elsewhere = h("div");
  const liveBox = h("div");
  let current: WalletState | null = null;

  function drawDrafts(): void {
    const all = allDrafts();
    const key = current?.key ?? null;
    const own = key ? all.filter((d) => d.owner === key) : all.filter((d) => !d.owner);
    const other = key ? all.filter((d) => d.owner !== key) : all.filter((d) => d.owner);
    replace(mine,
      own.length
        ? h("div", { class: "questgrid" }, own.map((d) => draftCard(d, drawDrafts)))
        : h("div", { class: "note" }, h("strong", null, "Nothing here yet."), " Campaigns you design save themselves automatically. ", h("a", { href: "/campaigns/new" }, "Build your first one")),
    );
    replace(elsewhere,
      other.length
        ? [h("h3", { style: "margin-top:26px" }, key ? `Saved without this wallet (${other.length})` : `Saved under a wallet (${other.length})`), h("div", { class: "questgrid", style: "margin-top:12px" }, other.map((d) => draftCard(d, drawDrafts)))]
        : null,
    );
  }

  let liveFor: string | null | undefined;
  async function drawLive(key: string | null): Promise<void> {
    if (!isPublished() || key === liveFor) return;
    liveFor = key;
    if (!key) {
      replace(liveBox, h("p", { class: "muted" }, "Connect your wallet to see the campaigns it has funded."));
      return;
    }
    replace(liveBox, h("p", { class: "muted" }, "Reading the network…"));
    try {
      const mine = (await listCreated()).filter((e) => e.funder === key).slice(0, 24);
      // the event only claims a funder, so the contract's own state decides
      const read = (await Promise.all(mine.map((e) => campaignFromTx(e.tx).catch(() => null)))).filter((c): c is ChainCampaign => !!c && c.funder === key);
      if (liveFor !== key) return;
      replace(liveBox, read.length
        ? h("div", { class: "grid g3", style: "margin-top:12px" }, read.map(liveCard))
        : h("p", { class: "muted" }, "This wallet hasn't funded a campaign yet. Finish a draft below and launch it."));
    } catch {
      if (liveFor === key) replace(liveBox, h("p", { class: "muted" }, "The network couldn't be read just now. Refresh to try again."));
    }
  }

  function drawWallet(s: WalletState): void {
    current = s;
    void drawLive(s.connected ? s.key : null);
    const err = h("p", { class: "fielderr" });
    if (!s.available) {
      replace(walletBox, h("div", { class: "card" },
        h("h3", null, "Connect your wallet"),
        h("p", null, "Sapient isn't installed in this browser. You can still design campaigns here; they're saved in this browser. To tie them to your wallet and fund them later, add Sapient."),
        h("div", { class: "row" }, h("a", { class: "btn ghost small", href: "https://sapient.tari.mw", target: "_blank", rel: "noopener noreferrer" }, "Get Sapient")),
      ));
    } else if (!s.connected) {
      replace(walletBox, h("div", { class: "card" },
        h("h3", null, `Connect ${s.name}`),
        h("p", null, "This shows your address to this site so it can file your campaigns under your wallet. Connecting spends nothing, and your keys stay in the wallet."),
        h("div", { class: "row" }, h("button", { class: "btn primary small", type: "button", onclick: async () => { try { await connectWallet(); } catch (e) { err.textContent = friendly(e); } } }, `Connect ${s.name}`)),
        err,
      ));
    } else {
      const bal = h("span", { class: "mono" }, "…");
      void walletBalance().then((b) => { bal.textContent = b === null ? "unknown" : `${fromMicro(b)} tTARI`; });
      const wrongNet = s.network && s.network !== "esmeralda";
      replace(walletBox, h("div", { class: "card" },
        h("span", { class: "tag" }, `connected · ${s.name}`),
        h("h3", { class: "mono", style: "word-break:break-all" }, s.address ? shortAddress(s.address) : s.account!),
        h("p", null, "Spendable balance: ", bal),
        wrongNet ? h("p", { class: "note warn", style: "margin:0" }, `Your wallet is on ${s.network}. Campaigns here run on ${DEPLOYMENT.network}.`) : null,
        h("div", { class: "row" }, h("button", { class: "btn ghost small", type: "button", onclick: () => void disconnectWallet() }, "Disconnect")),
      ));
    }
    drawDrafts();
  }

  if (!isPublished()) replace(liveBox, h("div", { class: "note" }, h("strong", null, "Nothing can be launched yet."), (contractsOnNetwork() ? " Funding from this site is still being built. Once it is, campaigns you fund will be listed here from on-chain records, with claims and what's left in the pool." : " The contract isn't published on the network. Once it is, campaigns you fund will be listed here from on-chain records, with claims and what's left in the pool.")));

  const stop = onWallet(drawWallet);
  // stop listening once this page is replaced
  const obs = new MutationObserver(() => { if (!walletBox.isConnected) { stop(); obs.disconnect(); } });
  queueMicrotask(() => { if (walletBox.parentElement) obs.observe(document.getElementById("main")!, { childList: true }); });

  return {
    title: "My campaigns",
    body: h("div", { class: "wrap" },
      pageHead("My campaigns", "Everything you've created", "Your drafts, and your live campaigns once they're funded. Drafts are private: they stay in this browser until you share a link."),
      walletBox,
      h("h2", { class: "big", style: "margin-top:40px" }, "Live"),
      liveBox,
      h("div", { class: "row", style: "justify-content:space-between;margin-top:40px" }, h("h2", { class: "big" }, "Drafts"), h("a", { class: "btn small primary", href: "/campaigns/new" }, "New campaign")),
      h("div", { style: "margin-top:16px" }, mine),
      elsewhere,
      h("div", { class: "spacer" }),
    ),
  };
}
