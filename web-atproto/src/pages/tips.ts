/**
 * Send a gift to any Bluesky handle — the recipient claims it later with one post.
 * Uses the Escrow + ClaimPolicy gift stack.
 */
import { giftsDeployed, giftLink, DEPLOYMENT } from "../data/deployment";
import { fromMicro, toMicro } from "../lib/campaign";
import { currentEpoch, depositInstructions, GIFT_REFUND_EPOCHS, GIFT_WORKSPACE, type Instruction } from "../lib/chain";
import { copyButton, h, pageHead, replace } from "../lib/dom";
import { resolveActor, type Actor } from "../lib/atproto";
import { connectWallet, friendly, onWallet, sendFunded, walletBalance, type WalletState } from "../lib/wallet";
import type { Page } from "../main";

const MIN_MICRO = 1000n; // 0.000001 TARI — the escrow's floor

export function tipsPage(): Page {
  const form = h("form", { class: "fieldstack", novalidate: "" });
  const walletBox = h("div");
  const result = h("div");

  let ws: WalletState = { available: false, connected: false, name: "Sapient", account: null, address: null, key: null, network: null };

  const stop = onWallet((w) => {
    ws = w;
    drawWallet();
  });

  function drawWallet(): void {
    if (!ws.connected) {
      replace(walletBox, h("div", { class: "note" },
        ws.available
          ? h("button", { class: "btn primary", type: "button", onclick: async () => { try { await connectWallet(); } catch (e) { showError(friendly(e)); } } }, `Connect ${ws.name}`)
          : h("span", null, "Install ", h("a", { href: "https://chromewebstore.google.com/detail/tari-ootle-wallet/demkeckolenopkgnfbnpflkpbbdhpgkl", target: "_blank" }, "Sapient"), " to send gifts."),
        h("span", { class: "muted small-text" }, " You need a wallet to sign the deposit transaction."),
      ));
    } else {
      replace(walletBox, h("p", { class: "small-text muted" }, `Sending from: `, h("strong", null, ws.address ? `${ws.address.slice(0, 20)}…` : ws.account ?? "")));
    }
  }

  function showError(msg: string): void {
    replace(result, h("div", { class: "note bad" }, msg));
  }

  async function resolveField(): Promise<Actor | null> {
    const val = (form.querySelector<HTMLInputElement>('[name="handle"]')?.value ?? "").trim();
    if (!val) { showError("Enter a Bluesky handle or DID."); return null; }
    try {
      return await resolveActor(val);
    } catch (e) {
      showError((e as Error).message);
      return null;
    }
  }

  async function send(e: Event): Promise<void> {
    e.preventDefault();
    replace(result);
    if (!ws.connected || !ws.key) { showError("Connect your wallet first."); return; }
    if (!giftsDeployed()) { showError("The gift stack isn't live on this network yet."); return; }

    const actor = await resolveField();
    if (!actor) return;

    const amountStr = (form.querySelector<HTMLInputElement>('[name="amount"]')?.value ?? "").trim();
    let amountMicro: bigint;
    try {
      amountMicro = toMicro(amountStr);
    } catch (e) {
      showError((e as Error).message);
      return;
    }
    if (amountMicro < MIN_MICRO) { showError(`The minimum gift is ${fromMicro(MIN_MICRO)} ${DEPLOYMENT.unit}.`); return; }

    const noteStr = (form.querySelector<HTMLInputElement>('[name="note"]')?.value ?? "").slice(0, 160);

    const btn = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    btn.disabled = true;
    btn.textContent = "Checking balance…";
    replace(result);

    try {
      const balance = await walletBalance();
      if (balance !== null && balance < amountMicro) {
        showError(`Your wallet has ${fromMicro(balance)} ${DEPLOYMENT.unit} but you're trying to send ${fromMicro(amountMicro)}.`);
        return;
      }

      btn.textContent = "Getting epoch…";
      const epoch = await currentEpoch();
      const refundEpoch = epoch + GIFT_REFUND_EPOCHS;

      const followUp: Instruction[] = depositInstructions(actor.did, ws.key, refundEpoch);

      btn.textContent = "Waiting for wallet…";
      const txId = await sendFunded(amountMicro, "resource_0101010101010101010101010101010101010101010101010101010101010101", GIFT_WORKSPACE, followUp, [DEPLOYMENT.escrow, DEPLOYMENT.claim], 60_000n,
        (stage) => { btn.textContent = stage === "approve" ? "Approve in wallet…" : "Sending…"; });

      const shareUrl = giftLink(actor.handle, { amount: `${fromMicro(amountMicro)} ${DEPLOYMENT.unit}`, note: noteStr || undefined });
      replace(result,
        h("div", { class: "note ok" },
          h("strong", null, `Gift sent! `),
          `${fromMicro(amountMicro)} ${DEPLOYMENT.unit} is waiting for @${actor.handle}.`,
        ),
        h("div", { class: "fieldstack", style: "margin-top:16px" },
          h("label", null, "Share this link with them"),
          h("div", { class: "row" },
            h("input", { class: "input", type: "url", readonly: "", value: shareUrl }),
            copyButton(() => shareUrl, "Copy link"),
          ),
          h("p", { class: "muted small-text" }, `Transaction: `, h("a", { href: `${DEPLOYMENT.explorer}/transactions/${txId}`, target: "_blank", rel: "noopener" }, txId.slice(0, 20), "…")),
        ),
      );
    } catch (e) {
      showError(friendly(e));
    } finally {
      btn.disabled = false;
      btn.textContent = "Send gift";
    }
  }

  // Build the form
  const handleInput = h("input", { class: "input", type: "text", name: "handle", placeholder: "alice.bsky.social", autocomplete: "off" });
  const amountInput = h("input", { class: "input", type: "text", name: "amount", placeholder: `1 ${DEPLOYMENT.unit}`, autocomplete: "off" });
  const noteInput = h("input", { class: "input", type: "text", name: "note", placeholder: "Happy birthday! (optional)", maxlength: "160", autocomplete: "off" });

  // Live preview of the recipient
  const preview = h("div");
  handleInput.addEventListener("input", () => {
    const v = handleInput.value.trim();
    if (!v) { replace(preview); return; }
    resolveActor(v).then((a) => {
      if (a.did && handleInput.value.trim() === v) {
        replace(preview, h("p", { class: "small-text muted" }, "→ ", h("strong", null, a.did)));
      }
    }).catch(() => replace(preview));
  });

  form.append(
    h("div", null,
      h("label", { for: "gift-handle" }, "Recipient (Bluesky handle)"),
      h("div", { style: "position:relative" }, h("input", { class: "input", id: "gift-handle", type: "text", name: "handle", placeholder: "alice.bsky.social", autocomplete: "off" }), preview),
    ),
    h("div", null,
      h("label", { for: "gift-amount" }, "Amount"),
      h("input", { class: "input", id: "gift-amount", type: "text", name: "amount", placeholder: `1 ${DEPLOYMENT.unit}`, autocomplete: "off" }),
    ),
    h("div", null,
      h("label", { for: "gift-note" }, "Note (optional)"),
      h("input", { class: "input", id: "gift-note", type: "text", name: "note", placeholder: "Happy birthday!", maxlength: "160", autocomplete: "off" }),
      h("p", { class: "small-text muted" }, "Shown on the gift card the recipient opens. Stored off-chain in Skydrop."),
    ),
    h("button", { class: "btn primary", type: "submit" }, "Send gift"),
  );
  form.addEventListener("submit", (e) => void send(e));

  // Live preview on handle field — re-attach to the actually-rendered input
  const renderedHandle = form.querySelector<HTMLInputElement>('[name="handle"]')!;
  const renderedPreview = form.querySelector<HTMLDivElement>('[style="position:relative"]')!.appendChild(h("div"));
  renderedHandle.addEventListener("input", () => {
    const v = renderedHandle.value.trim();
    if (!v) { replace(renderedPreview); return; }
    resolveActor(v).then((a) => {
      if (renderedHandle.value.trim() === v)
        replace(renderedPreview, h("p", { class: "small-text muted", style: "margin:4px 0 0" }, "→ ", h("strong", null, a.did)));
    }).catch(() => replace(renderedPreview));
  });

  const body = h("div", { class: "wrap narrow" },
    pageHead("Send", "Gift TARI to a Bluesky handle",
      `The recipient doesn't need a wallet. They claim their ${DEPLOYMENT.unit} later by posting one message on Bluesky.`),
    giftsDeployed()
      ? null
      : h("div", { class: "note warn" }, `The gift stack isn't deployed on ${DEPLOYMENT.network} yet. Run `, h("code", null, "deploy-gifts.mjs"), " first."),
    walletBox,
    form,
    result,
    h("hr"),
    h("h2", null, "How it works"),
    h("ol", { class: "steplist" },
      h("li", null, "You send ", h("strong", null, DEPLOYMENT.unit), " to their Bluesky handle. The funds go into a secure vault on the Ootle network."),
      h("li", null, "You share the gift link. It leads to a page that shows the amount and your note."),
      h("li", null, "To claim, they prove ownership of their account with one post — no wallet needed in advance."),
      h("li", null, "If they haven't claimed after three weeks, the funds return to you automatically."),
    ),
    h("p", { class: "muted small-text" }, "Need to claim a gift? Go to ", h("a", { href: `${DEPLOYMENT.skydrop}/` }, "Skydrop"), "."),
  );

  return { title: "Send a gift · ATProto for Ootle", body };
}
