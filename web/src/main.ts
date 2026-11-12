import "./style.css";
import { IndexerProvider } from "@tari-project/ootle-indexer";
import { Network } from "@tari-project/ootle";
import { CONFIG, deployed } from "./config";
import * as bsky from "./bsky";
import * as chain from "./chain";
import { confetti, copy, h, icons, mount, short, spinnerLabel, stamp, toast } from "./dom";
import { toHex } from "./cbor";
import * as env from "./envelope";
import { attachSuggest } from "../../web-atproto/src/lib/suggest";
import { initMotion } from "../../web-atproto/src/lib/motion";
import { currentLang, setLang, startChinese } from "./i18n";
import type { Lang } from "./i18n";
import * as wallets from "./wallet";

const MAINNET = CONFIG.network === "mainnet";
import type { Wallet } from "./wallet";
import { displayAddress, rememberAddress } from "./addrbook";

initMotion();
const themeParam = new URLSearchParams(location.search).get("theme");
const THEME_KEY = "skydrop.theme";
const storedTheme = (): string | null => {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
};
// ?theme= wins for this visit; otherwise the choice made with the toggle; otherwise the system setting
const chosenTheme = themeParam === "dark" || themeParam === "light" ? themeParam : storedTheme();
if (chosenTheme === "dark" || chosenTheme === "light") document.documentElement.dataset.theme = chosenTheme;
type ThemeMode = "light" | "dark" | "auto";
const themeMode = (): ThemeMode => {
  const t = storedTheme();
  return t === "light" || t === "dark" ? t : "auto";
};
function applyTheme(mode: ThemeMode): void {
  try {
    if (mode === "auto") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, mode);
  } catch {
    /* storage can be blocked: the choice just lasts this visit */
  }
  if (mode === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = mode;
}

/** One small menu for everything that isn't navigation: the links that don't fit on a phone, language and theme. */
function settingsMenu(): HTMLElement {
  const wrap = h("div", { class: "menuwrap" });
  const btn = h("button", { class: "menu-btn", "aria-label": "Settings", "aria-haspopup": "true", "aria-expanded": "false" }, icons.menu(18)) as HTMLButtonElement;
  const onDoc = (ev: Event): void => {
    if (!wrap.contains(ev.target as Node)) close();
  };
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") close();
  };
  const close = (): void => {
    wrap.classList.remove("open");
    btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", onDoc);
    document.removeEventListener("keydown", onKey);
  };
  const open = (): void => {
    wrap.classList.add("open");
    btn.setAttribute("aria-expanded", "true");
    setTimeout(() => {
      document.addEventListener("click", onDoc);
      document.addEventListener("keydown", onKey);
    });
  };
  btn.addEventListener("click", () => (wrap.classList.contains("open") ? close() : open()));
  const seg = (items: [string, string][], active: string, on: (v: string) => void): HTMLElement =>
    h(
      "div",
      { class: "seg", role: "group" },
      items.map(([v, label]) =>
        h(
          "button",
          {
            class: "seg-b" + (v === active ? " on" : ""),
            "aria-pressed": String(v === active),
            onclick: (e: Event) => {
              const me = e.currentTarget as HTMLElement;
              me.parentElement!.querySelectorAll(".seg-b").forEach((x) => {
                x.classList.toggle("on", x === me);
                x.setAttribute("aria-pressed", String(x === me));
              });
              on(v);
            },
          },
          label,
        ),
      ),
    );
  const item = (href: string, label: string, cls: string) => h("a", { href, class: `mi ${cls}`, onclick: close }, label);
  mount(
    wrap,
    btn,
    h(
      "div",
      { class: "menu-panel", role: "menu" },
      ...(deployed() ? [item("#/tips", "Tip by post", "only-xs"), item("#/link", "Link wallet", "only-sm")] : []),
      item("#/how", "How it works", "only-sm"),
      h("div", { class: "menu-sep only-sm" }),
      h("div", { class: "menu-row" }, h("span", { class: "menu-label" }, "Language"), seg([["en", "English"], ["zh", "中文"]], currentLang(), (v) => setLang(v as Lang))),
      h("div", { class: "menu-row" }, h("span", { class: "menu-label" }, "Theme"), seg([["light", "Light"], ["dark", "Dark"], ["auto", "Auto"]], themeMode(), (v) => applyTheme(v as ThemeMode))),
    ),
  );
  return wrap;
}

const root = document.getElementById("app")!;

// ---------------------------------------------------------------------------------------------------------
// session: one wallet kept in this browser
// ---------------------------------------------------------------------------------------------------------

let wallet: Wallet;
let provider: IndexerProvider;
let pubKey: Uint8Array;
let myKeyHex = "";
let walletAddress = "";
let balance = 0n;
/** False until the first balance read lands. A new wallet's first read scans the chain and can take 10-20 s, so pages
 *  draw straight away and fill the balance in; actions that check funds wait for it (`balanceReady`). */
let balanceKnown = false;
let balanceReady: Promise<void> = Promise.resolve();
/** Set once the recovery key has been revealed or copied, so the "save your recovery key" nudge stops. */
const BACKED_UP_KEY = "skydrop.backedUp";
const backedUp = (): boolean => {
  try {
    return localStorage.getItem(BACKED_UP_KEY) === "1";
  } catch {
    return false;
  }
};
const noteBackedUp = (): void => {
  try {
    localStorage.setItem(BACKED_UP_KEY, "1");
  } catch {
    /* storage unavailable: the nudge just keeps showing */
  }
};
const balanceText = (digits: number): string => (balanceKnown ? `${chain.formatTari(balance, digits)} ${CONFIG.symbol}` : "…");
let cleanups: (() => void)[] = [];

async function startSession(): Promise<void> {
  chain.initStorage();
  let chosen: Wallet | null = null;
  if (wallets.savedKind() === "sapient") {
    try {
      chosen = await wallets.connectSapient(false);
    } catch {
      chosen = null;
    }
    if (!chosen) wallets.saveKind("builtin");
  }
  if (chosen) {
    provider = await IndexerProvider.connect({ url: CONFIG.indexer, network: MAINNET ? Network.MainNet : Network.Esmeralda });
  } else {
    const account = chain.openAccount(chain.savedSeed() ?? chain.createSeed());
    chosen = await wallets.builtinWallet(account, () => chain.totalTari(account));
    provider = await account.getProvider();
  }
  wallet = chosen;
  pubKey = wallet.publicKey;
  myKeyHex = toHex(pubKey);
  walletAddress = wallet.walletAddress;
  rememberAddress(wallet.componentAddress, walletAddress);
  wallets.onSapientAccountChange(() => location.reload());
  balanceReady = refreshBalance().catch(() => {
    /* the indexer hiccuped: the next refresh fills it in */
  });
}

async function refreshBalance(): Promise<void> {
  balance = await wallet.balance();
  balanceKnown = true;
  document.querySelectorAll<HTMLElement>("[data-balance]").forEach((el) => (el.textContent = balanceText(Number(el.dataset.balance) || 3)));
  dispatchEvent(new Event(BALANCE_EVENT));
}

/** Fired after every balance refresh, so a form's "you need TARI" note clears as soon as funds arrive. */
const BALANCE_EVENT = "skydrop:balance";
function onBalance(fn: () => void): void {
  addEventListener(BALANCE_EVENT, fn);
  cleanups.push(() => removeEventListener(BALANCE_EVENT, fn));
}

// ---- epochs: the chain counts time in epochs; learn how long one lasts so we can talk in hours ----------

const EPOCH_KEY = "skydrop.epochs";
function noteEpoch(epoch: number): void {
  try {
    const list = JSON.parse(localStorage.getItem(EPOCH_KEY) ?? "[]") as { e: number; t: number }[];
    if (!list.length || list[list.length - 1]!.e !== epoch) list.push({ e: epoch, t: Date.now() });
    localStorage.setItem(EPOCH_KEY, JSON.stringify(list.slice(-8)));
  } catch {
    /* storage unavailable: estimates fall back to the default */
  }
}
function secondsPerEpoch(): number {
  try {
    const list = JSON.parse(localStorage.getItem(EPOCH_KEY) ?? "[]") as { e: number; t: number }[];
    if (list.length >= 2) {
      const a = list[0]!;
      const b = list[list.length - 1]!;
      const v = (b.t - a.t) / 1000 / (b.e - a.e);
      if (v > 60 && v < 86400) return v;
    }
  } catch {
    /* ignore */
  }
  return 3600;
}
function eta(epochs: number): string {
  if (epochs <= 0) return "right away";
  const mins = Math.round((epochs * secondsPerEpoch()) / 60);
  if (mins < 90) return `about ${Math.max(mins, 1)} min`;
  const hrs = mins / 60;
  return hrs < 36 ? `about ${hrs.toFixed(hrs < 10 ? 1 : 0).replace(/\.0$/, "")} hours` : `about ${Math.round(hrs / 24)} days`;
}

// ---------------------------------------------------------------------------------------------------------
// layout
// ---------------------------------------------------------------------------------------------------------

type Tab = "home" | "send" | "claim" | "tips" | "tip" | "link" | "how";

function layout(active: Tab, ...content: (Node | null)[]): void {
  const link = (href: string, label: string, tab: Tab, cls = "") =>
    h("a", { href, class: cls, "aria-current": active === tab ? "page" : null }, label);
  mount(
    root,
    h("a", { class: "skip", href: "#main", onclick: (e: Event) => { e.preventDefault(); document.getElementById("main")?.focus(); } }, "Skip to content"),
    h(
      "header",
      { class: "top" },
      h("a", { class: "brand", href: "#/" }, h("span", { class: "logo" }, icons.drop(20)), h("span", { class: "brand-name" }, "Skydrop")),
      h(
        "nav",
        { class: "nav" },
        ...(deployed()
          ? [
              link("#/send", "Send", "send"),
              link("#/claim", "Collect", "claim"),
              link("#/tips", "Tip by post", "tips"),
              h("a", { href: "/quests" }, "My quests"),
              link("#/link", "Link wallet", "link", "hide-sm"),
              link("#/how", "How it works", "how", "hide-sm"),
              h("span", { class: "net hide-sm" }, MAINNET ? "Mainnet" : "Testnet"),
              h("button", { class: "chip", onclick: openWallet, "aria-label": "Your wallet" }, h("span", { class: "dot" }), icons.wallet(16), h("span", { "data-balance": "3" }, balanceText(3))),
            ]
          : [
              h("a", { href: "/quests" }, "My quests"),
              link("#/how", "How it works", "how"),
              h("a", { href: "https://atproto.tari.mw", target: "_blank", rel: "noopener", class: "hide-sm" }, "Create a campaign"),
              h("span", { class: "net hide-sm" }, MAINNET ? "Mainnet" : "Testnet"),
            ]),
        settingsMenu(),
      ),
    ),
    h("main", { id: "main", tabindex: "-1" }, ...content),
    h(
      "footer",
      null,
      MAINNET ? "Tari mainnet: these are real TARI." : `Tari testnet: ${CONFIG.symbol} has no monetary value.`,
      ...(deployed()
        ? [h("br"), "Escrow contract ", h("code", null, short(CONFIG.escrow, 18, 6)), " · verified on-chain, no oracle, no middleman"]
        : []),
    ),
  );
  window.scrollTo({ top: 0 });
}

// ---------------------------------------------------------------------------------------------------------
// wallet modal
// ---------------------------------------------------------------------------------------------------------

function openWallet(): void {
  const body = h("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": "Your wallet" });
  const scrim = h("div", { class: "scrim", onclick: (e: Event) => e.target === scrim && scrim.remove() }, body);
  const close = () => scrim.remove();
  let showSeed = false;

  const faucetBtn = h("button", { class: "btn primary" }, `Get free testnet ${CONFIG.symbol}`);
  const faucetNote = h("div");
  faucetBtn.addEventListener("click", async () => {
    faucetBtn.disabled = true;
    mount(faucetBtn, ...spinnerLabel("Asking the faucet…"));
    mount(faucetNote);
    try {
      await chain.useFaucet(wallet);
      await new Promise((r) => setTimeout(r, 2500));
      await refreshBalance();
      toast(`Testnet ${CONFIG.symbol} received`, "good");
      render();
    } catch (e) {
      const m = chain.friendly(e);
      mount(
        faucetNote,
        h(
          "div",
          { class: "note warn", style: "margin-top:12px" },
          /insufficient|enough|InsufficientFunds|Available/i.test(String(e))
            ? `The public testnet faucet is empty right now. Ask in the Tari community for some ${CONFIG.symbol} and give them your address above, or try again later.`
            : m,
        ),
      );
      faucetBtn.disabled = false;
      mount(faucetBtn, `Get free testnet ${CONFIG.symbol}`);
    }
  });

  // withdraw: send tTARI out of the built-in wallet to any Tari address
  const wAddr = h("input", { class: "input", placeholder: "otl_…", autocomplete: "off", autocapitalize: "off", spellcheck: "false", "aria-label": "Address to withdraw to", style: "font-size:15px;font-family:var(--mono)" }) as HTMLInputElement;
  const wAmt = h("input", { class: "input", inputmode: "decimal", placeholder: "0.0", "aria-label": "Amount to withdraw", style: "padding-right:80px" }) as HTMLInputElement;
  const wBtn = h("button", { class: "btn primary block" }, "Withdraw") as HTMLButtonElement;
  const wNote = h("div", { style: "margin-top:10px" });
  let wBusy = false;
  const wRoom = (): bigint => (balance > SEND_FEE_ROOM ? balance - SEND_FEE_ROOM : 0n);
  const wUpdate = (): void => {
    const addr = wAddr.value.trim();
    const amt = chain.parseTari(wAmt.value);
    const addrErr = addr ? chain.addressProblem(addr, walletAddress) : null;
    let msg: string | null = addrErr;
    if (!msg && amt !== null && !balanceKnown) msg = "Checking your wallet balance…";
    else if (!msg && amt !== null && amt > wRoom()) msg = wRoom() > 0n ? `You can withdraw up to ${chain.formatTari(wRoom())} ${CONFIG.symbol}. A small network fee stays behind.` : "There isn't enough here to cover the network fee.";
    wBtn.disabled = wBusy || !addr || !!addrErr || !amt || amt <= 0n || amt > wRoom();
    if (!wBusy) mount(wBtn, amt && addr && !addrErr ? `Withdraw ${chain.formatTari(amt)} ${CONFIG.symbol}` : "Withdraw");
    mount(wNote, msg ? h("div", { class: "note warn" }, msg) : null);
  };
  wAddr.addEventListener("input", wUpdate);
  wAmt.addEventListener("input", wUpdate);
  onBalance(wUpdate);
  wBtn.addEventListener("click", async () => {
    const addr = wAddr.value.trim();
    const amt = chain.parseTari(wAmt.value);
    if (!amt || wBusy) return;
    wBusy = true;
    wBtn.disabled = true;
    mount(wBtn, ...spinnerLabel("Withdrawing…"));
    try {
      await chain.withdrawTo(wallet, addr, amt);
      await new Promise((r) => setTimeout(r, 1500));
      await refreshBalance();
      toast(`Sent ${chain.formatTari(amt)} ${CONFIG.symbol} to ${short(addr, 10, 6)}`, "good");
      wAmt.value = "";
      wAddr.value = "";
      wBusy = false;
      render();
    } catch (e) {
      wBusy = false;
      toast(chain.friendly(e), "bad");
      wUpdate();
    }
  });

  const useSapient = async (): Promise<void> => {
    try {
      const w = await wallets.connectSapient(true);
      if (!w) return void toast("Sapient isn't installed in this browser.", "bad");
      wallets.saveKind("sapient");
      location.reload();
    } catch (e) {
      toast(chain.friendly(e), "bad");
    }
  };

  const useBuiltin = async (): Promise<void> => {
    await wallets.disconnectSapient();
    wallets.saveKind("builtin");
    location.reload();
  };

  const renderSapient = (): void => {
    mount(
      body,
      h("button", { class: "btn ghost sm x", onclick: close, "aria-label": "Close" }, icons.close(16)),
      h("h3", null, "Sapient wallet"),
      h("p", { class: "sub", style: "margin-bottom:8px" }, "Connected. Sapient holds your keys and asks you to approve each transaction."),
      h("div", { class: "kv" }, h("div", { class: "k" }, "Balance"), h("div", { class: "amount", style: "font-size:36px" }, h("span", { "data-balance": "4" }, balanceText(4)))),
      h(
        "div",
        { class: "kv" },
        h("div", { class: "k" }, `Your address (share it to receive ${CONFIG.symbol})`),
        h("div", { class: "v" }, walletAddress),
        h("div", { class: "row", style: "margin-top:6px" }, h("button", { class: "btn ghost sm", onclick: () => copy(walletAddress, "Address copied") }, icons.copy(), "Copy address")),
      ),
      h("p", { class: "help" }, MAINNET ? "Claims with Sapient pay their own small network fee, so keep a little TARI in it." : `Claims with Sapient pay their own small network fee, so keep a little ${CONFIG.symbol} in it. Get testnet ${CONFIG.symbol} from inside Sapient.`),
      h("div", { class: "row", style: "margin-top:14px" }, h("button", { class: "btn ghost sm", onclick: useBuiltin }, "Use Skydrop's built-in wallet instead")),
    );
  };

  const render = (): void => {
    if (wallet.kind === "sapient") return renderSapient();
    const seed = chain.savedSeed() ?? "";
    mount(
      body,
      h("button", { class: "btn ghost sm x", onclick: close, "aria-label": "Close" }, icons.close(16)),
      h("h3", null, "Your Skydrop wallet"),
      h("p", { class: "sub", style: "margin-bottom:8px" }, "Kept in this browser. It signs for you, so you never connect an extension."),
      h("div", { class: "kv" }, h("div", { class: "k" }, "Balance"), h("div", { class: "amount", style: "font-size:36px" }, h("span", { "data-balance": "4" }, balanceText(4)))),
      h(
        "div",
        { class: "kv" },
        h("div", { class: "k" }, `Your address (share it to receive ${CONFIG.symbol})`),
        h("div", { class: "v" }, walletAddress),
        h("div", { class: "row", style: "margin-top:6px" }, h("button", { class: "btn ghost sm", onclick: () => copy(walletAddress, "Address copied") }, icons.copy(), "Copy address")),
      ),
      MAINNET ? null : h("div", { class: "row" }, faucetBtn),
      MAINNET ? null : faucetNote,
      h("hr", { style: "border:0;border-top:1px solid var(--line);margin:22px 0" }),
      h("div", { class: "kv" }, h("div", { class: "k" }, "Withdraw")),
      h("p", { class: "help", style: "margin:-6px 0 10px" }, `Send ${CONFIG.symbol} out of Skydrop to any Tari address, such as your Sapient wallet.`),
      h("div", { class: "stack" }, wAddr, h("div", { class: "field" }, wAmt, h("a", { href: "#", class: "suffix", style: "pointer-events:auto;font-weight:700", onclick: (e: Event) => { e.preventDefault(); wAmt.value = chain.formatTari(wRoom()); wUpdate(); } }, "Max")), wBtn),
      wNote,
      h("hr", { style: "border:0;border-top:1px solid var(--line);margin:22px 0" }),
      h("div", { class: "kv" }, h("div", { class: "k" }, "Prefer your own wallet?")),
      h("div", { class: "row" }, h("button", { class: "btn ghost sm", onclick: useSapient }, "Connect Sapient")),
      h("p", { class: "help" }, "Sapient is a Tari browser wallet. Your keys stay in the extension and you approve each transaction there."),
      h("hr", { style: "border:0;border-top:1px solid var(--line);margin:22px 0" }),
      h("div", { class: "kv" }, h("div", { class: "k" }, "Recovery key"), h("div", { class: "v" }, showSeed ? seed : "••••••••••••••••••••••••••••••••")),
      h(
        "div",
        { class: "row" },
        h("button", { class: "btn ghost sm", onclick: () => { showSeed = !showSeed; if (showSeed) noteBackedUp(); render(); } }, showSeed ? "Hide" : "Reveal"),
        h("button", { class: "btn ghost sm", onclick: () => { noteBackedUp(); copy(seed, "Recovery key copied"); } }, icons.copy(), "Copy"),
      ),
      h("p", { class: "help" }, "Anyone with this key controls this wallet. Save it somewhere safe. If you clear your browser data without it, the wallet is gone."),
      h(
        "div",
        { class: "row", style: "margin-top:14px" },
        h("button", { class: "btn ghost sm", onclick: importKey }, "Use a different recovery key"),
      ),
    );
  };

  const importKey = (): void => {
    const input = prompt("Paste a 32-character recovery key. This replaces the wallet in this browser.");
    if (!input) return;
    try {
      chain.saveSeed(input.trim());
      location.reload();
    } catch (e) {
      toast(chain.friendly(e), "bad");
    }
  };

  render();
  wUpdate();
  document.body.appendChild(scrim);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      close();
      removeEventListener("keydown", onKey);
    }
  };
  addEventListener("keydown", onKey);
}

// ---------------------------------------------------------------------------------------------------------
// shared bits
// ---------------------------------------------------------------------------------------------------------

function profileCard(p: bsky.Profile): HTMLElement {
  return h(
    "div",
    { class: "profile" },
    p.avatar ? h("img", { src: p.avatar, alt: "", width: 52, height: 52 }) : h("div", { class: "avatar" }),
    h("div", { style: "min-width:0" }, h("div", { class: "n" }, p.displayName), h("div", { class: "h" }, `@${p.handle}`), h("div", { class: "did" }, short(p.did, 16, 8))),
  );
}

/**
 * Who a waiting gift says it's from, the way the bot puts it: the sender typed an account when sending (or nothing:
 * anonymous). Verified when that account's linked wallet is the wallet that sent the gift; otherwise it's shown as the
 * sender's own word. Cached per gift, since a page refresh shouldn't look it all up again.
 */
const fromCache = new Map<string, Promise<{ handle: string; verified: boolean } | null>>();
function giftFrom(recipient: string, d: chain.Deposit): Promise<{ handle: string; verified: boolean } | null> {
  const key = `${recipient}:${d.sender}:${d.amount}`;
  let hit = fromCache.get(key);
  if (!hit) {
    hit = (async () => {
      try {
        const r = await fetch(`/api/from?did=${encodeURIComponent(recipient)}&sender=${d.sender}&amount=${d.amount}`);
        const from = r.ok ? (((await r.json()) as { from?: string | null }).from ?? null) : null;
        if (!from) return null;
        const [profile, esc] = await Promise.all([bsky.lookupProfile(from), chain.readEscrow(provider, from)]);
        return { handle: profile.handle, verified: esc.bindingOwner === d.sender };
      } catch {
        return null;
      }
    })();
    fromCache.set(key, hit);
  }
  return hit;
}
const fromText = (f: { handle: string; verified: boolean }): string => (f.verified ? `From @${f.handle}` : `From “${f.handle}” (as the sender says)`);

/** A handle field that resolves the account as you type. */
const HANDLE_KEY = "skydrop.handle";
/** The handle a sender last said gifts were from (empty: anonymous). */
const FROM_KEY = "skydrop.from";
function lastHandle(): string {
  try {
    return localStorage.getItem(HANDLE_KEY) ?? "";
  } catch {
    return "";
  }
}
function saveHandle(handle: string): void {
  try {
    localStorage.setItem(HANDLE_KEY, handle);
  } catch {
    /* the handle just isn't remembered */
  }
}

function handleField(initial: string, onProfile: (p: bsky.Profile | null) => void): { el: HTMLElement; input: HTMLInputElement; setValue: (v: string) => void } {
  const input = h("input", { class: "input", placeholder: "name.bsky.social", autocomplete: "off", autocapitalize: "off", spellcheck: "false", "aria-label": "Bluesky handle" }) as HTMLInputElement;
  const result = h("div");
  let timer = 0;
  let seq = 0;
  const lookup = async (): Promise<void> => {
    const v = input.value.trim();
    const mine = ++seq;
    if (!v) {
      mount(result);
      onProfile(null);
      return;
    }
    mount(result, h("div", { class: "skel" }));
    try {
      // Most people type just their name: "alice" means alice.bsky.social, and the card below shows who it found.
      const bare = bsky.cleanHandle(v);
      const p = await bsky.lookupProfile(/^[a-z0-9-]+$/.test(bare) ? `${bare}.bsky.social` : v);
      if (mine !== seq) return;
      // A pasted DID or profile link reads better as the handle it resolved to.
      if (/^did:|bsky\.app\/|^at:\/\//i.test(v)) input.value = p.handle;
      mount(result, profileCard(p));
      onProfile(p);
    } catch (e) {
      if (mine !== seq) return;
      mount(result, h("div", { class: "note bad", style: "margin-top:12px" }, e instanceof Error ? e.message : String(e)));
      onProfile(null);
    }
  };
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = window.setTimeout(lookup, 450);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    clearTimeout(timer);
    void lookup();
  });
  input.setAttribute("enterkeyhint", "search");
  const setValue = (v: string): void => {
    input.value = v;
    void lookup();
  };
  if (initial) setValue(initial);
  return { el: h("div", null, h("div", { class: "field" }, input), result), input, setValue };
}

const SEND_FEE_ROOM = 40_000n;
/** Whether the wallet is short of `extra` plus a fee. Unknown until the first balance read, and never "short" before
 *  then, so no page flashes a "you need TARI" note at someone who has some; actions `await balanceReady` first. */
const needsFunds = (extra = 0n): boolean => balanceKnown && balance < extra + SEND_FEE_ROOM;

/**
 * Some posts' proofs are too big to check inside a sponsored transaction's fee step. For those, Skydrop's bot sends
 * the wallet a little TARI (once per account, only with gifts waiting) so it can pay the normal claim itself.
 */
async function askForFloat(did: string, say: (s: string) => void): Promise<void> {
  say(`Your post's proof is too big for a free claim, so Skydrop is sending your wallet a little ${CONFIG.symbol} to pay the fee. This takes up to a minute`);
  const r = await fetch("/api/relay-claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "float", did, address: walletAddress }) });
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `Skydrop couldn't send the fee. Add about 0.2 ${CONFIG.symbol} to your wallet and try again.`);
  for (let i = 0; i < 18; i++) {
    await new Promise((res) => setTimeout(res, 10_000));
    await refreshBalance();
    if (!needsFunds(100_000n)) return say("It arrived. Your wallet pays the fee now");
  }
  throw new Error(`Skydrop couldn't send the fee this time. Add about 0.2 ${CONFIG.symbol} to your wallet and try again.`);
}

/**
 * The v2 contracts read an account's identity history from the ChainBook. A long one (an old account) has to be recorded
 * there before a free claim fits; Skydrop's bot does that (once per account, only with gifts waiting), and this waits.
 */
async function askForRecording(did: string, say: (s: string) => void): Promise<void> {
  // Skydrop records histories for free only when at least this much is waiting (the bot's own rule).
  const e = await chain.readEscrow(provider, did);
  if (chain.total([...e.deposits, ...e.laterDeposits]) < RECORD_MIN_WAITING) {
    throw new Error(`This account's identity history has to be recorded on-chain before it can collect, and Skydrop only does that for free when at least ${chain.formatTari(RECORD_MIN_WAITING)} ${CONFIG.symbol} is waiting. Add about 0.2 ${CONFIG.symbol} to your wallet and collect again.`);
  }
  say("Your account's identity history is being recorded on-chain first (once, free). This takes up to a minute");
  const r = await fetch("/api/relay-claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "record", did }) });
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `Skydrop couldn't record your account's history. Add about 0.2 ${CONFIG.symbol} to your wallet and try again.`);
  for (let i = 0; i < 18; i++) {
    await new Promise((res) => setTimeout(res, 10_000));
    try {
      if ((await chain.bookSteps(did)).missing <= chain.FEE_PHASE_BOOK_OPS) return say("Recorded. Claiming now");
    } catch {
      /* the directory or indexer hiccuped: try again */
    }
  }
  throw new Error(`Recording your account's history is taking too long. Add about 0.2 ${CONFIG.symbol} to your wallet and try again.`);
}

/**
 * Before the wallet pays for a claim: an old account's identity history costs about 0.009 TARI an operation to record,
 * which can be more than a small wallet holds. Skydrop's bot records it for free when enough is waiting, so ask it
 * first, whatever the wallet holds. True when the history is ready for a free claim.
 */
async function recordForFree(did: string, say: (s: string) => void): Promise<boolean> {
  const missing = await chain.unrecordedOps(did).catch(() => 0);
  if (missing <= chain.FEE_PHASE_BOOK_OPS) return true;
  try {
    await askForRecording(did, say);
    return true;
  } catch {
    return false;
  }
}

/** Stops a paid claim the wallet can't afford before it starts, rather than partway with fees already spent. */
async function checkPaidClaim(did: string, say: (s: string) => void): Promise<void> {
  await balanceReady;
  const missing = await chain.unrecordedOps(did).catch(() => 0);
  const need = chain.paidClaimFeeCeiling(missing);
  if (balance < need) {
    const why = missing > 1 ? `, mostly to record this Bluesky account's identity history on-chain (${missing} entries)` : "";
    throw new Error(`Collecting with this wallet needs up to ${chain.formatTari(need)} ${CONFIG.symbol} for network fees${why}, and it holds ${chain.formatTari(balance)}. Add about ${chain.formatTari(need - balance + 20_000n)} ${CONFIG.symbol} and try again. Only the real cost is charged.`);
  }
  if (missing > 1) say(`Your wallet pays to record this account's identity history first (${missing} entries)`);
}

/** Mirrors the bot's LINKED_MIN_GIFTS: below this, it won't pay a linked claim's fees. */
const LINKED_MIN_WAITING = 500_000n;

/**
 * A linked account's phrase claim, when this wallet has no TARI: the linked-claim calls need no signature (the payout
 * can only go to the linked wallet), so Skydrop's bot submits the step and pays its fee. Waits until the chain shows it.
 */
async function relayLinked(did: string, step: "start" | "finalize", done: (e: chain.Escrow) => boolean, say: (s: string) => void): Promise<void> {
  const e = await chain.readEscrow(provider, did);
  if (chain.total(e.deposits) < LINKED_MIN_WAITING) {
    throw new Error(`Skydrop pays this fee for you when at least ${chain.formatTari(LINKED_MIN_WAITING)} ${CONFIG.symbol} is waiting. Add a little ${CONFIG.symbol} to your wallet and try again.`);
  }
  say(step === "start" ? `Your wallet has no ${CONFIG.symbol}, so Skydrop submits your post and pays the fee. This takes up to a minute` : `Skydrop pays the fee to send it to your linked wallet. This takes up to a minute`);
  const r = await fetch("/api/relay-claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "linked", did, step }) });
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `Skydrop couldn't do this for free right now. Add a little ${CONFIG.symbol} to your wallet and try again.`);
  for (let i = 0; i < 18; i++) {
    await new Promise((res) => setTimeout(res, 10_000));
    const now = await chain.readEscrow(provider, did).catch(() => null);
    if (now && done(now)) return;
  }
  throw new Error(`Skydrop couldn't do this for free this time. If your linked wallet holds ${CONFIG.symbol}, it pays its own fee: open this page from that wallet, or add a little ${CONFIG.symbol} here, and try again.`);
}

/** Mirrors the bot's RECORD_MIN_GIFTS: below this, it won't pay to record an account's history. */
const RECORD_MIN_WAITING = 500_000n;

function fundsNote(): HTMLElement {
  return h(
    "div",
    { class: "note warn" },
    `This wallet has no ${CONFIG.symbol} for network fees yet. `,
    h("a", { href: "#", onclick: (e: Event) => { e.preventDefault(); openWallet(); } }, `Get some ${CONFIG.symbol}`),
    ".",
  );
}

// ---------------------------------------------------------------------------------------------------------
// home
// ---------------------------------------------------------------------------------------------------------

/** Where gift links land while the gift contracts aren't on the network: no form that can only fail at the end. */
function renderGiftsPaused(): void {
  layout(
    "home",
    h("h1", { class: "page" }, "Gifts aren't running right now"),
    h("p", { class: "sub" }, "They're being moved to the new network, so nothing can be sent or collected here yet. Any gift from before the network reset no longer exists."),
    h("div", { class: "row" }, h("a", { class: "btn primary", href: "/quests" }, "See your campaign rewards"), h("a", { class: "btn ghost", href: "#/" }, "Back to home")),
  );
}

/** The home page while only campaign rewards are running. It offers nothing that would fail at the last step. */
function renderRewardsHome(): void {
  const input = h("input", { class: "input", placeholder: "yourname.bsky.social", "aria-label": "Your Bluesky handle", autocomplete: "off", autocapitalize: "off", spellcheck: "false" }) as HTMLInputElement;
  const form = h("form", { class: "homeform" }, h("div", { class: "field" }, input), h("button", { class: "btn primary", type: "submit" }, "Show my rewards"));
  const show = (handle: string): void => {
    location.href = handle ? `/quests?handle=${encodeURIComponent(handle)}` : "/quests";
  };
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    show(input.value.trim());
  });
  attachSuggest(input, show);
  layout(
    "home",
    h(
      "section",
      { class: "hero" },
      h(
        "div",
        null,
        h("span", { class: "pill" }, icons.shield(14), MAINNET ? "Checked against signed data" : "Testnet · checked against signed data"),
        h("h1", null, "Get rewarded for what you ", h("em", null, "do"), " on Bluesky."),
        h("p", { class: "lead" }, "Campaigns pay Tari for likes, reposts, replies and follows. Enter your handle to see what you can collect and what's left to do."),
        form,
        h("p", { class: "homelink" }, h("a", { href: "/quests" }, "Browse open campaigns"), " · no wallet needed to look."),
      ),
      stamp(),
    ),
    h(
      "section",
      { class: "how3", "aria-label": "How it works" },
      h("h2", { class: "how3-title" }, "Three steps to your first reward"),
      h(
        "ol",
        null,
        h("li", null, h("span", { class: "n" }, "1"), h("div", null, h("b", null, "Pick a campaign"), h("p", null, "Browse what's open, or open a link someone shared. You'll see exactly what it asks for and what it pays."))),
        h("li", null, h("span", { class: "n" }, "2"), h("div", null, h("b", null, "Do the steps"), h("p", null, "Like, repost, reply or follow on Bluesky as you normally would. Your progress updates when you come back."))),
        h("li", null, h("span", { class: "n" }, "3"), h("div", null, h("b", null, "Post once and collect"), h("p", null, "One short post ties the reward to your wallet. Approve it in Sapient and it's yours."))),
      ),
    ),
    h(
      "div",
      { class: "trust" },
      h("div", null, h("b", null, "No middleman"), h("span", null, "The contract checks your account's signatures itself, then pays you directly.")),
      h("div", null, h("b", null, "Only you choose the wallet"), h("span", null, "Your one post names your wallet, so nobody can redirect your reward.")),
      h("div", null, h("b", null, "Free to check"), h("span", null, "You only need a wallet to collect, and it pays a small network fee.")),
    ),
    h(
      "div",
      { class: "grid2 homemore" },
      h("a", { class: "card action", href: "https://atproto.tari.mw", target: "_blank", rel: "noopener" }, h("span", { class: "icon" }, icons.send(24)), h("span", { class: "arrow" }, "→"), h("h2", null, "Run a campaign"), h("p", null, "Reward people for engaging with your posts. Build one in minutes on atproto.tari.mw.")),
      h("div", { class: "card action soon" }, h("span", { class: "icon alt" }, icons.gift(24)), h("h2", null, "Gifts and tips"), h("p", null, "Sending Tari to any handle is coming back once its contracts are on the new network.")),
    ),
  );
}

/** The home page's shortcut: type who, land on their tip page. */
function quickTip(): HTMLElement {
  const input = h("input", { class: "input", placeholder: "Who do you want to tip?", autocomplete: "off", autocapitalize: "off", spellcheck: "false", enterkeyhint: "go", "aria-label": "Bluesky handle to tip" }) as HTMLInputElement;
  const go = (e?: Event): void => {
    e?.preventDefault();
    const v = bsky.cleanHandle(input.value);
    if (!v) return input.focus();
    location.hash = `#/tip/${encodeURIComponent(v)}`;
  };
  return h("form", { class: "quick-tip", onsubmit: go }, input, h("button", { class: "btn primary", type: "submit" }, "Tip"));
}

function renderHome(): void {
  if (!deployed()) {
    renderRewardsHome();
    return;
  }
  layout(
    "home",
    h(
      "section",
      { class: "hero" },
      h(
        "div",
        null,
        h("span", { class: "pill" }, icons.shield(14), "Trustless · verified on-chain"),
        h("h1", null, "Tip ", h("em", null, "anyone"), " on Bluesky"),
        h("p", { class: "lead" }, `Type a handle, tap an amount, done. They collect the ${CONFIG.symbol} by proving they own the account. No wallet to set up first, no middleman holding the money.`),
        quickTip(),
      ),
      stamp(),
    ),
    h(
      "div",
      { class: "grid2" },
      h("a", { class: "card action", href: "#/send" }, h("span", { class: "icon" }, icons.send(24)), h("span", { class: "arrow" }, "→"), h("h2", null, "Send"), h("p", null, "Pick a Bluesky handle and an amount. We hold it safely on-chain until they claim it.")),
      h("a", { class: "card action", href: "#/jar" }, h("span", { class: "icon" }, icons.drop(24)), h("span", { class: "arrow" }, "→"), h("h2", null, "Get tipped"), h("p", null, "Your own tip jar link for your Bluesky bio. Fans tip you in two taps.")),
      h("a", { class: "card action", href: "#/tips" }, h("span", { class: "icon" }, icons.send(24)), h("span", { class: "arrow" }, "→"), h("h2", null, "Tip by post"), h("p", null, "Fund a budget once, then tip anyone with one Bluesky post. Nobody holds your keys.")),
      h("a", { class: "card action", href: "#/link" }, h("span", { class: "icon" }, icons.wallet(24)), h("span", { class: "arrow" }, "→"), h("h2", null, "Link wallet"), h("p", null, "Link your wallet to your Bluesky account once. Gifts then land in it instantly, with nothing to claim.")),
      h("a", { class: "card action", href: "#/claim" }, h("span", { class: "icon alt" }, icons.gift(24)), h("span", { class: "arrow" }, "→"), h("h2", null, "Collect"), h("p", null, `Someone sent you ${CONFIG.symbol}? Post one line on Bluesky to prove it's you, then collect.`)),
    ),
    h(
      "section",
      { class: "how3", "aria-label": "How it works" },
      h("h2", { class: "how3-title" }, "Three steps, no wallet needed"),
      h(
        "ol",
        null,
        h("li", null, h("span", { class: "n" }, "1"), h("div", null, h("b", null, "You send"), h("p", null, `Type a Bluesky handle, pick an amount and an envelope. The ${CONFIG.symbol} waits on-chain under their account.`))),
        h("li", null, h("span", { class: "n" }, "2"), h("div", null, h("b", null, "They get a mention"), h("p", null, "The Skydrop bot tells them on Bluesky, with your envelope and note."))),
        h("li", null, h("span", { class: "n" }, "3"), h("div", null, h("b", null, "They prove it's them"), h("p", null, "One post from their account, checked by the contract itself. Link a wallet once and later gifts arrive instantly."))),
      ),
    ),
    h(
      "div",
      { class: "trust" },
      h("div", null, h("b", null, "No oracle"), h("span", null, "The contract itself checks your account's cryptographic signatures. Nobody vouches for you.")),
      h("div", null, h("b", null, "Always refundable"), h("span", null, "Unclaimed money returns to the sender after a set time.")),
      h("div", null, h("b", null, "Nothing to install"), h("span", null, "It works in your browser. A wallet is made for you in the background.")),
    ),
  );
}

// ---------------------------------------------------------------------------------------------------------
// send
// ---------------------------------------------------------------------------------------------------------

const WINDOWS = [
  { w: 0, name: "Instant", desc: "They can collect the moment they verify. Best for tips and small gifts.", tag: "Recommended for small amounts" },
  { w: 2, name: "Careful", desc: "A short safety window before it can be collected, so the real owner can stop a hijacked claim.", tag: "" },
  { w: 10, name: "Vault", desc: "A longer safety window for larger transfers.", tag: "" },
].filter((o) => o.w <= CONFIG.maxWindow);

function renderSend(prefill?: string): void {
  let profile: bsky.Profile | null = null;
  let windowEpochs = 0;
  let busy = false;
  let style = env.STYLES[0]!;
  // pattern, seal symbol, colour, font and opening burst: all optional, all in the link and the envelope's hash
  let extras: env.Extras = {};
  let coverId = "";
  let coverUrl = "";
  let uploading = false;
  // the wallet this account has linked, if any: sends with no window and no phrase land there at once
  let bound: string | null = null;

  const field = handleField(prefill ?? "", (p) => {
    profile = p;
    bound = null;
    update();
    if (p) void showWaiting(p);
  });
  const waiting = h("div");
  const amountInput = h("input", { class: "input big", inputmode: "decimal", placeholder: "1.0", "aria-label": "Amount" }) as HTMLInputElement;
  const stage = h("div", { class: "log" });
  const choicesEl = h("div", { class: "choices", role: "radiogroup", "aria-label": "Safety level" });
  const sendBtn = h("button", { class: "btn primary block" }, "Send") as HTMLButtonElement;
  const fundsEl = h("div");
  const whyEl = h("div", { class: "why", "aria-live": "polite" });
  const card = h("div", { class: "card stack" });
  // Optional: who the gift says it's from. Empty means anonymous, which is the default.
  const fromInput = h("input", { class: "input", placeholder: "yourname.bsky.social", autocomplete: "off", spellcheck: "false", "aria-label": "Your Bluesky handle (optional)" }) as HTMLInputElement;
  try {
    fromInput.value = localStorage.getItem(FROM_KEY) ?? "";
  } catch {
    /* not remembered */
  }
  const noteInput = h("input", { class: "input", maxlength: String(env.MAX_NOTE), placeholder: "Happy birthday! Buy yourself a coffee.", "aria-label": "Note on the envelope" }) as HTMLInputElement;
  const challengeInput = h("input", { class: "input", placeholder: "e.g. I love Tari", "aria-label": "Phrase they must post" }) as HTMLInputElement;
  const challengeNote = h("div");
  // how long the claim post must stay up before the money is released (epochs; only with a phrase)
  const holdSelect = h("select", { class: "input", "aria-label": "How long the post must stay up" }, [0, 1, 3, 6, 12, 24].map((n) => h("option", { value: String(n) }, n ? `Must stay up for ${eta(n)}` : "No need to keep it up"))) as HTMLSelectElement;
  const hold = (): number => (challenge() ? Number(holdSelect.value) : 0);
  holdSelect.style.display = "none";
  const challenge = (): string => challengeInput.value.replace(/\s+/g, " ").trim();
  const challengeProblem = (): string => {
    const c = challenge();
    if (new TextEncoder().encode(c).length > CONFIG.maxChallenge) return `Keep it under ${CONFIG.maxChallenge} bytes (about ${CONFIG.maxChallenge} letters, fewer for non-Latin text).`;
    return "";
  };
  const pickEl = h("div", { class: "env-pick", role: "radiogroup", "aria-label": "Envelope" });
  const previewEl = h("div", { class: "env-preview" });
  // What the collapsed "Personalize" row says is picked, so nobody has to open it to know.
  const personalSum = h("span", { class: "sum-val" });
  const drawSummary = (): void => {
    const who = fromInput.value.trim().replace(/^@/, "");
    const touches = env.hasExtras(extras) ? "customized" : "";
    personalSum.textContent = [coverUrl ? "Your picture" : style.name, touches, env.cleanNote(noteInput.value) ? "with a note" : "", who ? `from @${who}` : "anonymous"].filter(Boolean).join(" · ");
  };
  fromInput.addEventListener("input", drawSummary);
  // The finer touches, under the styles: pattern, seal, colour, note font and what bursts out when it's opened.
  const moreEl = h("div", { class: "env-more" });
  const setExtra = (k: keyof env.Extras, v: string | undefined): void => {
    extras = env.cleanExtras({ ...extras, [k]: v });
    drawEnvelope();
  };
  const chip = (label: string | Node, on: boolean, pick: () => void, attrs: Record<string, string> = {}): HTMLElement =>
    h("button", { class: "chip-o", role: "radio", "aria-checked": String(on), onclick: pick, ...attrs }, label);
  const pickAny = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!;
  const surprise = (): void => {
    style = pickAny(env.STYLES);
    extras = env.cleanExtras({
      p: pickAny(env.PATTERNS).id,
      g: Math.random() < 0.6 ? pickAny(env.SEALS) : "",
      f: pickAny(env.FONTS).id,
      x: pickAny(env.EFFECTS.filter((e) => e.id)).id,
    });
    drawEnvelope();
    const shown = previewEl.querySelector<HTMLElement>(".env");
    if (shown) setTimeout(() => shown.click(), 250);
  };
  const drawMore = (): void => {
    const eff = env.effectiveStyle(style, extras);
    const sealIn = h("input", { class: "input seal-in", maxlength: "16", placeholder: "Any", value: extras.g && !env.SEALS.includes(extras.g) ? extras.g : "", "aria-label": "Your own seal symbol" }) as HTMLInputElement;
    sealIn.addEventListener("change", () => setExtra("g", sealIn.value));
    const colour = h("input", { type: "color", value: extras.k ?? style.paper, "aria-label": "Cover colour" }) as HTMLInputElement;
    colour.addEventListener("input", () => setExtra("k", colour.value));
    mount(
      moreEl,
      h(
        "div",
        null,
        h("div", { class: "lbl" }, h("span", null, "Pattern"), coverUrl ? h("span", null, "shows without a picture") : null),
        h(
          "div",
          { class: "chips", role: "radiogroup", "aria-label": "Pattern" },
          env.PATTERNS.map((pt) =>
            chip(h("span", null, pt.name), eff.pattern === pt.id, () => setExtra("p", pt.id), { class: "chip-o sw", style: `--paper:${eff.paper};background-image:${env.patternCss(pt.id, eff.ink) || "none"}`, "aria-label": pt.name }),
          ),
        ),
      ),
      h(
        "div",
        null,
        h("div", { class: "lbl" }, "Seal"),
        h("div", { class: "chips", role: "radiogroup", "aria-label": "Seal symbol" }, chip("Auto", !extras.g, () => setExtra("g", "")), env.SEALS.map((g) => chip(g, extras.g === g, () => setExtra("g", g))), sealIn),
      ),
      h(
        "div",
        null,
        h("div", { class: "lbl" }, "Colour"),
        h("div", { class: "colour-row" }, colour, h("span", { class: "help", style: "margin:0" }, extras.k ? "Your own colour" : `${style.name} colour`), extras.k ? h("button", { class: "btn ghost sm", onclick: () => setExtra("k", "") }, "Reset") : null),
      ),
      h(
        "div",
        null,
        h("div", { class: "lbl" }, "Note font"),
        h("div", { class: "chips", role: "radiogroup", "aria-label": "Note font" }, env.FONTS.map((f) => chip(h("span", { class: f.id ? `env-msg font-${f.id}` : "", style: "font-size:15px" }, f.name), (extras.f ?? "") === f.id, () => setExtra("f", f.id)))),
      ),
      h(
        "div",
        null,
        h("div", { class: "lbl" }, h("span", null, "Opening burst"), h("span", null, "tap to preview")),
        h(
          "div",
          { class: "chips", role: "radiogroup", "aria-label": "Opening burst" },
          env.EFFECTS.map((fx) =>
            chip(fx.chars.length ? `${fx.chars[0]} ${fx.name}` : fx.id ? `🎊 ${fx.name}` : fx.name, (extras.x ?? "") === fx.id, () => {
              setExtra("x", fx.id);
              if (fx.id) env.burst(previewEl, fx.id);
            }),
          ),
        ),
      ),
      h("div", { class: "row" }, h("button", { class: "btn ghost sm", onclick: surprise }, "🎲 Surprise me"), env.hasExtras(extras) ? h("button", { class: "btn ghost sm", onclick: () => { extras = {}; drawEnvelope(); } }, "Clear touches") : null),
    );
  };

  const drawEnvelope = (): void => {
    drawSummary();
    const file = h("input", { type: "file", accept: "image/*", style: "display:none" }) as HTMLInputElement;
    const useCover = async (make: () => Promise<Blob>): Promise<void> => {
      uploading = true;
      update();
      mount(previewEl, h("p", { class: "help" }, "Preparing your cover…"));
      try {
        const blob = await make();
        coverId = await env.uploadCover(blob);
        coverUrl = `/c/${coverId}.jpg`;
      } catch (e) {
        toast(e instanceof Error ? e.message : "Couldn't use that picture", "bad");
      }
      uploading = false;
      update();
      drawEnvelope();
    };
    file.addEventListener("change", () => {
      const f = file.files?.[0];
      if (f) void useCover(() => env.prepareCover(f));
    });
    mount(
      pickEl,
      env.STYLES.map((o) =>
        h(
          "button",
          { class: "env-opt", role: "radio", "aria-checked": String(style.id === o.id && !extras.k), style: `--paper:${o.paper};--flap:${o.flap};--seal:${o.seal}`, onclick: () => { style = o; extras = env.cleanExtras({ ...extras, k: "" }); drawEnvelope(); } },
          h("div", { class: "mini", style: `background-color:${o.paper};background-image:${env.patternCss(o.pattern ?? "none", o.ink) || "none"}` }, h("i")),
          h("b", null, o.name),
          h("small", null, o.tag),
        ),
      ),
      h("button", { class: "env-up", onclick: () => file.click() }, h("div", { class: "mini", style: coverUrl ? `background-image:url(${coverUrl})` : "" }, coverUrl ? "" : "+"), h("b", null, coverUrl ? "Change picture" : "Your own picture"), h("small", null, "Any image")),
      file,
      h("div", { class: "env-designs" }, h("span", null, "Or start from a design:"), env.PRESETS.map((d) => h("button", { class: "btn ghost sm", onclick: () => void useCover(() => env.presetCover(d.id)) }, d.name))),
    );
    drawMore();
    const a = amount();
    mount(
      previewEl,
      env.envelope(style, env.cleanNote(noteInput.value), { amount: a ? `${chain.formatTari(a)} ${CONFIG.symbol}` : undefined, coverUrl: coverUrl || undefined, extras }),
      h("p", { class: "help", style: "margin-top:12px" }, "Tap the envelope to peek inside.", coverUrl ? h("span", null, " ", h("a", { href: "#", onclick: (ev: Event) => { ev.preventDefault(); coverId = ""; coverUrl = ""; drawEnvelope(); } }, "Remove picture")) : null),
    );
  };

  const amount = (): bigint | null => chain.parseTari(amountInput.value);

  const drawChoices = (): void => {
    mount(
      choicesEl,
      WINDOWS.map((o) =>
        h(
          "button",
          { class: "choice", role: "radio", "aria-checked": String(windowEpochs === o.w), onclick: () => { windowEpochs = o.w; drawChoices(); } },
          h("span", { class: "radio" }),
          h("span", null, h("b", null, o.name, o.tag && o.w === 0 ? h("span", { class: "tag" }, "Tips") : null, o.w > 0 ? h("span", { style: "color:var(--faint);font-weight:500;margin-left:8px;font-size:14px" }, `safety window ${eta(o.w)}`) : null), h("span", { class: "d" }, o.desc)),
        ),
      ),
    );
  };

  const update = (): void => {
    const a = amount();
    const short = needsFunds(a ?? 0n);
    const problem = challengeProblem();
    holdSelect.style.display = challenge() ? "" : "none";
    mount(
      challengeNote,
      problem ? h("div", { class: "note warn", style: "margin-top:8px" }, problem) : null,
      !problem && challenge() && profile && !bound ? h("div", { class: "note", style: "margin-top:8px" }, `@${profile.handle} hasn't linked a wallet yet. To collect a challenge gift they'll first link one (one post), then post your phrase.`) : null,
    );
    const ok = !!profile && !!a && a >= CONFIG.minDeposit && !busy && !short && !problem && !uploading && balanceKnown;
    sendBtn.disabled = !ok;
    // Say what's still needed instead of leaving a grey button (funds and challenge problems show their own notes).
    mount(
      whyEl,
      busy ? null : !profile ? "Enter who to send to." : !a ? "Enter an amount." : a < CONFIG.minDeposit ? `Send at least ${chain.formatTari(CONFIG.minDeposit)} ${CONFIG.symbol}.` : short ? `Add ${CONFIG.symbol} to your wallet first (see above).` : uploading ? "Preparing your picture…" : !balanceKnown ? "Checking your wallet balance…" : null,
    );
    const room = balance > SEND_FEE_ROOM ? balance - SEND_FEE_ROOM : 0n;
    mount(
      fundsEl,
      !short ? null : a && room > 0n
        ? h("div", { class: "note warn" }, `You have ${chain.formatTari(balance)} ${CONFIG.symbol}. A small network fee is kept back, so the most you can send is `, h("a", { href: "#", onclick: (e: Event) => { e.preventDefault(); amountInput.value = chain.formatTari(room).replace(/,/g, ""); update(); } }, `${chain.formatTari(room)}`), ".")
        : fundsNote(),
    );
    if (!busy) mount(sendBtn, profile ? `Send ${a ? chain.formatTari(a) : ""} ${CONFIG.symbol} to @${profile.handle}` : "Send");
  };

  const showWaiting = async (p: bsky.Profile): Promise<void> => {
    try {
      const esc = await chain.readEscrow(provider, p.did);
      noteEpoch(esc.epoch);
      if (profile?.did === p.did) {
        bound = esc.binding;
        update();
      }
      mount(
        waiting,
        esc.deposits.length || esc.laterDeposits.length ? h("div", { class: "note good", style: "margin-top:12px" }, `${chain.formatTari(chain.total([...esc.deposits, ...esc.laterDeposits]))} ${CONFIG.symbol} is already waiting for @${p.handle}.`) : null,
        h(
          "div",
          { class: "route " + (esc.binding ? "instant" : "claim"), style: "margin-top:12px" },
          h("span", { class: "badge" }, esc.binding ? "Instant" : "Needs a claim"),
          esc.binding
            ? `@${p.handle} has linked a wallet. A gift with no safety window and no phrase arrives there immediately.`
            : `@${p.handle} hasn't linked a wallet. They collect your gift by proving they own the account.`,
        ),
      );
    } catch {
      mount(waiting);
    }
  };

  amountInput.addEventListener("input", () => { update(); drawEnvelope(); });
  onBalance(update);
  noteInput.addEventListener("input", drawEnvelope);
  challengeInput.addEventListener("input", update);
  amountInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !sendBtn.disabled) sendBtn.click();
  });
  sendBtn.addEventListener("click", async () => {
    const a = amount();
    if (!profile || !a) return;
    busy = true;
    sendBtn.disabled = true;
    mount(sendBtn, ...spinnerLabel("Sending…"));
    mount(stage);
    const say = (s: string) => stage.appendChild(h("div", null, s));
    try {
      const esc = await chain.readEscrow(provider, profile.did);
      // the deposit commits to a hash of the envelope, so the bot's mention and the "Remind them" link can show it
      // and nobody else can put something different in its place
      const rec = env.cleanRecord({ e: style.id, m: noteInput.value, c: coverId, ...extras });
      const plain = env.isPlainEnvelope(rec);
      const envelope = plain ? "" : await env.envelopeHash(rec);
      // Who it's from, if the sender named themselves: recorded before sending, so nobody can name it first.
      const fromHandle = bsky.cleanHandle(fromInput.value);
      try {
        localStorage.setItem(FROM_KEY, fromHandle);
      } catch {
        /* not remembered */
      }
      if (fromHandle) {
        const me = await bsky.lookupProfile(fromHandle).catch(() => null);
        if (!me) throw new Error(`Couldn't find the Bluesky account “${fromHandle}” to say it's from. Fix it, or leave it empty to stay anonymous.`);
        await fetch("/api/from", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ did: profile.did, sender: myKeyHex, amount: a.toString(), from: me.did }) }).catch(() => undefined);
      }
      await chain.sendTip(wallet, { did: profile.did, amount: a, window: windowEpochs, challenge: challenge(), hold: hold(), envelope }, esc.epoch, !!esc.binding, say);
      if (!plain) void env.registerEnvelope(rec);
      await refreshBalance();
      done(profile, a, windowEpochs);
    } catch (e) {
      busy = false;
      toast(chain.friendly(e), "bad");
      update();
    }
  });

  const done = (p: bsky.Profile, a: bigint, w: number): void => {
    confetti();
    const note = env.cleanNote(noteInput.value);
    const link = env.shareLink(location.origin, p.handle, style.id, note, `${chain.formatTari(a)} ${CONFIG.symbol}`, coverId, extras);
    const noteLine = (note ? `\n“${note}”` : "") + (challenge() ? `\nTo collect it, your claim post also has to say: ${challenge()}${hold() ? ` (and stay up for ${eta(hold())})` : ""}` : "");
    const text = `@${p.handle} I just sent you ${chain.formatTari(a)} ${CONFIG.symbol} on Tari 🎁${noteLine}\nCollect it here (you prove you own this account, no wallet needed):\n${link}`;
    mount(
      card,
      h(
        "div",
        { class: "success" },
        h("div", { class: "delivered" }, "Dispatched"),
        h("h2", { class: "page", style: "margin:8px 0" }, "On its way"),
        h("p", { class: "sub" }, bound && !w && !challenge() ? `${chain.formatTari(a)} ${CONFIG.symbol} went straight to @${p.handle}'s linked wallet.` : `${chain.formatTari(a)} ${CONFIG.symbol} is now held on-chain for @${p.handle}. ${w ? `They can collect it after a safety window of ${eta(w)}.` : "They can collect it as soon as they verify."}`),
        profileCard(p),
      ),
      h("div", { class: "note" }, `The Skydrop bot (@${CONFIG.botHandle}) mentions them on Bluesky within a few minutes. Add a personal note of your own too, it's what gets noticed.`),
      h(
        "div",
        { class: "row" },
        h("a", { class: "btn primary bsky", href: bsky.composeUrl(text), target: "_blank", rel: "noopener" }, "Tell them on Bluesky", icons.external()),
        h("button", { class: "btn ghost", onclick: () => copy(link, "Link copied") }, icons.copy(), "Copy claim link"),
        h("a", { class: "btn ghost", href: "#/send", onclick: () => setTimeout(() => location.reload(), 0) }, "Send another"),
        h("a", { class: "btn ghost", href: "#/sent" }, "Your sends"),
      ),
      h("p", { class: "help" }, `If they haven't collected it in about ${eta(CONFIG.refundAfterEpochs)}, you can take it back.`),
    );
  };

  mount(
    card,
    h("div", null, h("label", { class: "f" }, "To (Bluesky handle)"), field.el, waiting),
    h("div", null, h("label", { class: "f" }, "Amount"), h("div", { class: "field" }, amountInput, h("span", { class: "suffix" }, CONFIG.symbol)), h("div", { class: "chips" }, ["0.1", "1", "5"].map((v) => h("button", { class: "q", onclick: () => { amountInput.value = v; update(); } }, v))), fundsEl),
    h(
      "details",
      { class: "opt", open: "" },
      h("summary", null, h("span", { class: "sum-main" }, "Personalize", h("span", { class: "tag" }, "optional")), personalSum),
      h(
        "div",
        { class: "stack", style: "margin-top:12px" },
        h("div", null, h("label", { class: "f" }, "From"), fromInput, h("p", { class: "help" }, "Your Bluesky handle, so the bot's message tells them who sent it. Leave it empty to stay anonymous.")),
        h("div", null, h("label", { class: "f" }, "Envelope and note"), pickEl, h("div", { class: "env-note" }, noteInput), previewEl, h("details", { class: "env-touches" }, h("summary", null, "More touches: pattern, seal, colour, font, burst"), moreEl), h("p", { class: "help" }, "The envelope and note travel in the claim link you share, so they see it when they open it.")),
      ),
    ),
    h("div", null, h("label", { class: "f" }, "Safety level"), choicesEl, h("p", { class: "help" }, "Each payment sets its own safety window. It protects against someone using a stolen Bluesky key to collect, by giving the real owner time to cancel it.")),
    h(
      "details",
      { class: "opt" },
      h("summary", null, h("span", { class: "sum-main" }, "Add a challenge", h("span", { class: "tag" }, "optional"))),
      h("div", { class: "stack", style: "margin-top:12px" }, h("p", { class: "help", style: "margin:0" }, "Ask them to post a specific phrase before the money is released. The contract checks it, and they link a wallet first. You can also require the post to stay up for a while."), challengeInput, challengeNote, holdSelect),
    ),
    h("div", { class: "send-bar" }, sendBtn, whyEl, stage),
  );
  drawChoices();
  drawEnvelope();
  update();
  layout("send", h("h1", { class: "page" }, "Send Tari to a Bluesky handle"), h("p", { class: "sub" }, "Held on-chain until they prove they own the account. ", h("a", { href: "#/sent" }, "Your sends")), card);
  if (!prefill && matchMedia("(pointer: fine)").matches) field.input.focus();
}

// ---------------------------------------------------------------------------------------------------------
// tips: a budget you fund once, then spend by posting "@bot tip @someone 5"
// ---------------------------------------------------------------------------------------------------------

function renderTips(prefill?: string): void {
  let profile: bsky.Profile | null = null;
  let budget: chain.Budget | null = null;
  let windowEpochs = 0;
  let busy = false;

  const field = handleField(prefill ?? "", (p) => {
    profile = p;
    budget = null;
    void loadBudget();
    update();
  });
  const amountInput = h("input", { class: "input big", inputmode: "decimal", placeholder: "10", "aria-label": "Budget" }) as HTMLInputElement;
  const maxInput = h("input", { class: "input", inputmode: "decimal", value: "1", "aria-label": "Largest single tip" }) as HTMLInputElement;
  const stage = h("div", { class: "log" });
  const choicesEl = h("div", { class: "choices", role: "radiogroup", "aria-label": "Safety level for tips" });
  const fundBtn = h("button", { class: "btn primary block" }, "Fund tip budget") as HTMLButtonElement;
  const statusEl = h("div");
  const howEl = h("div");
  const card = h("div", { class: "card stack" });

  const drawChoices = (): void => {
    mount(
      choicesEl,
      WINDOWS.map((o) =>
        h(
          "button",
          { class: "choice", role: "radio", "aria-checked": String(windowEpochs === o.w), onclick: () => { windowEpochs = o.w; drawChoices(); } },
          h("span", { class: "radio" }),
          h("span", null, h("b", null, o.name), h("span", { class: "d" }, o.desc)),
        ),
      ),
    );
  };

  const loadBudget = async (): Promise<void> => {
    if (!profile) return void mount(statusEl);
    try {
      budget = await chain.readBudget(provider, profile.did, myKeyHex);
    } catch {
      budget = null;
    }
    drawStatus();
    drawHow();
    update();
  };

  const drawStatus = (): void => {
    if (!profile) return void mount(statusEl);
    if (!budget) return void mount(statusEl, h("div", { class: "note", style: "margin-top:4px" }, `No tip budget yet for @${profile.handle}. Fund one below.`));
    const b = budget;
    const withdraw = h("button", { class: "btn ghost sm" }, "Withdraw it all") as HTMLButtonElement;
    withdraw.addEventListener("click", async () => {
      if (busy || !profile) return;
      busy = true;
      withdraw.disabled = true;
      mount(withdraw, ...spinnerLabel("Withdrawing…"));
      try {
        await chain.closeBudget(wallet, profile.did, b.balance, (s) => stage.appendChild(h("div", null, s)));
        await refreshBalance();
        toast("Budget withdrawn", "good");
      } catch (e) {
        toast(chain.friendly(e), "bad");
      }
      busy = false;
      await loadBudget();
    });
    mount(
      statusEl,
      h(
        "div",
        { class: "note good", style: "margin-top:4px" },
        h("div", null, h("b", null, `${chain.formatTari(b.balance)} ${CONFIG.symbol}`), ` left in your tip budget for @${profile.handle}. Up to ${chain.formatTari(b.maxTip)} per tip.`),
        h("div", { class: "row", style: "margin-top:8px" }, withdraw),
      ),
    );
  };

  // A composer, so nobody has to remember the exact line: the contract only accepts "@bot tip @them <amount>".
  const tipWho = h("input", { class: "input", placeholder: "who.bsky.social", autocomplete: "off", autocapitalize: "off", spellcheck: "false", "aria-label": "Who to tip" }) as HTMLInputElement;
  const tipAmt = h("input", { class: "input", inputmode: "decimal", value: "1", "aria-label": "Tip amount" }) as HTMLInputElement;
  const tipOut = h("div");
  const drawTipText = (): void => {
    const who = bsky.cleanHandle(tipWho.value);
    const handle = who && /^[a-z0-9-]+$/.test(who) ? `${who}.bsky.social` : who;
    const a = chain.parseTari(tipAmt.value);
    const over = !!a && !!budget && (a > budget.maxTip || a > budget.balance);
    const text = `@${CONFIG.botHandle} tip @${handle || "them.bsky.social"} ${a ? chain.formatTari(a).replace(/,/g, "") : "1"}`;
    mount(
      tipOut,
      h("div", { class: "codebox" }, text),
      over ? h("div", { class: "note warn", style: "margin-top:8px" }, `That's over your ${a! > budget!.maxTip ? `per-tip limit of ${chain.formatTari(budget!.maxTip)}` : `budget of ${chain.formatTari(budget!.balance)}`} ${CONFIG.symbol}.`) : null,
      h(
        "div",
        { class: "row", style: "margin-top:10px" },
        handle && a && !over
          ? h("a", { class: "btn bsky sm", href: bsky.composeUrl(text), target: "_blank", rel: "noopener" }, "Post this tip", icons.external(14))
          : h("button", { class: "btn bsky sm", disabled: "" }, "Post this tip"),
        h("button", { class: "btn ghost sm", onclick: () => copy(text, "Text copied") }, icons.copy(14), "Copy"),
      ),
    );
  };
  tipWho.addEventListener("input", drawTipText);
  tipAmt.addEventListener("input", drawTipText);
  const drawHow = (): void => {
    if (!profile || !budget) return void mount(howEl);
    drawTipText();
    mount(
      howEl,
      h("div", { class: "kv" }, h("div", { class: "k" }, "Send a tip")),
      h("div", { class: "tip-compose" }, h("div", { class: "field" }, tipWho), h("div", { class: "field" }, tipAmt, h("span", { class: "suffix" }, CONFIG.symbol))),
      tipOut,
      h("p", { class: "help" }, `Post it from @${profile.handle} exactly as shown, with nothing else in the post: Bluesky turns both handles into real mentions. The bot relays it to the contract, which checks your signature itself, and replies when it's sent. Each post tips once.`),
    );
  };


  const whyEl = h("div", { class: "why", "aria-live": "polite" });
  const update = (): void => {
    const a = chain.parseTari(amountInput.value);
    const m = chain.parseTari(maxInput.value);
    const missing = !profile
      ? "Enter your Bluesky account to start."
      : !a
        ? "Enter how much to put aside."
        : a < CONFIG.minDeposit
          ? `Put aside at least ${chain.formatTari(CONFIG.minDeposit)} ${CONFIG.symbol}.`
          : !m || m < CONFIG.minDeposit
            ? `Set a largest tip of at least ${chain.formatTari(CONFIG.minDeposit)} ${CONFIG.symbol}.`
            : needsFunds(a)
              ? null
              : !balanceKnown
                ? "Checking your wallet balance…"
                : "";
    fundBtn.disabled = busy || missing !== "";
    mount(whyEl, busy || missing === "" ? null : missing ?? fundsNote());
    if (!busy) mount(fundBtn, budget ? "Add to tip budget" : "Fund tip budget");
  };

  amountInput.addEventListener("input", update);
  maxInput.addEventListener("input", update);
  onBalance(update);
  fundBtn.addEventListener("click", async () => {
    const a = chain.parseTari(amountInput.value);
    const m = chain.parseTari(maxInput.value);
    if (!profile || !a || !m) return;
    busy = true;
    fundBtn.disabled = true;
    mount(fundBtn, ...spinnerLabel("Funding…"));
    mount(stage);
    try {
      await chain.openBudget(wallet, { did: profile.did, amount: a, window: windowEpochs, refundAfter: CONFIG.refundAfterEpochs, maxTip: m }, (s) => stage.appendChild(h("div", null, s)));
      await refreshBalance();
      toast("Tip budget funded", "good");
      amountInput.value = "";
    } catch (e) {
      toast(chain.friendly(e), "bad");
    }
    busy = false;
    await loadBudget();
  });

  mount(
    card,
    h("div", null, h("label", { class: "f" }, "Your Bluesky account"), field.el, statusEl),
    h("div", null, h("label", { class: "f" }, "Put aside"), h("div", { class: "field" }, amountInput, h("span", { class: "suffix" }, CONFIG.symbol))),
    h("div", null, h("label", { class: "f" }, "Largest single tip"), h("div", { class: "field" }, maxInput, h("span", { class: "suffix" }, CONFIG.symbol)), h("p", { class: "help" }, "A hard cap per post. Keep it small: it limits what a stolen Bluesky key could spend.")),
    h("div", null, h("label", { class: "f" }, "Safety level for people you tip"), choicesEl),
    h("div", null, fundBtn, whyEl, stage),
    howEl,
    h("p", { class: "help" }, `Only the wallet that funded the budget can withdraw it, any time. Anyone who controls the Bluesky account can spend it by posting a tip, so only put aside what you are happy to tip. The network fee for each tip (about 0.06 ${CONFIG.symbol}) comes out of the budget.`),
  );
  drawChoices();
  update();
  layout("tips", h("h1", { class: "page" }, "Tip by posting"), h("p", { class: "sub" }, `Fund a budget once. Then tip anyone by posting "@${CONFIG.botHandle} tip @them 5".`), card);
  if (!prefill && matchMedia("(pointer: fine)").matches) field.input.focus();
}

// ---------------------------------------------------------------------------------------------------------
// tip jars: skydrop.tari.mw/tip/<handle>, the link a creator puts in their bio. Two taps to tip them.
// ---------------------------------------------------------------------------------------------------------

const TIP_AMOUNTS = ["1", "5", "10", "25"];
const TIP_PICK_KEY = "skydrop.tipAmount";
/** A creator's tip jar link. The path form gets a preview card on Bluesky; the worker sends it on to #/tip/<handle>. */
const tipJarLink = (handle: string): string => `${location.origin}/tip/${handle}`;
const tipJarPost = (handle: string): string => `Like what I post? You can tip me in ${CONFIG.symbol} on Skydrop 💧\n${tipJarLink(handle)}`;
/** "alice" means alice.bsky.social, as in the handle fields. */
const fullHandle = (s: string): string => {
  const bare = bsky.cleanHandle(s);
  return /^[a-z0-9-]+$/.test(bare) ? `${bare}.bsky.social` : s;
};

/** Records who a gift is from before it's sent, so nobody else can name a sender first. Throws if the handle is unknown. */
async function recordFrom(recipient: string, amount: bigint, fromInput: string): Promise<void> {
  const fromHandle = bsky.cleanHandle(fromInput);
  try {
    localStorage.setItem(FROM_KEY, fromHandle);
  } catch {
    /* not remembered */
  }
  if (!fromHandle) return;
  const me = await bsky.lookupProfile(fullHandle(fromHandle)).catch(() => null);
  if (!me) throw new Error(`Couldn't find the Bluesky account “${fromHandle}” to say it's from. Fix it, or leave it empty to stay anonymous.`);
  await fetch("/api/from", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ did: recipient, sender: myKeyHex, amount: amount.toString(), from: me.did }) }).catch(() => undefined);
}

/** "Your tip jar": the link, copy, and a ready-made post. */
function tipJarBox(handle: string): HTMLElement {
  const link = tipJarLink(handle);
  return h(
    "div",
    { class: "jar-box" },
    h("div", { class: "kv" }, h("div", { class: "k" }, "Your tip jar")),
    h("div", { class: "codebox jar-link" }, link.replace(/^https?:\/\//, "")),
    h(
      "div",
      { class: "row" },
      h("button", { class: "btn primary sm", onclick: () => copy(link, "Tip jar link copied") }, icons.copy(14), "Copy link"),
      h("a", { class: "btn bsky sm", href: bsky.composeUrl(tipJarPost(handle)), target: "_blank", rel: "noopener" }, "Post it on Bluesky", icons.external(14)),
      h("a", { class: "btn ghost sm", href: `#/tip/${handle}` }, "Preview"),
    ),
    h("p", { class: "help" }, "Put it in your Bluesky bio or pin the post. Anyone can tip you in two taps, and the Skydrop bot tells you when one arrives."),
  );
}

function renderTipJar(prefill?: string, q: URLSearchParams = new URLSearchParams()): void {
  let profile: bsky.Profile | null = null;
  let busy = false;
  let picked = "";
  try {
    picked = localStorage.getItem(TIP_PICK_KEY) ?? "";
  } catch {
    /* no remembered amount */
  }
  const preset = q.get("a") ?? "";
  if (preset && chain.parseTari(preset)) picked = preset;
  if (!picked || !chain.parseTari(picked)) picked = "5";

  const head = h("div", { class: "jar-head" });
  const routeEl = h("div");
  const amountsEl = h("div", { class: "tip-amts", role: "radiogroup", "aria-label": "Tip amount" });
  const otherInput = h("input", { class: "input", inputmode: "decimal", placeholder: "Other amount", "aria-label": "Other amount" }) as HTMLInputElement;
  if (!TIP_AMOUNTS.includes(picked)) otherInput.value = picked;
  const noteInput = h("input", { class: "input", maxlength: String(env.MAX_NOTE), placeholder: "Thanks for the great posts!", "aria-label": "A note with your tip (optional)" }) as HTMLInputElement;
  const noteQ = env.cleanNote(q.get("m") ?? "");
  if (noteQ) noteInput.value = noteQ;
  const fromInput = h("input", { class: "input", placeholder: "yourname.bsky.social", autocomplete: "off", autocapitalize: "off", spellcheck: "false", "aria-label": "Your Bluesky handle (optional)" }) as HTMLInputElement;
  try {
    fromInput.value = localStorage.getItem(FROM_KEY) ?? "";
  } catch {
    /* not remembered */
  }
  const tipBtn = h("button", { class: "btn primary block" }, "Tip") as HTMLButtonElement;
  const whyEl = h("div", { class: "why", "aria-live": "polite" });
  const fundsEl = h("div");
  const stage = h("div", { class: "log" });
  const card = h("div", { class: "card stack jar" });

  const amount = (): bigint | null => chain.parseTari(otherInput.value.trim() || picked);

  const drawAmounts = (): void => {
    const other = otherInput.value.trim();
    mount(
      amountsEl,
      TIP_AMOUNTS.map((v) =>
        h(
          "button",
          { class: "tip-amt", role: "radio", "aria-checked": String(!other && picked === v), onclick: () => { picked = v; otherInput.value = ""; drawAmounts(); update(); } },
          h("b", null, v),
          h("small", null, CONFIG.symbol),
        ),
      ),
    );
  };

  const update = (): void => {
    const a = amount();
    const short = needsFunds(a ?? 0n);
    tipBtn.disabled = !profile || !a || a < CONFIG.minDeposit || busy || short || !balanceKnown;
    mount(
      whyEl,
      busy ? null : !profile ? "Enter who to tip." : !a ? "Pick an amount." : a < CONFIG.minDeposit ? `Tip at least ${chain.formatTari(CONFIG.minDeposit)} ${CONFIG.symbol}.` : !balanceKnown ? "Checking your wallet balance…" : null,
    );
    const room = balance > SEND_FEE_ROOM ? balance - SEND_FEE_ROOM : 0n;
    mount(
      fundsEl,
      !short ? null : a && room >= CONFIG.minDeposit
        ? h("div", { class: "note warn", style: "margin-top:10px" }, `You have ${chain.formatTari(balance)} ${CONFIG.symbol}. After the network fee you can tip up to `, h("a", { href: "#", onclick: (e: Event) => { e.preventDefault(); otherInput.value = chain.formatTari(room).replace(/,/g, ""); drawAmounts(); update(); } }, chain.formatTari(room)), ".")
        : h("div", { style: "margin-top:10px" }, fundsNote()),
    );
    if (!busy) mount(tipBtn, profile && a ? `Tip ${chain.formatTari(a)} ${CONFIG.symbol}` : "Tip");
  };

  const drawHead = (p: bsky.Profile): void => {
    mount(
      head,
      p.avatar ? h("img", { class: "jar-av", src: p.avatar, alt: "", width: 88, height: 88 }) : h("div", { class: "jar-av avatar" }),
      h("h1", { class: "page jar-title" }, "Tip ", p.displayName),
      p.displayName !== p.handle ? h("div", { class: "jar-handle" }, `@${p.handle}`) : null,
      p.description ? h("p", { class: "jar-bio" }, p.description.length > 160 ? `${p.description.slice(0, 157).trimEnd()}…` : p.description) : null,
    );
  };

  const loadRoute = async (p: bsky.Profile): Promise<void> => {
    try {
      const esc = await chain.readEscrow(provider, p.did);
      noteEpoch(esc.epoch);
      if (profile?.did !== p.did) return;
      mount(
        routeEl,
        h(
          "div",
          { class: "route " + (esc.binding ? "instant" : "claim") },
          h("span", { class: "badge" }, esc.binding ? "Instant" : "One post"),
          esc.binding ? `Lands straight in @${p.handle}'s wallet.` : `@${p.handle} collects it by posting once from their account. The Skydrop bot tells them it's waiting.`,
        ),
      );
    } catch {
      mount(routeEl);
    }
  };

  const blankHead = (): void => mount(head, h("h1", { class: "page" }, "Tip anyone on Bluesky"), h("p", { class: "sub" }, `Type their handle, pick an amount. They get it in ${CONFIG.symbol} on Tari.`));
  const setProfile = (p: bsky.Profile | null): void => {
    profile = p;
    mount(routeEl);
    if (p) {
      drawHead(p);
      document.title = `Tip @${p.handle} · Skydrop`;
      void loadRoute(p);
    } else if (!prefill) blankHead();
    update();
  };

  // With a handle in the link there's nothing to type: the page is just them and the amounts.
  const field = handleField("", setProfile);
  const whoEl = h("div", null, h("label", { class: "f" }, "Who to tip"), field.el);

  otherInput.addEventListener("input", () => { drawAmounts(); update(); });
  otherInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !tipBtn.disabled) tipBtn.click();
  });
  onBalance(update);

  tipBtn.addEventListener("click", async () => {
    const a = amount();
    const p = profile;
    if (!p || !a || busy) return;
    busy = true;
    tipBtn.disabled = true;
    mount(tipBtn, ...spinnerLabel("Tipping…"));
    mount(stage);
    const say = (s: string) => stage.appendChild(h("div", null, s));
    try {
      await balanceReady;
      if (needsFunds(a)) throw new Error(`Add ${CONFIG.symbol} to your wallet first.`);
      try {
        localStorage.setItem(TIP_PICK_KEY, otherInput.value.trim() || picked);
      } catch {
        /* not remembered */
      }
      const esc = await chain.readEscrow(provider, p.did);
      const rec = env.cleanRecord({ e: "air", m: noteInput.value });
      const plain = env.isPlainEnvelope(rec);
      const envelope = plain ? "" : await env.envelopeHash(rec);
      await recordFrom(p.did, a, fromInput.value);
      await chain.sendTip(wallet, { did: p.did, amount: a, window: 0, challenge: "", hold: 0, envelope }, esc.epoch, !!esc.binding, say);
      if (!plain) void env.registerEnvelope(rec);
      await refreshBalance();
      done(p, a, !!esc.binding, env.cleanNote(noteInput.value));
    } catch (e) {
      busy = false;
      toast(chain.friendly(e), "bad");
      update();
    }
  });

  const done = (p: bsky.Profile, a: bigint, instant: boolean, note: string): void => {
    confetti();
    const link = env.shareLink(location.origin, p.handle, "air", note, `${chain.formatTari(a)} ${CONFIG.symbol}`, "");
    const text = `@${p.handle} I just tipped you ${chain.formatTari(a)} ${CONFIG.symbol} 💧${note ? `\n“${note}”` : ""}${instant ? "" : `\nCollect it here, no wallet needed:\n${link}`}`;
    mount(
      card,
      h(
        "div",
        { class: "success" },
        h("div", { class: "delivered" }, "Tipped"),
        h("h2", { class: "page", style: "margin:8px 0" }, `${chain.formatTari(a)} ${CONFIG.symbol} to @${p.handle}`),
        h("p", { class: "sub" }, instant ? "It's already in their wallet." : "It's waiting for them on-chain. The Skydrop bot lets them know within a few minutes."),
      ),
      h(
        "div",
        { class: "row" },
        h("a", { class: "btn primary bsky", href: bsky.composeUrl(text), target: "_blank", rel: "noopener" }, "Tell them on Bluesky", icons.external()),
        h("button", { class: "btn ghost", onclick: () => renderTipJar(p.handle) }, "Tip again"),
        h("a", { class: "btn ghost", href: "#/sent" }, "Your sends"),
      ),
      h("div", { class: "note" }, "Want tips too? ", h("a", { href: "#/jar" }, "Get your own tip jar link"), " for your bio."),
      h("p", { class: "help" }, instant ? "" : `If it isn't collected in about ${eta(CONFIG.refundAfterEpochs)}, you can take it back.`),
    );
  };

  mount(
    card,
    prefill ? null : whoEl,
    routeEl,
    h("div", null, h("label", { class: "f" }, "Amount"), amountsEl, h("div", { class: "field", style: "margin-top:10px" }, otherInput, h("span", { class: "suffix" }, CONFIG.symbol)), fundsEl),
    h(
      "details",
      { class: "opt" },
      h("summary", null, h("span", { class: "sum-main" }, "Add a note", h("span", { class: "tag" }, "optional"))),
      h(
        "div",
        { class: "stack", style: "margin-top:12px" },
        noteInput,
        h("div", null, h("label", { class: "f" }, "From"), fromInput, h("p", { class: "help" }, "Your handle, so they know who it's from. Empty means anonymous.")),
      ),
    ),
    h("div", { class: "send-bar" }, tipBtn, whyEl, stage),
  );
  if (noteQ) card.querySelector("details")?.setAttribute("open", "");
  drawAmounts();
  if (prefill) mount(head, h("div", { class: "skel" }));
  setProfile(null);
  layout("tip", head, card, h("p", { class: "help jar-foot" }, "The Skydrop contract on Tari holds tips until they're collected. ", h("a", { href: "#/jar" }, "Get your own tip jar")));
  if (prefill) {
    bsky
      .lookupProfile(fullHandle(prefill))
      .then(setProfile)
      .catch((e) => {
        mount(head, h("h1", { class: "page" }, "Tip anyone on Bluesky"), h("div", { class: "note bad" }, e instanceof Error ? e.message : String(e)));
        card.prepend(whoEl);
      });
  } else if (matchMedia("(pointer: fine)").matches) field.input.focus();
}

/** Where a creator gets their tip jar link. */
function renderJar(prefill?: string): void {
  const out = h("div");
  const field = handleField(prefill ?? lastHandle(), (p) => {
    if (p) saveHandle(p.handle);
    mount(out, p ? tipJarBox(p.handle) : null);
  });
  layout(
    "tip",
    h("h1", { class: "page" }, "Get tipped on Bluesky"),
    h("p", { class: "sub" }, `One link for your bio. Anyone can tip you ${CONFIG.symbol} in two taps.`),
    h(
      "div",
      { class: "card stack" },
      h("div", null, h("label", { class: "f" }, "Your Bluesky account"), field.el),
      out,
      h(
        "div",
        null,
        h("div", { class: "kv" }, h("div", { class: "k" }, "Collecting your tips")),
        h("p", { class: "help", style: "margin:0" }, "Tips wait on-chain under your account. ", h("a", { href: "#/link" }, "Link a wallet once"), " and every tip lands in it instantly. Otherwise ", h("a", { href: "#/claim" }, "collect them"), " with one post whenever you like."),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------------------------------------
// link a wallet to a Bluesky account
// ---------------------------------------------------------------------------------------------------------

/** The three steps of a challenge gift, shown on the link and collect pages so people always know where they are. */
function flowBar(now: 1 | 2 | 3): HTMLElement {
  const labels = ["Link your wallet", "Post the phrase", "Get paid"];
  return h(
    "ol",
    { class: "flow", "aria-label": "Steps" },
    labels.map((t, i) => h("li", { class: i + 1 < now ? "done" : i + 1 === now ? "active" : "" }, h("span", { class: "fn" }, i + 1 < now ? icons.check(14) : String(i + 1)), h("span", { class: "ft" }, t))),
  );
}

function renderLink(prefill?: string, flow = false): void {
  let profile: bsky.Profile | null = null;
  let code = "";
  let busy = false;
  let current: string | null = null;
  // the account to link: this wallet by default, or any account the owner pastes
  let target = wallet.componentAddress;
  // the key that owns the linked wallet: it is what signs a later decline
  let targetOwner = pubKey;
  let changing = false;
  let submitted = "";
  let addrProblem = "";
  const mine = (): string => target;
  const card = h("div", { class: "card stack" });
  const stepsEl = h("div");
  const logEl = h("div", { class: "log" });
  const say = (s: string) => logEl.appendChild(h("div", null, s));
  const field = handleField(prefill ?? lastHandle(), (p) => {
    profile = p;
    if (p) saveHandle(p.handle);
    void load();
  });

  const load = async (): Promise<void> => {
    if (!profile) return mount(stepsEl);
    mount(stepsEl, h("div", { class: "skel" }));
    // The link registry verifies at most 16 identity operations: say so before asking for a post that can't work.
    const opsNow = (await bsky.currentChain(profile.did).catch(() => null))?.ops.length ?? 0;
    if (opsNow > 16) {
      mount(stepsEl, h("div", { class: "note warn" }, `@${profile.handle} has ${opsNow} identity operations, and linking a wallet works for up to 16 for now. You can still collect gifts with a claim post on the Collect page.`));
      return;
    }
    code = await bsky.bindCode(CONFIG.link, profile.did, mine(), targetOwner);
    current = await chain.readBinding(provider, profile.did);
    draw();
  };

  const useAddress = async (raw: string): Promise<void> => {
    const a = raw.trim();
    addrProblem = "";
    let account = "";
    let owner: Uint8Array | null = null;
    if (!a.startsWith("otl_")) addrProblem = "Paste a Tari wallet address (it starts with otl_).";
    else {
      const bad = chain.addressProblem(a, wallet.walletAddress);
      if (bad && bad !== "That's this wallet's own address.") addrProblem = bad;
      else {
        account = chain.accountOf(a);
        rememberAddress(account, a);
        owner = chain.ownerOf(a);
        try {
          await provider.getSubstate(account);
        } catch {
          addrProblem = `That wallet doesn't exist on this network yet. Send it some ${CONFIG.symbol} first, then link it.`;
        }
      }
    }
    if (!addrProblem && profile && owner) {
      target = account;
      targetOwner = owner;
      code = await bsky.bindCode(CONFIG.link, profile.did, target, targetOwner);
      changing = false;
    }
    draw();
  };

  const post = (): string => `Linking my Skydrop wallet to this account, so tips arrive directly. ${code}`;

  /**
   * A wallet with no TARI can't pay the link's fee, so Skydrop's bot submits the post instead (anyone may: the post is
   * the authority). It checks everything on-chain itself and only pays for a wallet that's empty.
   */
  const linkForFree = async (did: string): Promise<void> => {
    say("Your wallet has no TARI, so Skydrop pays the fee to link it. This takes up to a minute");
    const r = await fetch("/api/relay-claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "link", did, account: mine(), owner: toHex(targetOwner) }) });
    if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `Skydrop couldn't link it for free right now. Add a little ${CONFIG.symbol} to your wallet and try again.`);
    for (let i = 0; i < 18; i++) {
      await new Promise((res) => setTimeout(res, 10_000));
      const e = await chain.readEscrow(provider, did).catch(() => null);
      if (e && (e.binding === mine() || e.bindingPending?.address === mine())) return;
    }
    throw new Error(`Skydrop couldn't link it this time. Add a little ${CONFIG.symbol} to your wallet and try again.`);
  };

  const runBind = async (): Promise<void> => {
    if (!profile || busy) return;
    await balanceReady;
    busy = true;
    mount(logEl);
    try {
      say("Looking for your post on Bluesky");
      const found = await bsky.findClaimPost(profile.did, code);
      if (!found) throw new Error("We couldn't find a post containing your link code yet. Post it publicly, wait a few seconds, then try again.");
      if (needsFunds()) await linkForFree(profile.did);
      else {
        say("Fetching the signed copy of your post");
        const proof = await bsky.buildClaimProof(profile.did, found.rkey);
        say("Submitting the proof. The contract checks every signature itself");
        await chain.bindAccount(wallet, proof, mine(), targetOwner, say);
      }
      await refreshBalance();
      submitted = target;
      toast("Wallet linked", "good");
      confetti();
      current = await chain.readBinding(provider, profile.did);
      // with no delay the link is live now: carry on to the next step of a challenge gift
      if (flow && current === mine()) {
        const handle = profile.handle;
        const t = window.setTimeout(() => { location.hash = `#/claim/${handle}`; }, 1800);
        cleanups.push(() => clearTimeout(t));
      }
    } catch (e) {
      toast(chain.friendly(e), "bad");
    }
    busy = false;
    draw();
  };

  const watch = window.setInterval(async () => {
    if (profile && submitted === mine() && current !== mine() && !busy) {
      // the link takes a couple of epochs to take effect (so a stolen old key can't redirect your money): wait for it
      try {
        current = await chain.readBinding(provider, profile.did);
      } catch {
        /* retried on the next tick */
      }
      if (current === mine()) {
        draw();
        if (flow) {
          const handle = profile.handle;
          const t = window.setTimeout(() => { location.hash = `#/claim/${handle}`; }, 1800);
          cleanups.push(() => clearTimeout(t));
        }
      }
      return;
    }
    if (!profile || busy || current === mine() || submitted === mine() || wallet.kind !== "builtin" || !balanceKnown) return;
    try {
      if (await bsky.findClaimPost(profile.did, code)) void runBind();
    } catch {
      /* retried on the next tick */
    }
  }, 5000);
  cleanups.push(() => clearInterval(watch));

  const draw = (): void => {
    if (!profile) return;
    const p = profile;
    const addrInput = h("input", { class: "input", placeholder: "otl_…", "aria-label": "Address to link" }) as HTMLInputElement;
    const changer = changing
      ? h("div", { class: "stack", style: "margin-top:10px" }, h("label", { class: "f" }, "Link a different account"), addrInput, addrProblem ? h("div", { class: "note bad" }, addrProblem) : null, h("div", { class: "row" }, h("button", { class: "btn primary sm", onclick: () => void useAddress(addrInput.value) }, "Use this address"), h("button", { class: "btn ghost sm", onclick: () => { changing = false; addrProblem = ""; draw(); } }, "Cancel")))
      : h("button", { class: "btn ghost sm", onclick: () => { changing = true; draw(); } }, "Change address");
    if (submitted === target && current !== target) {
      mount(stepsEl, h("div", { class: "note good" }, `Link submitted. It takes effect in about ${eta(CONFIG.bindDelayEpochs)}: the wait lets anyone stop it if it was made with a stolen key. ${flow ? "Keep this page open and we'll carry on for you." : ""}`), changer);
      return;
    }
    const where = target === wallet.componentAddress ? "this wallet" : displayAddress(target);
    // name the address too, so "this wallet" is never a mystery
    const whereFull = target === wallet.componentAddress ? `this wallet (${short(target, 10, 6)})` : where;
    if (current === mine()) {
      mount(stepsEl, flow ? flowBar(2) : null, h("div", { class: "card success" }, h("div", { class: "delivered" }, "Linked"), h("h2", { class: "page", style: "margin:8px 0" }, `Tips arrive straight in ${where}`), h("p", { class: "sub" }, `@${p.handle} is linked to ${where}. Gifts with no safety window and no phrase are paid there the moment they are sent. Anything with a challenge is released when you post its phrase in a new post, and paid there too.`), h("div", { class: "row", style: "justify-content:center" }, h("a", { class: "btn primary", href: `#/claim/${p.handle}` }, flow ? "Next: post the phrase" : "Collect what's waiting")), profileCard(p)), changer);
      return;
    }
    mount(
      stepsEl,
      flow ? flowBar(1) : null,
      current ? h("div", { class: "note warn" }, `@${p.handle} is currently linked to ${displayAddress(current)}. Linking ${where} instead takes effect after a short wait (about ${eta(CONFIG.bindDelayEpochs)}); until then the old one keeps receiving.`) : null,
      changing
        ? h("div", { class: "stack" }, h("div", { class: "note" }, `Linking ${whereFull}.`), changer)
        : h("div", { class: "note linkrow" }, h("span", null, `Linking ${whereFull}.`), changer),
      h(
        "div",
        { class: "steps", style: "margin-top:8px" },
        h("div", { class: "step active" }, h("div", { class: "num" }, flow ? "a" : "1"), h("div", null, h("h3", null, "Post this on Bluesky"), h("p", null, "It proves the account is yours. The code ties it to this address, so it can't link anyone else."), h("div", { class: "codebox" }, post()), h("div", { class: "row", style: "margin-top:12px" }, h("a", { class: "btn bsky sm", href: bsky.composeUrl(post()), target: "_blank", rel: "noopener" }, "Open Bluesky", icons.external(14)), h("button", { class: "btn ghost sm", onclick: () => copy(post(), "Text copied") }, icons.copy(14), "Copy")))),
        h("div", { class: "step active" }, h("div", { class: "num" }, flow ? "b" : "2"), h("div", null, h("h3", null, "Link it"), h("p", null, needsFunds() ? `We watch for the post and link it for you. Your wallet has no ${CONFIG.symbol}, so Skydrop pays the tiny network fee.` : "We watch for the post and link it for you. A tiny network fee comes from your wallet."), h("button", { class: "btn primary", onclick: () => void runBind() }, "I've posted it. Link it"), logEl)),
      ),
    );
  };

  // the fee note follows the balance
  onBalance(() => { if (!busy) draw(); });
  mount(card, h("div", null, h("label", { class: "f" }, "Your Bluesky account"), field.el), stepsEl);
  layout("link", h("h1", { class: "page" }, "Link your wallet"), h("p", { class: "sub" }, flow ? "Step 1 of 3. Link your wallet once with a Bluesky post. Then you post the sender's phrase, and the money goes to this wallet." : "Do it once, and gifts with no safety window and no phrase land in your wallet instantly. Nothing to claim."), card);
  if (!prefill && matchMedia("(pointer: fine)").matches) field.input.focus();
  void load();
}

// ---------------------------------------------------------------------------------------------------------
// collect
// ---------------------------------------------------------------------------------------------------------

function giftEl(g: Gift): HTMLElement {
  const e = env.envelope(g.style, g.note, { coverUrl: g.cover ? `/c/${g.cover}.jpg` : undefined, extras: g.extras, onToggle: () => wrap.querySelector(".from")?.remove() });
  const wrap = h("div", { class: "env-hello" }, e, h("p", { class: "from" }, "Tap the envelope"));
  return wrap;
}

interface Gift { style: env.Style; note: string; cover: string; extras: env.Extras }

function renderClaim(prefill?: string, gift?: Gift): void {
  let profile: bsky.Profile | null = null;
  let esc: chain.Escrow | null = null;
  let code = "";
  let busy = false;
  let collected: bigint | null = null;
  let sponsorOk = false;
  /** Who each waiting gift says it's from, by its position in the escrow's list (absent: anonymous). */
  let fromOf = new Map<number, { handle: string; verified: boolean }>();
  // The page does the waiting for you: it watches for the post, verifies, and collects when the payout is due.
  // Anything that fails switches this off so you get the buttons and the error instead of a retry loop.
  let autoVerify: (() => Promise<void>) | null = null;
  let autoCollect: (() => Promise<void>) | null = null;
  let autoConfirm: (() => Promise<void>) | null = null;
  let autoOff = false;
  let watching = true;
  let checking = false;
  const canAuto = (): boolean => !autoOff && wallet.kind === "builtin";
  // Phrases senders asked for. The post has to contain the ones that fit in it; deposits whose phrase didn't fit stay escrowed.
  const claimPost = (): { text: string; used: string[]; dropped: number } =>
    bsky.claimPostText(CONFIG.symbol, codeNow(), esc?.binding ? [...new Set((esc?.deposits ?? []).map((d) => d.challenge).filter(Boolean))] : []);
  // A linked account's payouts go to its linked address, so its challenge post needs the sender's phrase only.
  const codeNow = (): string => (esc?.binding && esc.deposits.some((d) => d.challenge) ? "" : code);

  const stepsEl = h("div");
  const field = handleField(prefill ?? lastHandle(), (p) => {
    profile = p;
    esc = null;
    collected = null;
    autoOff = false;
    watching = true;
    if (p) saveHandle(p.handle);
    void load();
  });

  const load = async (): Promise<void> => {
    if (!profile) return mount(stepsEl);
    mount(stepsEl, h("div", { class: "skel" }), h("div", { class: "skel" }));
    sponsorOk = wallet.account !== null && (await chain.readSponsorBalance(provider)) >= chain.SPONSOR_FEE * 3n;
    await reload();
  };

  const reload = async (): Promise<void> => {
    if (!profile) return;
    try {
      esc = await chain.readEscrow(provider, profile.did);
      const did = profile.did;
      const named = await Promise.all([...esc.deposits, ...esc.laterDeposits].map(async (d) => [d.index, await giftFrom(did, d)] as const));
      fromOf = new Map(named.filter((x): x is readonly [number, { handle: string; verified: boolean }] => !!x[1]));
      // The code names the ClaimPolicy this account's claim goes through: v1 while it has gifts made before v2, else v2.
      code = await bsky.claimCode(chain.claimComponentFor(profile.did), profile.did, pubKey);
      noteEpoch(esc.epoch);
      draw();
    } catch (e) {
      mount(stepsEl, h("div", { class: "note bad" }, chain.friendly(e)));
    }
  };

  onBalance(() => { if (profile && esc && !busy) draw(); });
  const poll = window.setInterval(() => { if (profile && !busy) void reload(); }, 20_000);
  cleanups.push(() => clearInterval(poll));

  const watch = window.setInterval(async () => {
    if (!profile || !esc || busy || checking || autoOff || !esc.deposits.length) return;
    let again = false;
    if (esc.pending?.claimant === myKeyHex) {
      const pay = chain.payableNow(esc, esc.pending.start);
      if (canAuto() && pay.holding > 0n && pay.confirmAt !== null && esc.epoch >= pay.confirmAt) void autoConfirm?.();
      if (canAuto() && pay.amount > 0n) void autoCollect?.();
      // what is left only needs a phrase the first post didn't have: keep watching for a post that has it
      again = pay.amount === 0n && pay.waitingAmount === 0n && pay.missing.length > 0;
      if (!again) return;
    }
    if (!watching && !again) return;
    checking = true;
    try {
      if (await bsky.findClaimPost(profile.did, codeNow(), claimPost().used)) {
        watching = false;
        if (canAuto()) void autoVerify?.();
        else toast("We found your post. Press Verify to continue.", "good");
      }
    } catch {
      /* a failed look is retried on the next tick */
    }
    checking = false;
  }, 5000);
  cleanups.push(() => clearInterval(watch));

  const draw = (): void => {
    if (!profile || !esc) return;
    const p = profile;
    const e = esc;
    const mine = e.pending?.claimant === myKeyHex;
    const others = e.pending && !mine;
    const waitingTotal = chain.total(e.deposits);

    const paidHere = !(e.binding && e.binding !== wallet.componentAddress);
    const doneCard =
      collected === null
        ? null
        : h(
            "div",
            { class: "card success" },
            h("div", { class: "delivered" }, "Delivered"),
            h("div", { class: "amount" }, chain.formatTari(collected), h("small", null, CONFIG.symbol)),
            h("h2", { class: "page", style: "margin:12px 0 4px" }, "Collected!"),
            h("p", { class: "sub" }, paidHere ? "It's in your Skydrop wallet now." : `It was paid to the wallet @${p.handle} has linked (${displayAddress(e.binding!)}).`),
            h("div", { class: "row", style: "justify-content:center" }, h("button", { class: "btn primary", onclick: openWallet }, "Open wallet"), h("a", { class: "btn ghost", href: "#/send" }, "Send some to a friend")),
            // The two things that make the next gift easier: no claim at all, and not losing this one.
            !e.binding && !e.bindingPending
              ? h("div", { class: "note", style: "margin-top:16px;text-align:left" }, h("b", null, "Make the next one instant. "), `Link your wallet to @${p.handle} with one post, and future gifts and tips land in it directly, with nothing to collect. `, h("a", { href: `#/link/${p.handle}` }, "Link my wallet"))
              : null,
            paidHere && wallet.kind === "builtin" && !backedUp()
              ? h("div", { class: "note warn", style: "margin-top:12px;text-align:left" }, `Your ${CONFIG.symbol} is kept in this browser. Save your recovery key so you can't lose it if you clear your browser data. `, h("a", { href: "#", onclick: (ev: Event) => { ev.preventDefault(); openWallet(); } }, "Save it now"))
              : null,
            h("div", { class: "note", style: "margin-top:12px;text-align:left" }, h("b", null, "Get more like this. "), `Put your tip jar link in your Bluesky bio and anyone can tip you in two taps. `, h("a", { href: `#/jar/${p.handle}` }, "Get my tip jar")),
          );
    // Gifts sent with the first contract to an account it can't verify (too long an identity history).
    const stuckNote = e.stuckV1.length
      ? h("div", { class: "note warn", style: "margin-top:12px" }, `${chain.formatTari(chain.total(e.stuckV1))} ${CONFIG.symbol} was sent to @${p.handle} with Skydrop's first contract, which can't verify accounts with a long identity history like this one. The sender can take it back after its refund date and send it again: new gifts work.`)
      : null;
    if (doneCard && !e.deposits.length) {
      mount(stepsEl, doneCard, stuckNote);
      return;
    }

    if (!e.deposits.length) {
      const linked = e.binding;
      mount(
        stepsEl,
        stuckNote,
        linked
          ? h(
              "div",
              { class: "card success", style: "margin-top:16px" },
              h("div", { class: "delivered" }, "All set"),
              h("h3", { style: "margin:8px 0 6px" }, "Nothing to collect"),
              h("p", { class: "sub", style: "margin:0 0 6px" }, `@${p.handle} has a linked wallet (${displayAddress(linked)}), so gifts land there directly.`),
              h("p", { class: "sub", style: "margin:0 0 14px" }, "A gift with a challenge shows up here until its phrase is posted."),
              h("div", { class: "row" }, h("a", { class: "btn ghost", href: `#/send/${p.handle}` }, "Send to this account"), h("a", { class: "btn ghost", href: `#/link/${p.handle}` }, "Change linked wallet")),
            )
          : h(
              "div",
              { class: "card", style: "margin-top:16px" },
              h("h3", { style: "margin:0 0 6px" }, `Nothing is waiting for @${p.handle} yet`),
              h("p", { class: "sub", style: "margin:0 0 14px" }, `When someone sends ${CONFIG.symbol} to this account it shows up here. Link a wallet once and future gifts arrive instantly.`),
              h("div", { class: "row" }, h("a", { class: "btn primary", href: `#/link/${p.handle}` }, "Link my wallet"), h("a", { class: "btn ghost", href: `#/send/${p.handle}` }, "Send to this account")),
            ),
      );
      return;
    }

    const start = mine ? e.pending!.start : e.epoch;
    const pay = chain.payableNow(e, start);
    if (!e.binding && e.bindingPending && pay.needLink === chain.total(e.deposits)) {
      mount(stepsEl, doneCard, h("div", { style: "margin-top:16px" }, flowBar(1)), h("div", { class: "card", style: "margin-top:12px" }, h("div", { class: "pill" }, `Waiting for @${p.handle}`), h("h3", { style: "margin:12px 0 6px" }, "Your link is being confirmed"), h("p", { class: "sub", style: "margin:0" }, `It takes effect in about ${eta(Math.max(0, e.bindingPending.epoch - e.epoch))}. The short wait lets anyone stop it if it was made with a stolen key. After that, post the sender's phrase and the money goes to your linked wallet.`)));
      return;
    }
    if (!e.binding && pay.needLink === chain.total(e.deposits)) {
      mount(stepsEl, doneCard, h("div", { style: "margin-top:16px" }, flowBar(1)), h("div", { class: "card", style: "margin-top:12px" }, h("div", { class: "pill" }, `Waiting for @${p.handle}`), h("div", { class: "amount", style: "margin-top:10px" }, chain.formatTari(pay.needLink), h("small", null, CONFIG.symbol)), h("h3", { style: "margin:12px 0 6px" }, "Link your wallet first"), h("p", { class: "sub", style: "margin:0 0 12px" }, `The sender asked for a challenge (${[...new Set(e.deposits.map((d) => d.challenge).filter(Boolean))].map((c) => `“${c}”`).join(", ")}). To collect, link your wallet first (one post, once). Then post the phrase as a separate post and it's released to that wallet.`), h("a", { class: "btn primary", href: `#/link/${p.handle}?flow=1` }, "Step 1: link my wallet"), h("p", { class: "help", style: "margin:12px 0 0" }, "Not interested? Link your wallet first, then you can decline the gift and it goes back to the sender.")));
      return;
    }

    const stepClass = (n: number, cur: number) => `step ${n < cur ? "done" : n === cur ? "active" : "locked"}`;
    // a claim whose post missed a phrase a sender asked for pays nothing on that deposit: post again
    const needPhrase = mine && pay.missing.length > 0 && pay.amount === 0n && pay.waitingAmount === 0n;
    const cur = !mine || needPhrase ? 1 : pay.amount > 0n ? 4 : 3;

    const logEl = h("div", { class: "log" });
    const say = (s: string) => logEl.appendChild(h("div", null, s));

    const verifyBtn = h("button", { class: "btn primary" }, "I've posted it. Verify and claim") as HTMLButtonElement;
    const runVerify = async (): Promise<void> => {
      if (busy) return;
      await balanceReady;
      // A linked account's phrase claim (no code) can be relayed by Skydrop, so an empty wallet may go ahead.
      if (!sponsorOk && needsFunds() && codeNow()) return void toast(`You need a little ${CONFIG.symbol} for network fees first.`, "bad");
      busy = true;
      verifyBtn.disabled = true;
      mount(verifyBtn, ...spinnerLabel("Verifying…"));
      try {
        say("Looking for your post on Bluesky");
        const post = await bsky.findClaimPost(p.did, codeNow(), claimPost().used);
        if (!post) throw new Error((codeNow() ? await bsky.whyNoClaimPost(p.did, code, claimPost().used) : "") || "We couldn't find a post containing your code yet. Post it publicly, wait a few seconds, then try again.");
        say("Fetching the signed copy of your post");
        const proof = await bsky.buildClaimProof(p.did, post.rkey);
        say("Submitting the proof. The contract checks every signature itself");
        const paidClaim = async (): Promise<void> => {
          await recordForFree(p.did, say);
          await checkPaidClaim(p.did, say);
          await chain.startClaim(wallet, proof, say);
        };
        if (!codeNow()) {
          // a linked account's code-free post: the payout can only go to the linked wallet
          if (needsFunds()) {
            await relayLinked(p.did, "start", (n) => !!n.pending && n.pending.claimant === n.bindingOwner && chain.payableNow(n, n.pending.start).missing.length === 0, say);
          } else {
            await recordForFree(p.did, say);
            await checkPaidClaim(p.did, say);
            await chain.startLinkedClaim(wallet, proof, say);
          }
        } else if (sponsorOk) {
          try {
            say("Network fees are covered for you");
            await chain.startClaimSponsored(wallet, proof, say);
          } catch (err) {
            // An old account: its identity history has to be on-chain before a free claim fits. Skydrop records it
            // for free (with enough waiting), even when the wallet holds a little TARI: recording can cost more than that.
            if (chain.needsRecording(err) && (await recordForFree(p.did, say))) {
              await chain.startClaimSponsored(wallet, proof, say);
            } else {
              if (needsFunds() && chain.isFeePhaseTooBig(err)) await askForFloat(p.did, say);
              else if (needsFunds() && !chain.needsRecording(err)) throw err;
              else say("Sponsored fees weren't available, so your wallet pays the fee");
              await checkPaidClaim(p.did, say);
              await chain.startClaim(wallet, proof, say);
            }
          }
        } else {
          await paidClaim();
        }
        await refreshBalance();
        toast("Verified on-chain", "good");
        busy = false;
        await reload();
        if (canAuto() && esc?.pending?.claimant === myKeyHex && chain.payableNow(esc, esc.pending.start).amount > 0n) void autoCollect?.();
      } catch (err) {
        busy = false;
        autoOff = true;
        watching = true;
        toast(chain.friendly(err), "bad");
        verifyBtn.disabled = false;
        mount(verifyBtn, "I've posted it. Verify and claim");
      }
    };
    verifyBtn.addEventListener("click", () => {
      autoOff = false;
      void runVerify();
    });
    autoVerify = runVerify;

    const collectBtn = h("button", { class: "btn primary block" }, `Collect ${chain.formatTari(pay.amount)} ${CONFIG.symbol}`) as HTMLButtonElement;
    const runCollect = async (): Promise<void> => {
      if (busy) return;
      busy = true;
      collectBtn.disabled = true;
      mount(collectBtn, ...spinnerLabel("Collecting…"));
      try {
        const attempt = async (): Promise<void> => {
          if (esc?.binding && esc.pending?.claimant === esc.bindingOwner) {
            // a linked claim pays into the linked wallet, whoever submits it
            await balanceReady;
            if (needsFunds()) {
              const before = chain.total(esc.deposits);
              await relayLinked(p.did, "finalize", (n) => chain.total(n.deposits) < before, say);
            } else await chain.finalizeToLinked(wallet, p.did, say, true);
          } else if (sponsorOk) {
            try {
              say("Network fees are covered for you");
              await chain.finalizeClaimSponsored(wallet, p.did, say, true);
            } catch (err) {
              if (needsFunds() || chain.isWindowOpen(err)) throw err;
              say("Sponsored fees weren't available, so your wallet pays the small fee");
              await chain.finalizeClaim(wallet, p.did, say, true);
            }
          } else {
            await chain.finalizeClaim(wallet, p.did, say, true);
          }
        };
        // Right after a claim starts, the node that checks the payout can still be on the previous epoch for a
        // moment, so an instant payout looks "not open yet". That clears by itself: wait and try again.
        for (let tries = 0; ; tries++) {
          try {
            await attempt();
            break;
          } catch (err) {
            if (!chain.isWindowOpen(err) || tries >= 6) throw err;
            say("The network is catching up to your claim. Trying again in a few seconds…");
            await new Promise((r) => setTimeout(r, 12_000));
          }
        }
        const got = pay.amount;
        await refreshBalance();
        confetti();
        busy = false;
        const before = esc?.version;
        // `reload` also recomputes the claim code: collecting the last gifts sent before v2 moves the account on to v2,
        // whose code is different, so the next post must carry the new one.
        await reload();
        const fresh = esc!;
        if (fresh.deposits.length) {
          toast(
            fresh.version !== before
              ? `Collected ${chain.formatTari(got)} ${CONFIG.symbol}. More gifts are waiting: post the new code below to collect them.`
              : `Collected ${chain.formatTari(got)} ${CONFIG.symbol}. The rest is still in its safety window.`,
            "good",
          );
          watching = true;
          autoOff = false;
          draw();
        } else {
          collected = got;
          draw();
        }
      } catch (err) {
        busy = false;
        autoOff = true;
        toast(chain.friendly(err), "bad");
        collectBtn.disabled = false;
        mount(collectBtn, `Collect ${chain.formatTari(pay.amount)} ${CONFIG.symbol}`);
      }
    };
    collectBtn.addEventListener("click", () => {
      autoOff = false;
      void runCollect();
    });
    autoCollect = runCollect;

    // a sender may ask that the claim post stays up: after that time the same post is proven again
    const confirmBtn = h("button", { class: "btn primary block", style: "margin-top:10px" }, "Confirm my post is still up") as HTMLButtonElement;
    const runConfirm = async (): Promise<void> => {
      if (busy) return;
      busy = true;
      confirmBtn.disabled = true;
      mount(confirmBtn, ...spinnerLabel("Confirming…"));
      try {
        const rkey = e.held?.rkey;
        if (!rkey) throw new Error("There's no claim post to confirm yet.");
        say("Fetching the signed copy of your post");
        const proof = await bsky.buildClaimProof(p.did, rkey);
        // the contract only believes a snapshot of your account that was taken after the hold time
        const need = Math.max(0, ...e.deposits.filter((d) => d.challenge && d.hold).map((d) => d.hold));
        if (e.held && bsky.commitRevMicros(proof.commit) < e.held.startRev + need * chain.EPOCH_MICROS) {
          throw new Error(`Bluesky hasn't saved a fresh snapshot of your account since the hold time began. Like or post anything on Bluesky, wait a moment, then confirm again.`);
        }
        if (sponsorOk) {
          try {
            say("Network fees are covered for you");
            await chain.confirmClaimSponsored(wallet, proof, say);
          } catch (err) {
            // As for the claim: Skydrop records an old account's history for free first, whatever the wallet holds.
            if (chain.needsRecording(err) && (await recordForFree(p.did, say))) {
              await chain.confirmClaimSponsored(wallet, proof, say);
            } else {
              if (needsFunds() && chain.isFeePhaseTooBig(err)) await askForFloat(p.did, say);
              else if (needsFunds() && !chain.needsRecording(err)) throw err;
              else say("Sponsored fees weren't available, so your wallet pays the fee");
              await checkPaidClaim(p.did, say);
              await chain.confirmClaim(wallet, proof, say);
            }
          }
        } else {
          await recordForFree(p.did, say);
          await checkPaidClaim(p.did, say);
          await chain.confirmClaim(wallet, proof, say);
        }
        await refreshBalance();
        toast("Your post is confirmed", "good");
        busy = false;
        await reload();
        if (canAuto() && esc?.pending?.claimant === myKeyHex && chain.payableNow(esc, esc.pending.start).amount > 0n) void autoCollect?.();
      } catch (err) {
        busy = false;
        autoOff = true;
        toast(chain.friendly(err), "bad");
        confirmBtn.disabled = false;
        mount(confirmBtn, "Confirm my post is still up");
      }
    };
    confirmBtn.addEventListener("click", () => {
      autoOff = false;
      void runConfirm();
    });
    autoConfirm = runConfirm;
    const holdNote =
      mine && pay.holding > 0n && pay.confirmAt !== null
        ? e.epoch >= pay.confirmAt
          ? h("div", { class: "note warn", style: "margin-top:12px" }, `The time is up. Like or post anything on Bluesky so your account saves a fresh snapshot, then confirm your post is still there to release ${chain.formatTari(pay.holding)} ${CONFIG.symbol}.`, confirmBtn)
          : h("div", { class: "note warn", style: "margin-top:12px" }, `${chain.formatTari(pay.holding)} ${CONFIG.symbol} needs your post to stay up. Don't delete it. You can confirm it in ${eta(pay.confirmAt - e.epoch)}${canAuto() ? ", and this page does it for you while it's open" : ""}.`)
        : null;

    const { text: postText, dropped } = claimPost();
    const maxWin = Math.max(...e.deposits.map((d) => d.window));
    // Instant gifts have no safety window: don't show a step that never happens.
    const hasWindow = maxWin > 0 || e.deposits.some((d) => d.hold > 0);
    const elapsed = mine ? Math.max(0, e.epoch - e.pending!.start) : 0;
    const pct = maxWin ? Math.min(100, Math.round((elapsed / maxWin) * 100)) : 100;

    // declining returns a gift to its sender; it needs the linked wallet, so an account links first
    const ownerHere = !!e.binding && e.bindingOwner === myKeyHex;
    const expired = !e.pending && e.deposits.some((d) => d.challenge && e.epoch >= d.created + chain.SWEEP_AFTER_EPOCHS);
    const runDecline = async (d: chain.Deposit, btn: HTMLButtonElement): Promise<void> => {
      if (busy || !window.confirm("Decline this gift? The money goes back to the sender.")) return;
      busy = true;
      btn.disabled = true;
      mount(btn, ...spinnerLabel("Declining…"));
      try {
        if (sponsorOk) {
          try {
            await chain.declineDepositSponsored(wallet, p.did, d, say);
          } catch (err) {
            if (needsFunds()) throw err;
            await chain.declineDeposit(wallet, p.did, d, say);
          }
        } else {
          await chain.declineDeposit(wallet, p.did, d, say);
        }
        toast("Declined. It's on its way back to the sender.", "good");
        busy = false;
        await reload();
      } catch (err) {
        busy = false;
        toast(chain.friendly(err), "bad");
        btn.disabled = false;
        mount(btn, "Decline");
      }
    };
    const sweepBtn = h("button", { class: "btn ghost sm" }, "Return expired gifts") as HTMLButtonElement;
    sweepBtn.addEventListener("click", async () => {
      if (busy) return;
      busy = true;
      sweepBtn.disabled = true;
      try {
        await chain.sweepDeposits(wallet, p.did, say);
        toast("Expired gifts were sent back to their senders", "good");
      } catch (err) {
        toast(chain.friendly(err), "bad");
      }
      busy = false;
      await reload();
    });
    const declineBox = h(
      "details",
      { class: "opt", style: "margin-top:12px" },
      h("summary", null, "Not interested? Decline a gift"),
      h(
        "div",
        { class: "stack", style: "margin-top:12px" },
        h("p", { class: "help", style: "margin:0" }, e.binding ? "Declining sends the gift back to the person who sent it. You do it from your linked wallet." : "To decline a gift you link your wallet first (one post, once). Then you can send gifts back to their senders."),
        ...e.deposits.map((d) => {
          const btn = h("button", { class: "btn ghost sm" }, "Decline") as HTMLButtonElement;
          btn.addEventListener("click", () => void runDecline(d, btn));
          return h(
            "div",
            { class: "row", style: "justify-content:space-between;align-items:center;flex-wrap:nowrap" },
            h("div", null, h("b", null, `${chain.formatTari(d.amount)} ${CONFIG.symbol}`), fromOf.get(d.index) ? h("div", { class: "help", style: "margin:0" }, fromText(fromOf.get(d.index)!)) : null, d.challenge ? h("div", { class: "help", style: "margin:0" }, `asks for “${d.challenge}”`) : null),
            !e.binding ? h("a", { class: "btn ghost sm", href: `#/link/${p.handle}?flow=1` }, "Link first") : ownerHere ? btn : h("span", { class: "help", style: "margin:0" }, "Use your linked wallet"),
          );
        }),
        expired ? sweepBtn : null,
      ),
    );
    const challenged = e.deposits.some((d) => d.challenge);
    mount(
      stepsEl,
      doneCard,
      challenged ? h("div", { style: "margin-top:16px" }, flowBar(!e.binding ? 1 : mine && pay.amount > 0n ? 3 : 2)) : null,
      // What's waiting comes first: it's why they're here. Declining is the rare case, so it goes last.
      h(
        "div",
        { class: "card", style: "margin-top:16px;text-align:center" },
        h("div", { class: "pill" }, `Waiting for @${p.handle}`),
        h("div", { class: "amount", style: "margin-top:10px" }, chain.formatTari(waitingTotal), h("small", null, CONFIG.symbol)),
        ...[...new Set(e.deposits.map((d) => fromOf.get(d.index)).filter((f): f is { handle: string; verified: boolean } => !!f).map(fromText))].map((t) => h("p", { class: "sub", style: "margin:6px 0 0" }, t)),
      ),
      holdNote,
      pay.needLink > 0n && e.bindingPending ? h("div", { class: "note warn", style: "margin-top:12px" }, `Your link is being confirmed and takes effect in about ${eta(Math.max(0, e.bindingPending.epoch - e.epoch))}. The short wait lets anyone stop it if it was made with a stolen key. After that, post the phrase.`) : null,
      pay.needLink > 0n && !e.bindingPending ? h("div", { class: "card", style: "margin-top:12px" }, h("h3", { style: "margin:0 0 6px" }, "Link your wallet first"), h("p", { class: "sub", style: "margin:0 0 12px" }, `${chain.formatTari(pay.needLink)} ${CONFIG.symbol} comes with a challenge from the sender. To collect it, first link your wallet (one post, once), then post the challenge phrase as a separate post. The two can't be done in the same post.`), h("a", { class: "btn primary", href: `#/link/${p.handle}?flow=1` }, "Step 1: link my wallet")) : null,
      stuckNote,
      e.binding && codeNow() === "" ? h("div", { class: "note good", style: "margin-top:12px" }, "Your wallet is linked, so the challenge post needs only the phrase below. Your money goes to your linked wallet.") : null,
      e.binding ? h("div", { class: "note good", style: "margin-top:12px" }, e.binding === wallet.componentAddress ? "This account is linked to your wallet. Anything that needs a safety window or a phrase is paid there once you've collected it." : `@${p.handle} has linked ${displayAddress(e.binding)}. Whatever you collect here is paid to that account, not to this wallet.`) : null,
      others ? h("div", { class: "note warn", style: "margin-top:12px" }, "Another wallet has started a claim on this account. If that isn't you, the real owner can cancel it. You can still start your own claim below.") : null,
      sponsorOk ? h("div", { class: "note good", style: "margin-top:12px" }, `Network fees are covered. You don't need any ${CONFIG.symbol} to collect.`) : needsFunds() && cur === 1 ? h("div", { style: "margin-top:12px" }, fundsNote()) : null,
      h(
        "div",
        { class: "steps" },
        h("div", { class: stepClass(1, cur) }, h("div", { class: "num" }, cur > 1 ? icons.check(18) : "1"), h("div", null, h("h3", null, codeNow() ? "Post this on Bluesky" : "Post the phrase"), h("p", null, codeNow() ? "Post it from your account (so everyone can see it). It ties this claim to your wallet, and you can delete the post afterwards." : "Your wallet is linked. Post this as a new post from your account, separate from the link post, and the money goes to your linked wallet."), pay.missing.length || e.deposits.some((d) => d.challenge) ? h("div", { class: "note", style: "margin:0 0 10px" }, `The sender asked for something specific: ${[...new Set(e.deposits.map((d) => d.challenge).filter(Boolean))].map((c) => `“${c}”`).join(", ")}. It leads the text below. The money for that deposit is only released if your post says it exactly.${dropped ? ` Too many phrases fit in one post, so ${dropped} will wait for a second post.` : ""}`) : null, h("div", { class: "codebox" }, postText), h("div", { class: "row", style: "margin-top:12px" }, h("a", { class: "btn bsky sm", href: bsky.composeUrl(postText), target: "_blank", rel: "noopener" }, "Open Bluesky", icons.external(14)), h("button", { class: "btn ghost sm", onclick: () => copy(postText, "Text copied") }, icons.copy(14), "Copy")))),
        h("div", { class: cur === 1 ? "step active" : stepClass(2, cur) }, h("div", { class: "num" }, cur > 2 ? icons.check(18) : "2"), h("div", null, h("h3", null, "Prove it's you"), h("p", null, "We fetch the signed copy of your post straight from Bluesky. The contract checks the signatures itself. Nobody has to trust us."), cur === 1 ? h("div", null, canAuto() && !autoOff ? h("p", { class: "help" }, `Watching for your post. This continues by itself once it appears, and your ${CONFIG.symbol} is collected automatically when it's due.`) : null, verifyBtn, logEl) : null)),
        !hasWindow ? null : h("div", { class: stepClass(3, cur) }, h("div", { class: "num" }, cur > 3 ? icons.check(18) : "3"), h("div", null, h("h3", null, "Safety window"), cur >= 3 ? h("div", null, h("p", null, pay.nextEpoch !== null ? `Larger payments wait a bit so the real owner could stop a hijack. Next release ${eta(Math.max(0, pay.nextEpoch - e.epoch))}.` : "All clear."), h("div", { class: "bar", role: "progressbar", "aria-valuenow": pct, "aria-valuemin": 0, "aria-valuemax": 100 }, h("i", { style: `width:${pct}%` }))) : h("p", null, "Small payments skip this. Larger ones wait a short while first."))),
        h("div", { class: stepClass(4, cur) }, h("div", { class: "num" }, hasWindow ? "4" : "3"), h("div", null, h("h3", null, "Collect"), cur === 4 ? h("div", null, h("p", null, pay.waitingAmount > 0n ? `${chain.formatTari(pay.amount)} ${CONFIG.symbol} is ready now. ${chain.formatTari(pay.waitingAmount)} more is still in its safety window.` : "It's ready."), collectBtn, logEl) : h("p", null, `Your ${CONFIG.symbol} lands in your Skydrop wallet.`))),
      ),
      declineBox,
    );
  };

  layout(
    "claim",
    h("h1", { class: "page" }, `Collect your ${CONFIG.symbol}`),
    gift && (gift.note || gift.cover || gift.style.id !== "air" || env.hasExtras(gift.extras)) ? giftEl(gift) : null,
    h("p", { class: "sub" }, "Enter your Bluesky handle. You'll post one line to prove it's you."),
    h("div", { class: "card" }, h("label", { class: "f" }, "Your Bluesky handle"), field.el),
    stepsEl,
  );
}

// ---------------------------------------------------------------------------------------------------------
// your sends: what this wallet has put in escrow, and taking it back
// ---------------------------------------------------------------------------------------------------------

const profileCache = new Map<string, bsky.Profile | null>();
async function profileFor(did: string): Promise<bsky.Profile | null> {
  if (profileCache.has(did)) return profileCache.get(did)!;
  try {
    const p = await bsky.lookupProfile(did);
    profileCache.set(did, p);
    return p;
  } catch {
    profileCache.set(did, null);
    return null;
  }
}

function renderSent(): void {
  const listEl = h("div", { class: "stack" });
  let busy = false;

  const load = async (): Promise<void> => {
    mount(listEl, h("div", { class: "skel" }), h("div", { class: "skel" }));
    let data: Awaited<ReturnType<typeof chain.readSentBy>>;
    try {
      data = await chain.readSentBy(provider, myKeyHex);
    } catch (e) {
      return mount(listEl, h("div", { class: "note bad" }, chain.friendly(e)));
    }
    noteEpoch(data.epoch);
    const delivered = await chain.readDeliveredBy(provider, myKeyHex).catch(() => [] as chain.Delivered[]);
    const returnedAmt = await chain.readReturnedFor(provider, myKeyHex).catch(() => 0n);
    if (!data.items.length && !delivered.length && returnedAmt === 0n) {
      return mount(
        listEl,
        h("div", { class: "card" }, h("h3", { style: "margin:0 0 6px;font-family:var(--serif);font-size:26px" }, "Nothing waiting"), h("p", { class: "sub", style: "margin:0 0 14px" }, "Anything you send that nobody has collected yet shows up here, and you can take it back after its refund time."), h("a", { class: "btn primary", href: "#/send" }, "Send some")),
      );
    }
    const profiles = await Promise.all(data.items.map((d) => profileFor(d.did)));
    const envelopes = await Promise.all(data.items.map((d) => (d.envelope ? env.fetchEnvelope(d.envelope) : Promise.resolve(null))));
    const escs = new Map<string, chain.Escrow>();
    await Promise.all([...new Set(data.items.map((d) => d.did))].map(async (did) => { try { escs.set(did, await chain.readEscrow(provider, did)); } catch { /* status falls back to plain waiting */ } }));
    const rows = data.items.map((d, i) => {
      const p = profiles[i];
      const saved = envelopes[i];
      const left = d.refundEpoch - data.epoch;
      const ready = left <= 0;
      const handle = p ? `@${p.handle}` : short(d.did, 14, 6);
      const btn = h("button", { class: "btn primary sm" }, "Take it back") as HTMLButtonElement;
      const say = h("div", { class: "log" });
      btn.addEventListener("click", async () => {
        if (busy) return;
        busy = true;
        btn.disabled = true;
        mount(btn, ...spinnerLabel("Taking it back…"));
        try {
          await chain.refundDeposit(wallet, provider, d, (s) => say.appendChild(h("div", null, s)));
          await refreshBalance();
          toast(`${chain.formatTari(d.amount)} ${CONFIG.symbol} is back in your wallet`, "good");
          busy = false;
          await load();
        } catch (e) {
          busy = false;
          toast(chain.friendly(e), "bad");
          btn.disabled = false;
          mount(btn, "Take it back");
        }
      });
      const esc = escs.get(d.did);
      const who = p ? `@${p.handle}` : "they";
      const keep = d.hold ? ` and keep it up for ${eta(d.hold)}` : "";
      const st: { tone: string; label: string; text: string } = ready
        ? { tone: "refund", label: "Refundable", text: "Nobody has collected this. You can take it back now." }
        : esc?.pending
          ? { tone: "progress", label: "Claim started", text: `${who} has started claiming this. It's released when its safety window and any phrase are done.` }
          : d.challenge && !esc?.binding
            ? { tone: "wait", label: "Needs a link", text: `${who} must link a wallet first, then post “${d.challenge}”${keep}.` }
            : d.challenge
              ? { tone: "wait", label: "Needs the phrase", text: `${who} has linked a wallet. Waiting for a post that says “${d.challenge}”${keep}.` }
              : { tone: "wait", label: "Waiting", text: `Waiting for ${who} to collect it.` };
      const link = env.shareLink(location.origin, p?.handle ?? d.did, saved?.e ?? "air", saved?.m ?? "", `${chain.formatTari(d.amount)} ${CONFIG.symbol}`, saved?.c ?? "", saved ?? {});
      const nudge = `@${p?.handle ?? ""} there's ${chain.formatTari(d.amount)} ${CONFIG.symbol} waiting for you on Tari 🎁 Collect it here:\n${link}`;
      return h(
        "div",
        { class: "card", style: "padding:20px" },
        h("div", { class: "row", style: "justify-content:space-between;align-items:flex-start" },
          h("div", { class: "row", style: "gap:12px;flex-wrap:nowrap" }, p?.avatar ? h("img", { src: p.avatar, alt: "", width: 48, height: 48, style: "border-radius:50%;border:2px solid var(--edge)" }) : h("div", { class: "avatar", style: "width:48px;height:48px" }), h("div", null, h("div", { style: "font-weight:700;font-size:18px" }, handle), h("div", { class: "help", style: "margin:0" }, d.window ? `Safety window ${eta(d.window)}` : "Instant collect", d.challenge ? ` · must post “${d.challenge}”${d.hold ? ` and keep it up ${eta(d.hold)}` : ""}` : ""))),
          h("div", { class: "amount", style: "font-size:34px" }, chain.formatTari(d.amount), h("small", null, CONFIG.symbol)),
        ),
        h("div", { class: `status ${st.tone}`, style: "margin-top:14px" }, h("span", { class: "badge" }, st.label), h("span", null, st.text)),
        ready ? null : h("p", { class: "help", style: "margin:8px 0 0" }, `You can take it back in ${eta(left)}.`),
        h("div", { class: "row", style: "margin-top:12px" }, ready ? btn : null, p ? h("a", { class: "btn ghost sm", href: bsky.composeUrl(nudge), target: "_blank", rel: "noopener" }, "Remind them", icons.external(14)) : null, h("a", { class: "btn ghost sm", href: `#/claim/${p?.handle ?? ""}` }, "Open claim page")),
        say,
      );
    });
    const deliveredProfiles = await Promise.all(delivered.slice(0, 8).map((x) => profileFor(x.did)));
    const deliveredEls = delivered.length
      ? [
          h("h3", { style: "margin:20px 0 0;font-family:var(--serif);font-size:24px" }, "Delivered instantly"),
          ...delivered.slice(0, 8).map((x, i) => {
            const p = deliveredProfiles[i];
            return h("div", { class: "card", style: "padding:16px" }, h("div", { class: "row", style: "justify-content:space-between;align-items:center;flex-wrap:nowrap" }, h("div", { class: "row", style: "gap:12px;flex-wrap:nowrap" }, p?.avatar ? h("img", { src: p.avatar, alt: "", width: 40, height: 40, style: "border-radius:50%;border:2px solid var(--edge)" }) : h("div", { class: "avatar", style: "width:40px;height:40px" }), h("div", null, h("div", { style: "font-weight:700" }, p ? `@${p.handle}` : short(x.did, 14, 6)), h("div", { class: "help", style: "margin:0" }, "Paid straight to their linked wallet"))), h("div", { class: "amount", style: "font-size:26px" }, chain.formatTari(x.amount), h("small", null, CONFIG.symbol))));
          }),
        ]
      : [];
    const takeBtn = h("button", { class: "btn primary" }, "Take it back") as HTMLButtonElement;
    takeBtn.addEventListener("click", async () => {
      if (busy) return;
      busy = true;
      takeBtn.disabled = true;
      mount(takeBtn, ...spinnerLabel("Taking it back…"));
      try {
        await chain.takeReturned(wallet);
        await refreshBalance();
        toast(`${chain.formatTari(returnedAmt)} ${CONFIG.symbol} is back in your wallet`, "good");
        busy = false;
        await load();
      } catch (err) {
        busy = false;
        toast(chain.friendly(err), "bad");
        takeBtn.disabled = false;
        mount(takeBtn, "Take it back");
      }
    });
    const returnedEl =
      returnedAmt > 0n
        ? h("div", { class: "card success", style: "padding:20px" }, h("div", { class: "delivered" }, "Returned"), h("div", { class: "amount", style: "font-size:34px" }, chain.formatTari(returnedAmt), h("small", null, CONFIG.symbol)), h("p", { class: "sub", style: "margin:8px 0 14px" }, "Gifts that were declined, or that nobody answered, are waiting for you."), takeBtn)
        : null;
    mount(listEl, returnedEl, ...(rows.length ? rows : [h("div", { class: "note" }, "Nothing is waiting. Everything you've sent has been delivered or collected.")]), ...deliveredEls);
  };

  const poll = window.setInterval(() => { if (!busy) void load(); }, 60_000);
  cleanups.push(() => clearInterval(poll));
  layout("send", h("h1", { class: "page" }, "Your sends"), h("p", { class: "sub" }, "What this wallet has sent: gifts still waiting to be collected, and ones that were delivered instantly."), listEl);
  void load();
}

// ---------------------------------------------------------------------------------------------------------
// how it works
// ---------------------------------------------------------------------------------------------------------

function renderHow(): void {
  layout(
    "how",
    h("h1", { class: "page" }, "How it works"),
    h("p", { class: "sub" }, "Short version: the money sits in a smart contract that can check Bluesky's own signatures."),
    !deployed()
      ? h(
          "div",
          { class: "card", style: "margin-bottom:18px" },
          h("h2", { style: "margin:0 0 10px;font-size:24px" }, "Campaign rewards"),
          h(
            "ol",
            { class: "how", style: "padding-left:20px;margin:0" },
            h("li", null, h("b", null, "A creator funds a campaign."), " The reward pool is locked in a contract with fixed rules. They can't change the rules or take the money back before it closes."),
            h("li", null, h("b", null, "You do the steps."), " Your likes, reposts, replies and follows are signed records in your own Bluesky account."),
            h("li", null, h("b", null, "You post one line."), " It names your wallet, so the reward can only go there."),
            h("li", null, h("b", null, "The contract checks it and pays."), " Your wallet sends the proofs and pays a small network fee. Each account can only collect once per round."),
          ),
          h("p", { style: "margin-bottom:0" }, "It can't tell when you did a step or whether you undo it later, and anyone can make new accounts, so open campaigns can be farmed. Creators can limit that with lists and vouches. ", h("a", { href: "/quests" }, "See your rewards")),
        )
      : null,
    !deployed() ? h("h2", { style: "margin:0 0 10px;font-size:24px" }, "Gifts, once they're back") : null,
    h(
      "div",
      { class: "card" },
      h(
        "ol",
        { class: "how", style: "padding-left:20px;margin:0" },
        h("li", null, h("b", null, "You send."), ` The ${CONFIG.symbol} moves into an escrow contract, filed under the recipient's permanent Bluesky ID (not their handle, which can change hands).`),
        h("li", null, h("b", null, "They post a code."), " One short post from their account. The code is made from their wallet's key, so that post can only ever pay out to the wallet that asked."),
        h("li", null, h("b", null, "The contract checks the math."), " Bluesky accounts are cryptographic identities. The contract verifies the account's identity history, the signature on their repository and the path to the post. No server is asked."),
        h("li", null, h("b", null, "They collect."), " After the safety window you chose, the escrow pays out to their wallet."),
        h("li", null, h("b", null, "Or they link a wallet once."), " With one signed post, an account can link an Ootle address (", h("a", { href: "#/link" }, "Link wallet"), `). After that, gifts with no safety window and no phrase are paid there instantly, and anything collected goes there too. Changing the address later takes about ${eta(CONFIG.bindDelayEpochs)} to apply`),
      ),
    ),
    h("details", null, h("summary", null, "What's the safety window for?"), h("p", null, "A proof can show an account's history is valid, but not that it's complete. If someone stole a Bluesky signing key and the real owner had already rotated it, the thief could present the old history. The window lets anyone submit the owner's rotation and cancel the claim. Small tips can skip it. Large transfers should use it.")),
    h("details", null, h("summary", null, "What is a challenge?"), h("p", null, "A sender can ask for something specific: a phrase the receiver has to post, and optionally that the post stays up for some hours. The contract checks it. To collect a challenge gift you link a wallet first (one post), then post the phrase in a separate, later post.")),
    h("details", null, h("summary", null, "Can I decline a gift?"), h("p", null, "Yes, once your wallet is linked: open Collect, pick \"Decline a gift\" and sign from your wallet. The money goes back to the sender, who takes it back from Your sends. Phrase gifts nobody answers for about three days can be sent back by anyone.")),
    h("details", null, h("summary", null, "What if my Bluesky key was stolen?"), h("p", null, "A proof can't show an account's history is complete, so links and claims wait out a short delay during which anyone, and the Skydrop bot, can cancel them by showing the account's newer history. Larger gifts can add a longer safety window.")),
    h("details", null, h("summary", null, "What if nobody claims it?"), h("p", null, `The sender can take it back after about ${eta(CONFIG.refundAfterEpochs)}.`)),
    h("details", null, h("summary", null, "What can't it do yet?"), h("p", null, `Only did:plc accounts work (almost everyone). Private payouts to a stealth address are planned.${MAINNET ? "" : " This is testnet."}`)),
    h("details", null, h("summary", null, "Is my wallet safe?"), h("p", null, `It's created in your browser and never sent anywhere. Back up your recovery key from the wallet menu.${MAINNET ? " If you clear your browser data without it, the wallet is gone." : " This is testnet software."}`)),
  );
}

/** Tops up the escrow's fee vault, so people with no TARI can still collect. Each sponsored fee is taken back
 *  out of that person's own gift, so the vault works as a float that refills itself. */
function renderSponsor(): void {
  const balEl = h("div", { class: "amount", style: "font-size:36px" }, "…");
  const input = h("input", { class: "input", inputmode: "decimal", placeholder: "5", "aria-label": "Amount" }) as HTMLInputElement;
  const btn = h("button", { class: "btn primary" }, "Fund free claims") as HTMLButtonElement;
  const logEl = h("div", { class: "note" });
  let busy = false;
  const readBal = async (): Promise<void> => {
    balEl.textContent = `${chain.formatTari(await chain.readSponsorBalance(provider), 4)} ${CONFIG.symbol}`;
  };
  btn.onclick = async () => {
    const amt = chain.parseTari(input.value);
    if (busy) return;
    if (!amt || amt <= 0n) return void toast("Enter an amount.", "bad");
    await balanceReady;
    if (needsFunds(amt)) return void toast(`This wallet doesn't have enough ${CONFIG.symbol} for that plus the network fee.`, "bad");
    busy = true;
    btn.disabled = true;
    mount(logEl, "Starting…");
    try {
      await chain.fundSponsor(wallet, amt, (s) => mount(logEl, s));
      mount(logEl, "Done.");
      toast(`Added ${chain.formatTari(amt)} ${CONFIG.symbol} to the fee vault`, "good");
      input.value = "";
      await Promise.all([refreshBalance(), readBal()]);
    } catch (e) {
      mount(logEl, chain.friendly(e));
      toast(chain.friendly(e), "bad");
    }
    busy = false;
    btn.disabled = false;
  };
  layout(
    "how",
    h("h1", { class: "page" }, "Fund free claims"),
    h("p", { class: "sub" }, `This vault pays the network fee for people collecting a gift or tip who hold no ${CONFIG.symbol}. Each fee it pays (at most 0.1 ${CONFIG.symbol}) is taken back out of that person's own gift, so the vault refills itself. Anyone can add to it; nobody can withdraw from it.`),
    h("div", { class: "kv" }, h("div", { class: "k" }, "Fee vault balance"), balEl),
    h("div", { class: "stack", style: "margin-top:16px" }, h("div", { class: "field" }, input, h("span", { class: "suffix" }, CONFIG.symbol)), btn, logEl),
  );
  void readBal();
}

// ---------------------------------------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------------------------------------

const TITLES: Record<string, string> = { send: "Send", claim: "Collect", tips: "Tip by post", tip: "Tip", jar: "Your tip jar", link: "Link wallet", sent: "Your sends", how: "How it works", sponsor: "Fund free claims" };

function route(): void {
  cleanups.forEach((f) => f());
  cleanups = [];
  const [, kind = "", rawArg = ""] = location.hash.replace(/^#/, "").split("/");
  const [arg = "", query = ""] = rawArg.split("?");
  const param = decodeURIComponent(arg);
  // the tab and history show where you are
  document.title = TITLES[kind] ? `${TITLES[kind]} · Skydrop` : deployed() ? "Skydrop: send Tari to anyone on Bluesky" : "Skydrop: get rewarded for what you do on Bluesky";
  const q = new URLSearchParams(query);
  if (!deployed() && ["send", "claim", "tips", "tip", "jar", "link", "sent"].includes(kind)) renderGiftsPaused();
  else if (kind === "send") renderSend(param || undefined);
  else if (kind === "claim") renderClaim(param || undefined, { style: env.styleOf(q.get("e")), note: env.cleanNote(q.get("m") ?? ""), cover: env.isCoverId(q.get("c")) ? q.get("c")! : "", extras: env.extrasFromQuery((k) => q.get(k)) });
  else if (kind === "tips") renderTips(param || undefined);
  else if (kind === "tip") renderTipJar(param || undefined, q);
  else if (kind === "jar") renderJar(param || undefined);
  else if (kind === "link") renderLink(param || undefined, q.get("flow") === "1");
  else if (kind === "sent") renderSent();
  else if (kind === "how") renderHow();
  else if (kind === "sponsor" && deployed()) renderSponsor();
  else renderHome();
}

(async () => {
  mount(root, h("div", { class: "hero" }, h("div", { class: "skel" })));
  try {
    await startSession();
  } catch (e) {
    mount(root, h("div", { class: "hero" }, h("h1", null, "Couldn't start"), h("p", { class: "lead" }, e instanceof Error ? e.message : String(e)), h("button", { class: "btn primary", onclick: () => location.reload() }, "Try again")));
    return;
  }
  document.documentElement.lang = currentLang() === "zh" ? "zh-Hans" : "en";
  addEventListener("hashchange", route);
  route();
  if (currentLang() === "zh") startChinese();
})();
