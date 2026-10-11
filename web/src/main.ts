import "./style.css";
import { IndexerProvider } from "@tari-project/ootle-indexer";
import { Network, defaultIndexerUrl } from "@tari-project/ootle";
import { CONFIG } from "./config";
import * as bsky from "./bsky";
import * as chain from "./chain";
import { confetti, copy, h, icons, mount, short, spinnerLabel, stamp, toast } from "./dom";
import { toHex } from "./cbor";
import * as env from "./envelope";
import { currentLang, setLang, startChinese } from "./i18n";
import * as wallets from "./wallet";
import type { Wallet } from "./wallet";

const themeParam = new URLSearchParams(location.search).get("theme");
if (themeParam === "dark") document.documentElement.dataset.theme = "dark";

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
    provider = await IndexerProvider.connect({ url: defaultIndexerUrl(Network.Esmeralda), network: Network.Esmeralda });
  } else {
    const account = chain.openAccount(chain.savedSeed() ?? chain.createSeed());
    chosen = await wallets.builtinWallet(account, () => chain.tariBalance(account));
    provider = await account.getProvider();
  }
  wallet = chosen;
  pubKey = wallet.publicKey;
  myKeyHex = toHex(pubKey);
  walletAddress = wallet.walletAddress;
  wallets.onSapientAccountChange(() => location.reload());
  await refreshBalance();
}

async function refreshBalance(): Promise<void> {
  balance = await wallet.balance();
  document.querySelectorAll<HTMLElement>("[data-balance]").forEach((el) => (el.textContent = `${chain.formatTari(balance, 3)} ${CONFIG.symbol}`));
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

type Tab = "home" | "send" | "claim" | "tips" | "how";

function layout(active: Tab, ...content: (Node | null)[]): void {
  const link = (href: string, label: string, tab: Tab, cls = "") =>
    h("a", { href, class: cls, "aria-current": active === tab ? "page" : null }, label);
  mount(
    root,
    h(
      "header",
      { class: "top" },
      h("a", { class: "brand", href: "#/" }, h("span", { class: "logo" }, icons.drop(20)), h("span", { class: "brand-name" }, "Skydrop")),
      h(
        "nav",
        { class: "nav" },
        link("#/send", "Send", "send"),
        link("#/claim", "Collect", "claim"),
        link("#/tips", "Tip by post", "tips"),
        link("#/how", "How it works", "how", "hide-sm"),
        h("span", { class: "net hide-sm" }, "Testnet"),
        h("button", { class: "lang", "aria-label": currentLang() === "zh" ? "Switch to English" : "切换到中文", onclick: () => setLang(currentLang() === "zh" ? "en" : "zh") }, currentLang() === "zh" ? "EN" : "中文"),
        h("button", { class: "chip", onclick: openWallet, "aria-label": "Your wallet" }, h("span", { class: "dot" }), icons.wallet(16), h("span", { "data-balance": "" }, `${chain.formatTari(balance, 3)} ${CONFIG.symbol}`)),
      ),
    ),
    ...content,
    h(
      "footer",
      null,
      "Tari testnet: tTARI has no monetary value.",
      h("br"),
      "Escrow contract ",
      h("code", null, short(CONFIG.component, 18, 6)),
      " · verified on-chain, no oracle, no middleman",
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

  const faucetBtn = h("button", { class: "btn primary" }, "Get free testnet tTARI");
  const faucetNote = h("div");
  faucetBtn.addEventListener("click", async () => {
    faucetBtn.disabled = true;
    mount(faucetBtn, ...spinnerLabel("Asking the faucet…"));
    mount(faucetNote);
    try {
      await chain.useFaucet(wallet);
      await new Promise((r) => setTimeout(r, 2500));
      await refreshBalance();
      toast("Testnet tTARI received", "good");
      render();
    } catch (e) {
      const m = chain.friendly(e);
      mount(
        faucetNote,
        h(
          "div",
          { class: "note warn", style: "margin-top:12px" },
          /insufficient|enough|InsufficientFunds|Available/i.test(String(e))
            ? "The public testnet faucet is empty right now. Ask in the Tari community for some tTARI and give them your address above, or try again later."
            : m,
        ),
      );
      faucetBtn.disabled = false;
      mount(faucetBtn, "Get free testnet tTARI");
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
    if (!msg && amt !== null && amt > wRoom()) msg = wRoom() > 0n ? `You can withdraw up to ${chain.formatTari(wRoom())} ${CONFIG.symbol}. A small network fee stays behind.` : "There isn't enough here to cover the network fee.";
    wBtn.disabled = wBusy || !addr || !!addrErr || !amt || amt <= 0n || amt > wRoom();
    if (!wBusy) mount(wBtn, amt && addr && !addrErr ? `Withdraw ${chain.formatTari(amt)} ${CONFIG.symbol}` : "Withdraw");
    mount(wNote, msg ? h("div", { class: "note warn" }, msg) : null);
  };
  wAddr.addEventListener("input", wUpdate);
  wAmt.addEventListener("input", wUpdate);
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
      h("div", { class: "kv" }, h("div", { class: "k" }, "Balance"), h("div", { class: "amount", style: "font-size:36px" }, h("span", { "data-balance": "" }, `${chain.formatTari(balance, 4)} ${CONFIG.symbol}`))),
      h(
        "div",
        { class: "kv" },
        h("div", { class: "k" }, "Your address (share it to receive tTARI)"),
        h("div", { class: "v" }, walletAddress),
        h("div", { class: "row", style: "margin-top:6px" }, h("button", { class: "btn ghost sm", onclick: () => copy(walletAddress, "Address copied") }, icons.copy(), "Copy address")),
      ),
      h("p", { class: "help" }, "Claims with Sapient pay their own small network fee, so keep a little tTARI in it. Get testnet tTARI from inside Sapient."),
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
      h("div", { class: "kv" }, h("div", { class: "k" }, "Balance"), h("div", { class: "amount", style: "font-size:36px" }, h("span", { "data-balance": "" }, `${chain.formatTari(balance, 4)} ${CONFIG.symbol}`))),
      h(
        "div",
        { class: "kv" },
        h("div", { class: "k" }, "Your address (share it to receive tTARI)"),
        h("div", { class: "v" }, walletAddress),
        h("div", { class: "row", style: "margin-top:6px" }, h("button", { class: "btn ghost sm", onclick: () => copy(walletAddress, "Address copied") }, icons.copy(), "Copy address")),
      ),
      h("div", { class: "row" }, faucetBtn),
      faucetNote,
      h("hr", { style: "border:0;border-top:1px solid var(--line);margin:22px 0" }),
      h("div", { class: "kv" }, h("div", { class: "k" }, "Withdraw")),
      h("p", { class: "help", style: "margin:-6px 0 10px" }, "Send tTARI out of Skydrop to any Tari address, such as your Sapient wallet."),
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
        h("button", { class: "btn ghost sm", onclick: () => { showSeed = !showSeed; render(); } }, showSeed ? "Hide" : "Reveal"),
        h("button", { class: "btn ghost sm", onclick: () => copy(seed, "Recovery key copied") }, icons.copy(), "Copy"),
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

/** A handle field that resolves the account as you type. */
const HANDLE_KEY = "skydrop.handle";
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
      const p = await bsky.lookupProfile(v);
      if (mine !== seq) return;
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
  const setValue = (v: string): void => {
    input.value = v;
    void lookup();
  };
  if (initial) setValue(initial);
  return { el: h("div", null, h("div", { class: "field" }, input), result), input, setValue };
}

const SEND_FEE_ROOM = 40_000n;
const needsFunds = (extra = 0n): boolean => balance < extra + SEND_FEE_ROOM;

function fundsNote(): HTMLElement {
  return h(
    "div",
    { class: "note warn" },
    "This wallet has no tTARI for network fees yet. ",
    h("a", { href: "#", onclick: (e: Event) => { e.preventDefault(); openWallet(); } }, "Get some tTARI"),
    ".",
  );
}

// ---------------------------------------------------------------------------------------------------------
// home
// ---------------------------------------------------------------------------------------------------------

function renderHome(): void {
  layout(
    "home",
    h(
      "section",
      { class: "hero" },
      h(
        "div",
        null,
        h("span", { class: "pill" }, icons.shield(14), "Trustless · verified on-chain"),
        h("h1", null, "Send Tari to ", h("em", null, "anyone"), " on Bluesky"),
        h("p", { class: "lead" }, "Type a handle, pick an amount, done. They collect it by proving they own the account. No wallet to set up first, no middleman holding the money."),
      ),
      stamp(),
    ),
    h(
      "div",
      { class: "grid2" },
      h("a", { class: "card action", href: "#/send" }, h("span", { class: "icon" }, icons.send(24)), h("span", { class: "arrow" }, "→"), h("h2", null, "Send"), h("p", null, "Pick a Bluesky handle and an amount. We hold it safely on-chain until they claim it.")),
      h("a", { class: "card action", href: "#/tips" }, h("span", { class: "icon" }, icons.drop(24)), h("span", { class: "arrow" }, "→"), h("h2", null, "Tip by post"), h("p", null, "Fund a budget once, then tip anyone by posting a line on Bluesky. Nobody holds your keys.")),
      h("a", { class: "card action", href: "#/claim" }, h("span", { class: "icon alt" }, icons.gift(24)), h("span", { class: "arrow" }, "→"), h("h2", null, "Collect"), h("p", null, "Someone sent you tTARI? Post one line on Bluesky to prove it's you, then collect.")),
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
  let coverId = "";
  let coverUrl = "";
  let uploading = false;

  const field = handleField(prefill ?? "", (p) => {
    profile = p;
    update();
    if (p) void showWaiting(p);
  });
  const waiting = h("div");
  const amountInput = h("input", { class: "input big", inputmode: "decimal", placeholder: "1.0", "aria-label": "Amount" }) as HTMLInputElement;
  const stage = h("div", { class: "log" });
  const choicesEl = h("div", { class: "choices", role: "radiogroup", "aria-label": "Safety level" });
  const sendBtn = h("button", { class: "btn primary block" }, "Send") as HTMLButtonElement;
  const fundsEl = h("div");
  const card = h("div", { class: "card stack" });
  const noteInput = h("input", { class: "input", maxlength: String(env.MAX_NOTE), placeholder: "Happy birthday! Buy yourself a coffee.", "aria-label": "Note on the envelope" }) as HTMLInputElement;
  const challengeInput = h("input", { class: "input", placeholder: "e.g. I love Tari", "aria-label": "Phrase they must post" }) as HTMLInputElement;
  const challengeNote = h("div");
  const challenge = (): string => challengeInput.value.replace(/\s+/g, " ").trim();
  const challengeProblem = (): string => {
    const c = challenge();
    if (new TextEncoder().encode(c).length > CONFIG.maxChallenge) return `Keep it under ${CONFIG.maxChallenge} bytes (about ${CONFIG.maxChallenge} letters, fewer for non-Latin text).`;
    return "";
  };
  const pickEl = h("div", { class: "env-pick", role: "radiogroup", "aria-label": "Envelope" });
  const previewEl = h("div", { class: "env-preview" });
  const drawEnvelope = (): void => {
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
        h("button", { class: "env-opt", role: "radio", "aria-checked": String(style.id === o.id), style: `--paper:${o.paper};--flap:${o.flap};--seal:${o.seal}`, onclick: () => { style = o; drawEnvelope(); } }, h("div", { class: "mini" }, h("i")), h("b", null, o.name), h("small", null, o.tag)),
      ),
      h("button", { class: "env-up", onclick: () => file.click() }, h("div", { class: "mini", style: coverUrl ? `background-image:url(${coverUrl})` : "" }, coverUrl ? "" : "+"), h("b", null, coverUrl ? "Change picture" : "Your own picture"), h("small", null, "Any image")),
      file,
      h("div", { class: "env-designs" }, h("span", null, "Or start from a design:"), env.PRESETS.map((d) => h("button", { class: "btn ghost sm", onclick: () => void useCover(() => env.presetCover(d.id)) }, d.name))),
    );
    const a = amount();
    mount(
      previewEl,
      env.envelope(style, env.cleanNote(noteInput.value), { amount: a ? `${chain.formatTari(a)} ${CONFIG.symbol}` : undefined, coverUrl: coverUrl || undefined }),
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
    mount(challengeNote, problem ? h("div", { class: "note warn", style: "margin-top:8px" }, problem) : null);
    const ok = !!profile && !!a && a >= CONFIG.minDeposit && !busy && !short && !problem && !uploading;
    sendBtn.disabled = !ok;
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
      mount(waiting, esc.deposits.length ? h("div", { class: "note good", style: "margin-top:12px" }, `${chain.formatTari(chain.total(esc.deposits))} ${CONFIG.symbol} is already waiting for @${p.handle}.`) : null);
    } catch {
      mount(waiting);
    }
  };

  amountInput.addEventListener("input", () => { update(); drawEnvelope(); });
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
      await chain.sendTip(wallet, { did: profile.did, amount: a, window: windowEpochs, challenge: challenge() }, esc.epoch, say);
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
    const link = env.shareLink(location.origin, p.handle, style.id, note, `${chain.formatTari(a)} ${CONFIG.symbol}`, coverId);
    const noteLine = (note ? `\n“${note}”` : "") + (challenge() ? `\nTo collect it, include this in your claim post: ${challenge()}` : "");
    const text = `@${p.handle} I just sent you ${chain.formatTari(a)} ${CONFIG.symbol} on Tari 🎁${noteLine}\nCollect it here (you prove you own this account, no wallet needed):\n${link}`;
    mount(
      card,
      h(
        "div",
        { class: "success" },
        h("div", { class: "delivered" }, "Dispatched"),
        h("h2", { class: "page", style: "margin:8px 0" }, "On its way"),
        h("p", { class: "sub" }, `${chain.formatTari(a)} ${CONFIG.symbol} is now held on-chain for @${p.handle}. ${w ? `They can collect it after a safety window of ${eta(w)}.` : "They can collect it as soon as they verify."}`),
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
    h("div", null, h("label", { class: "f" }, "Envelope"), pickEl, h("div", { class: "env-note" }, noteInput), previewEl, h("p", { class: "help" }, "Optional. The envelope and note travel in the claim link you share, so they see it when they open it.")),
    h("div", null, h("label", { class: "f" }, "Challenge (optional)"), challengeInput, challengeNote, h("p", { class: "help" }, "Make them post something specific. The money is only released if their claim post contains this exact phrase (capital letters and all), and the contract checks it. If they never post it, you can take your money back after the refund time.")),
    h("div", null, h("label", { class: "f" }, "Safety level"), choicesEl, h("p", { class: "help" }, "Each payment sets its own safety window. It protects against someone using a stolen Bluesky key to collect, by giving the real owner time to cancel it.")),
    h("div", null, sendBtn, stage),
  );
  drawChoices();
  drawEnvelope();
  update();
  layout("send", h("h2", { class: "page" }, "Send Tari to a Bluesky handle"), h("p", { class: "sub" }, "Held on-chain until they prove they own the account. ", h("a", { href: "#/sent" }, "Your sends")), card);
  if (!prefill) field.input.focus();
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

  const drawHow = (): void => {
    if (!profile || !budget) return void mount(howEl);
    const text = `@${CONFIG.botHandle} tip @friend.bsky.social 1`;
    mount(
      howEl,
      h("div", { class: "kv" }, h("div", { class: "k" }, "Tip by posting")),
      h("div", { class: "codebox" }, text),
      h("p", { class: "help" }, "Post it from this account, mention the person you are tipping, then the amount. The bot relays your post to the contract, which checks your signature itself. Each post tips once."),
      h("div", { class: "row" }, h("a", { class: "btn bsky sm", href: bsky.composeUrl(text), target: "_blank", rel: "noopener" }, "Open Bluesky", icons.external(14)), h("button", { class: "btn ghost sm", onclick: () => copy(text, "Text copied") }, icons.copy(14), "Copy")),
    );
  };

  const update = (): void => {
    const a = chain.parseTari(amountInput.value);
    const m = chain.parseTari(maxInput.value);
    fundBtn.disabled = !(profile && a && m && a >= CONFIG.minDeposit && m >= CONFIG.minDeposit && !busy);
    if (!busy) mount(fundBtn, budget ? "Add to tip budget" : "Fund tip budget");
  };

  amountInput.addEventListener("input", update);
  maxInput.addEventListener("input", update);
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
    h("div", null, fundBtn, stage),
    howEl,
    h("p", { class: "help" }, "Only the wallet that funded the budget can withdraw it, any time. Anyone who controls the Bluesky account can spend it by posting a tip, so only put aside what you are happy to tip. The network fee for each tip (about 0.06 tTARI) comes out of the budget."),
  );
  drawChoices();
  update();
  layout("tips", h("h2", { class: "page" }, "Tip by posting"), h("p", { class: "sub" }, `Fund a budget once. Then tip anyone by posting "@${CONFIG.botHandle} tip @them 5".`), card);
  if (!prefill) field.input.focus();
}

// ---------------------------------------------------------------------------------------------------------
// collect
// ---------------------------------------------------------------------------------------------------------

function giftEl(g: Gift): HTMLElement {
  const e = env.envelope(g.style, g.note, { coverUrl: g.cover ? `/c/${g.cover}.jpg` : undefined, onToggle: () => wrap.querySelector(".from")?.remove() });
  const wrap = h("div", { class: "env-hello" }, e, h("p", { class: "from" }, "Tap the envelope"));
  return wrap;
}

interface Gift { style: env.Style; note: string; cover: string }

function renderClaim(prefill?: string, gift?: Gift): void {
  let profile: bsky.Profile | null = null;
  let esc: chain.Escrow | null = null;
  let code = "";
  let busy = false;
  let collected: bigint | null = null;
  let sponsorOk = false;
  // The page does the waiting for you: it watches for the post, verifies, and collects when the payout is due.
  // Anything that fails switches this off so you get the buttons and the error instead of a retry loop.
  let autoVerify: (() => Promise<void>) | null = null;
  let autoCollect: (() => Promise<void>) | null = null;
  let autoOff = false;
  let watching = true;
  let checking = false;
  const canAuto = (): boolean => !autoOff && wallet.kind === "builtin";
  // Phrases senders asked for. The post has to contain the ones that fit in it; deposits whose phrase didn't fit stay escrowed.
  const claimPost = (): { text: string; used: string[]; dropped: number } =>
    bsky.claimPostText(CONFIG.symbol, code, [...new Set((esc?.deposits ?? []).map((d) => d.challenge).filter(Boolean))]);

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
    code = await bsky.claimCode(CONFIG.component, profile.did, pubKey);
    sponsorOk = wallet.account !== null && (await chain.readSponsorBalance(provider)) >= chain.SPONSOR_FEE * 3n;
    await reload();
  };

  const reload = async (): Promise<void> => {
    if (!profile) return;
    try {
      esc = await chain.readEscrow(provider, profile.did);
      noteEpoch(esc.epoch);
      draw();
    } catch (e) {
      mount(stepsEl, h("div", { class: "note bad" }, chain.friendly(e)));
    }
  };

  const poll = window.setInterval(() => { if (profile && !busy) void reload(); }, 20_000);
  cleanups.push(() => clearInterval(poll));

  const watch = window.setInterval(async () => {
    if (!profile || !esc || busy || checking || autoOff || collected !== null || !esc.deposits.length) return;
    if (esc.pending?.claimant === myKeyHex) {
      if (canAuto() && chain.payableNow(esc, esc.pending.start).amount > 0n) void autoCollect?.();
      return;
    }
    if (!watching) return;
    checking = true;
    try {
      if (await bsky.findClaimPost(profile.did, code, claimPost().used)) {
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

    if (collected !== null) {
      mount(stepsEl, h("div", { class: "card success" }, h("div", { class: "delivered" }, "Delivered"), h("div", { class: "amount" }, chain.formatTari(collected), h("small", null, CONFIG.symbol)), h("h2", { class: "page", style: "margin:12px 0 4px" }, "Collected!"), h("p", { class: "sub" }, "It's in your Skydrop wallet now."), h("div", { class: "row", style: "justify-content:center" }, h("button", { class: "btn primary", onclick: openWallet }, "Open wallet"), h("a", { class: "btn ghost", href: "#/send" }, "Send some to a friend"))));
      return;
    }

    if (!e.deposits.length) {
      mount(
        stepsEl,
        h("div", { class: "card", style: "margin-top:16px" }, h("h3", { style: "margin:0 0 6px" }, `Nothing is waiting for @${p.handle} yet`), h("p", { class: "sub", style: "margin:0 0 14px" }, "When someone sends tTARI to this account it shows up here. Want to try it? Send some to yourself."), h("a", { class: "btn ghost", href: `#/send/${p.handle}` }, "Send to this account")),
      );
      return;
    }

    const start = mine ? e.pending!.start : e.epoch;
    const pay = chain.payableNow(e, start);

    const stepClass = (n: number, cur: number) => `step ${n < cur ? "done" : n === cur ? "active" : "locked"}`;
    // a claim whose post missed a phrase a sender asked for pays nothing on that deposit: post again
    const needPhrase = mine && pay.missing.length > 0 && pay.amount === 0n && pay.waitingAmount === 0n;
    const cur = !mine || needPhrase ? 1 : pay.amount > 0n ? 4 : 3;

    const logEl = h("div", { class: "log" });
    const say = (s: string) => logEl.appendChild(h("div", null, s));

    const verifyBtn = h("button", { class: "btn primary" }, "I've posted it. Verify and claim") as HTMLButtonElement;
    const runVerify = async (): Promise<void> => {
      if (busy) return;
      if (!sponsorOk && needsFunds()) return void toast("You need a little tTARI for network fees first.", "bad");
      busy = true;
      verifyBtn.disabled = true;
      mount(verifyBtn, ...spinnerLabel("Verifying…"));
      try {
        say("Looking for your post on Bluesky");
        const post = await bsky.findClaimPost(p.did, code, claimPost().used);
        if (!post) throw new Error((await bsky.whyNoClaimPost(p.did, code, claimPost().used)) || "We couldn't find a post containing your code yet. Post it publicly, wait a few seconds, then try again.");
        say("Fetching the signed copy of your post");
        const proof = await bsky.buildClaimProof(p.did, post.rkey);
        say("Submitting the proof. The contract checks every signature itself");
        if (sponsorOk) {
          try {
            say("Network fees are covered for you");
            await chain.startClaimSponsored(wallet, proof, say);
          } catch (err) {
            if (needsFunds()) throw err;
            say("Sponsored fees weren't available, so your wallet pays the small fee");
            await chain.startClaim(wallet, proof, say);
          }
        } else {
          await chain.startClaim(wallet, proof, say);
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
          if (sponsorOk) {
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
        const fresh = await chain.readEscrow(provider, p.did);
        esc = fresh;
        if (fresh.deposits.length) {
          toast(`Collected ${chain.formatTari(got)} ${CONFIG.symbol}. The rest is still in its safety window.`, "good");
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

    const { text: postText, dropped } = claimPost();
    const maxWin = Math.max(...e.deposits.map((d) => d.window));
    const elapsed = mine ? Math.max(0, e.epoch - e.pending!.start) : 0;
    const pct = maxWin ? Math.min(100, Math.round((elapsed / maxWin) * 100)) : 100;

    mount(
      stepsEl,
      h("div", { class: "card", style: "margin-top:16px;text-align:center" }, h("div", { class: "pill" }, `Waiting for @${p.handle}`), h("div", { class: "amount", style: "margin-top:10px" }, chain.formatTari(waitingTotal), h("small", null, CONFIG.symbol))),
      others ? h("div", { class: "note warn", style: "margin-top:12px" }, "Another wallet has started a claim on this account. If that isn't you, the real owner can cancel it. You can still start your own claim below.") : null,
      sponsorOk ? h("div", { class: "note good", style: "margin-top:12px" }, "Network fees are covered. You don't need any tTARI to collect.") : needsFunds() && cur === 1 ? h("div", { style: "margin-top:12px" }, fundsNote()) : null,
      h(
        "div",
        { class: "steps" },
        h("div", { class: stepClass(1, cur) }, h("div", { class: "num" }, cur > 1 ? icons.check(18) : "1"), h("div", null, h("h3", null, "Post this on Bluesky"), h("p", null, "Post it from your account (so everyone can see it). It ties this claim to your wallet, and you can delete the post afterwards."), pay.missing.length || e.deposits.some((d) => d.challenge) ? h("div", { class: "note", style: "margin:0 0 10px" }, `The sender asked for something specific: ${[...new Set(e.deposits.map((d) => d.challenge).filter(Boolean))].map((c) => `“${c}”`).join(", ")}. It leads the text below. The money for that deposit is only released if your post says it exactly.${dropped ? ` Too many phrases fit in one post, so ${dropped} will wait for a second post.` : ""}`) : null, h("div", { class: "codebox" }, postText), h("div", { class: "row", style: "margin-top:12px" }, h("a", { class: "btn bsky sm", href: bsky.composeUrl(postText), target: "_blank", rel: "noopener" }, "Open Bluesky", icons.external(14)), h("button", { class: "btn ghost sm", onclick: () => copy(postText, "Text copied") }, icons.copy(14), "Copy")))),
        h("div", { class: cur === 1 ? "step active" : stepClass(2, cur) }, h("div", { class: "num" }, cur > 2 ? icons.check(18) : "2"), h("div", null, h("h3", null, "Prove it's you"), h("p", null, "We fetch the signed copy of your post straight from Bluesky. The contract checks the signatures itself. Nobody has to trust us."), cur === 1 ? h("div", null, canAuto() && !autoOff ? h("p", { class: "help" }, "Watching for your post. This continues by itself once it appears, and your tTARI is collected automatically when it's due.") : null, verifyBtn, logEl) : null)),
        h("div", { class: stepClass(3, cur) }, h("div", { class: "num" }, cur > 3 ? icons.check(18) : "3"), h("div", null, h("h3", null, "Safety window"), cur >= 3 ? h("div", null, h("p", null, pay.nextEpoch !== null ? `Larger payments wait a bit so the real owner could stop a hijack. Next release ${eta(Math.max(0, pay.nextEpoch - e.epoch))}.` : "All clear."), h("div", { class: "bar", role: "progressbar", "aria-valuenow": pct, "aria-valuemin": 0, "aria-valuemax": 100 }, h("i", { style: `width:${pct}%` }))) : h("p", null, "Small payments skip this. Larger ones wait a short while first."))),
        h("div", { class: stepClass(4, cur) }, h("div", { class: "num" }, "4"), h("div", null, h("h3", null, "Collect"), cur === 4 ? h("div", null, h("p", null, pay.waitingAmount > 0n ? `${chain.formatTari(pay.amount)} ${CONFIG.symbol} is ready now. ${chain.formatTari(pay.waitingAmount)} more is still in its safety window.` : "It's ready."), collectBtn, logEl) : h("p", null, "Your tTARI lands in your Skydrop wallet."))),
      ),
    );
  };

  layout(
    "claim",
    h("h2", { class: "page" }, "Collect your tTARI"),
    gift && (gift.note || gift.cover || gift.style.id !== "air") ? giftEl(gift) : null,
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
    if (!data.items.length) {
      return mount(
        listEl,
        h("div", { class: "card" }, h("h3", { style: "margin:0 0 6px;font-family:var(--serif);font-size:26px" }, "Nothing waiting"), h("p", { class: "sub", style: "margin:0 0 14px" }, "Anything you send that nobody has collected yet shows up here, and you can take it back after its refund time."), h("a", { class: "btn primary", href: "#/send" }, "Send some")),
      );
    }
    const profiles = await Promise.all(data.items.map((d) => profileFor(d.did)));
    const rows = data.items.map((d, i) => {
      const p = profiles[i];
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
      const link = `${location.origin}${location.pathname}#/claim/${p?.handle ?? d.did}`;
      const nudge = `@${p?.handle ?? ""} there's ${chain.formatTari(d.amount)} ${CONFIG.symbol} waiting for you on Tari 🎁 Collect it here:\n${link}`;
      return h(
        "div",
        { class: "card", style: "padding:20px" },
        h("div", { class: "row", style: "justify-content:space-between;align-items:flex-start" },
          h("div", { class: "row", style: "gap:12px;flex-wrap:nowrap" }, p?.avatar ? h("img", { src: p.avatar, alt: "", width: 48, height: 48, style: "border-radius:50%;border:2px solid var(--edge)" }) : h("div", { class: "avatar", style: "width:48px;height:48px" }), h("div", null, h("div", { style: "font-weight:700;font-size:18px" }, handle), h("div", { class: "help", style: "margin:0" }, d.window ? `Safety window ${eta(d.window)}` : "Instant collect", d.challenge ? ` · must post “${d.challenge}”` : ""))),
          h("div", { class: "amount", style: "font-size:34px" }, chain.formatTari(d.amount), h("small", null, CONFIG.symbol)),
        ),
        h("div", { class: "note", style: "margin-top:14px" }, ready ? "Nobody has collected this. You can take it back now." : `Waiting for them to collect. You can take it back in ${eta(left)}.`),
        h("div", { class: "row", style: "margin-top:12px" }, ready ? btn : null, p ? h("a", { class: "btn ghost sm", href: bsky.composeUrl(nudge), target: "_blank", rel: "noopener" }, "Remind them", icons.external(14)) : null, h("a", { class: "btn ghost sm", href: `#/claim/${p?.handle ?? ""}` }, "Open claim page")),
        say,
      );
    });
    mount(listEl, ...rows);
  };

  const poll = window.setInterval(() => { if (!busy) void load(); }, 60_000);
  cleanups.push(() => clearInterval(poll));
  layout("send", h("h2", { class: "page" }, "Your sends"), h("p", { class: "sub" }, "Everything this wallet has put in escrow that nobody has collected yet."), listEl);
  void load();
}

// ---------------------------------------------------------------------------------------------------------
// how it works
// ---------------------------------------------------------------------------------------------------------

function renderHow(): void {
  layout(
    "how",
    h("h2", { class: "page" }, "How it works"),
    h("p", { class: "sub" }, "Short version: the money sits in a smart contract that can check Bluesky's own signatures."),
    h(
      "div",
      { class: "card" },
      h(
        "ol",
        { class: "how", style: "padding-left:20px;margin:0" },
        h("li", null, h("b", null, "You send."), " The tTARI moves into an escrow contract, filed under the recipient's permanent Bluesky ID (not their handle, which can change hands)."),
        h("li", null, h("b", null, "They post a code."), " The code is a hash of their wallet's key, so the post can only ever pay out to the wallet that asked."),
        h("li", null, h("b", null, "The contract checks the math."), " Bluesky accounts are cryptographic identities. The contract verifies the account's identity history, the signature on their repository and the path to the post. No server is asked."),
        h("li", null, h("b", null, "They collect."), " After the safety window you chose, the escrow pays out to their wallet."),
      ),
    ),
    h("details", null, h("summary", null, "What's the safety window for?"), h("p", null, "A proof can show an account's history is valid, but not that it's complete. If someone stole a Bluesky signing key and the real owner had already rotated it, the thief could present the old history. The window lets anyone submit the owner's rotation and cancel the claim. Small tips can skip it. Large transfers should use it.")),
    h("details", null, h("summary", null, "What if nobody claims it?"), h("p", null, `The sender can take it back after about ${eta(CONFIG.refundAfterEpochs)}.`)),
    h("details", null, h("summary", null, "What can't it do yet?"), h("p", null, "Only did:plc accounts work (almost everyone). Private payouts to a stealth address are planned. This is testnet.")),
    h("details", null, h("summary", null, "Is my wallet safe?"), h("p", null, "It's created in your browser and never sent anywhere. Back up your recovery key from the wallet menu. This is testnet software.")),
  );
}

// ---------------------------------------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------------------------------------

function route(): void {
  cleanups.forEach((f) => f());
  cleanups = [];
  const [, kind = "", rawArg = ""] = location.hash.replace(/^#/, "").split("/");
  const [arg = "", query = ""] = rawArg.split("?");
  const param = decodeURIComponent(arg);
  const q = new URLSearchParams(query);
  if (kind === "send") renderSend(param || undefined);
  else if (kind === "claim") renderClaim(param || undefined, { style: env.styleOf(q.get("e")), note: env.cleanNote(q.get("m") ?? ""), cover: env.isCoverId(q.get("c")) ? q.get("c")! : "" });
  else if (kind === "tips") renderTips(param || undefined);
  else if (kind === "sent") renderSent();
  else if (kind === "how") renderHow();
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
  addEventListener("hashchange", route);
  route();
  if (currentLang() === "zh") startChinese();
})();
