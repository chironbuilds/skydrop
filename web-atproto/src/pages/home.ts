import { PLAYBOOKS } from "../data/playbooks";
import { contractsOnNetwork, DEPLOYMENT, isPublished } from "../data/deployment";
import { encodeOps, fetchProof, latestPost, parseAtUri, pdsOf, plcLog } from "../lib/atproto";
import { h, replace } from "../lib/dom";
import { fieldStr, verifyChain, verifyRecord } from "../lib/verify";
import { RULES } from "../lib/campaign";
import { playbookCard } from "./campaigns";
import type { Page } from "../main";

const LINKS: [string, string, string][] = [
  ["The DID", "A did:plc is the hash of the account's signed genesis operation.", "Identity"],
  ["The identity log", "Each operation is signed by a key the one before allowed. Walking it gives the current signing key.", "Keys"],
  ["The repo commit", "That key signs a commit to the root of the account's Merkle search tree.", "Signature"],
  ["The tree path", "Hashes link the signed root to one exact record: a like, a follow, a post.", "Merkle proof"],
  ["Your contract", "It has just checked all of this in WASM. It now acts on the fact, with no oracle.", "On-chain"],
];

const SHOW_LINES = [
  "Fetching @bsky.app's latest post",
  "Reading the identity log",
  "Verifying every signature in it",
  "Fetching the signed repo proof",
  "Checking the commit and tree path",
];

/** Not an animation of a proof: this fetches a real post and verifies it, on the page, every time it loads. */
function liveProof(): HTMLElement {
  const lines = h("div", { class: "livelines" });
  const result = h("div", { class: "liveresult" });
  const again = h("button", { class: "chip mini", type: "button" }, "Run it again");
  const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const wait = () => new Promise((r) => setTimeout(r, calm ? 0 : 380));
  const line = (text: string) => {
    const el = h("div", { class: "liveline run" }, h("span", { class: "tick", "aria-hidden": "true" }, "›"), h("span", null, text));
    lines.appendChild(el);
    return {
      ok(detail?: string) {
        el.className = "liveline ok";
        replace(el, h("span", { class: "tick", "aria-hidden": "true" }, "✓"), h("span", null, text), detail ? h("span", { class: "dim" }, detail) : null);
      },
    };
  };
  async function run(): Promise<void> {
    again.disabled = true;
    replace(lines);
    replace(result);
    try {
      let l = line(SHOW_LINES[0]!);
      const started = performance.now();
      const post = await latestPost("bsky.app");
      const at = post && parseAtUri(post.uri);
      if (!at) throw new Error("no post");
      l.ok();
      await wait();
      l = line(SHOW_LINES[1]!);
      const log = await plcLog(at.did);
      const ops = encodeOps(log);
      l.ok(`${ops.length} operations`);
      await wait();
      l = line(SHOW_LINES[2]!);
      const chain = await verifyChain(at.did, ops);
      if (!chain.ok) throw new Error("chain");
      l.ok(`${chain.key.slice(0, 10)}…`);
      await wait();
      l = line(SHOW_LINES[3]!);
      const proof = await fetchProof(pdsOf(log), at.did, at.collection, at.rkey);
      l.ok(`${proof.nodes.length} tree nodes`);
      await wait();
      l = line(SHOW_LINES[4]!);
      const rec = await verifyRecord(at.did, chain, proof, at.collection, at.rkey);
      if (!rec.ok) throw new Error("record");
      l.ok(`${rec.root.slice(0, 10)}…`);
      const text = (await fieldStr(proof.record, ["text"])) ?? "";
      replace(result,
        h("p", { class: "livequote" }, `“${text.length > 140 ? `${text.slice(0, 140)}…` : text}”`),
        h("p", { class: "dim" }, `Proven in your browser in ${((performance.now() - started) / 1000).toFixed(1)}s, by the code a contract runs. Nothing was trusted but signatures.`));
    } catch {
      replace(result, h("p", { class: "dim" }, "Couldn't reach Bluesky just now, so no proof ran."));
    }
    again.disabled = false;
  }
  again.addEventListener("click", () => void run());
  void run();
  return h("div", { class: "livecard" },
    h("div", { class: "livehead" }, h("span", { class: "livedot", "aria-hidden": "true" }), h("span", null, "Running live in your browser"), again),
    lines, result,
    h("a", { class: "livelink", href: "/verify" }, "Try to fool it →"));
}

export function homePage(): Page {
  return {
    title: "ATProto for Ootle",
    body: h("div", null,
      h("section", { class: "hero" }, h("div", { class: "wrap herogrid" }, h("div", null,
        h("span", { class: "kicker" }, "A trustless identity layer"),
        h("h1", null, "Contracts that check Bluesky ", h("span", { class: "glow" }, "for themselves.")),
        h("p", { class: "lede" }, "Create campaigns that reward likes, follows, posts and memberships from a pool nobody can redirect. Participants track their progress and claim on Skydrop, and every claim is proven from the account's own signatures, with no oracle and no one in the middle."),
        h("div", { class: "row" },
          h("a", { class: "btn primary", href: "/campaigns/new" }, "Build a campaign"),
          h("a", { class: "btn ghost", href: "/verify" }, "Run a live proof"),
        ),
        h("p", { class: "statusline" }, isPublished() ? (DEPLOYMENT.isMainnet ? "Live on Ootle mainnet. The contracts haven't had an outside audit." : "Live on the Esmeralda testnet, with testnet tokens only. Not audited yet.") : (contractsOnNetwork() ? "The contracts are on the Esmeralda testnet. Funding and claiming from the site is still being built, so for now campaigns can be designed and checked." : "The contracts aren't published on this network yet, so campaigns can be designed and checked but not funded."), " ", h("a", { href: "/status" }, "See status")),
      ), liveProof())),

      h("section", { class: "sec" }, h("div", { class: "wrap" },
        h("span", { class: "kicker" }, "What you can do here"),
        h("h2", null, "Three ways in"),
        h("div", { class: "grid g3" },
          h("a", { class: "card", href: "/campaigns" }, h("span", { class: "tag" }, "run"), h("h3", null, "Start a campaign"), h("p", null, `${PLAYBOOKS.length} playbooks, from launch quests to retroactive airdrops. Combine ${RULES.length} kinds of proof, set a pool and a window, and see what it costs before you commit.`)),
          h("a", { class: "card", href: "/verify" }, h("span", { class: "tag" }, "check"), h("h3", null, "See a proof run"), h("p", null, "Enter any account and watch your browser verify it step by step, using the same Rust code the contracts run. Then tamper with a byte and watch it fail.")),
          h("a", { class: "card", href: "/docs/integrate" }, h("span", { class: "tag" }, "build"), h("h3", null, "Write your own policy"), h("p", null, "Link the verifier crate or call the shared component, then gate your own logic on what it proves. A worked example covers every moving part.")),
        ),
      )),

      h("section", { class: "sec" }, h("div", { class: "wrap" },
        h("span", { class: "kicker" }, "How a claim is proven"),
        h("h2", null, "A chain of signatures, all the way down"),
        h("p", { class: "sec-lede" }, "Bluesky accounts are anchored in cryptography a contract can reproduce. The proof travels with the claim, so the contract trusts the account's own keys and nothing else."),
        h("div", { class: "chain" }, LINKS.map(([title, text, tag], i) => h("div", { class: "link" }, h("span", { class: "n" }, `${i + 1} · ${tag}`), h("h3", null, title), h("p", null, text)))),
      )),

      h("section", { class: "sec" }, h("div", { class: "wrap" },
        h("span", { class: "kicker" }, "Campaign playbooks"),
        h("h2", null, "Pick a goal, then adjust it"),
        h("p", { class: "sec-lede" }, "Each playbook opens in the builder with its rules filled in. Each one also says plainly where it can be gamed."),
        h("div", { class: "grid g3" }, PLAYBOOKS.filter((p) => ["launch-quest", "stay-and-earn", "contributors", "retro", "referrals", "poap"].includes(p.id)).map(playbookCard)),
        h("div", { class: "row", style: "margin-top:22px" }, h("a", { class: "btn ghost", href: "/campaigns" }, `All ${PLAYBOOKS.length} playbooks`)),
      )),

      h("section", { class: "sec" }, h("div", { class: "wrap" },
        h("span", { class: "kicker" }, "Straight answers"),
        h("h2", null, "What this can and can't prove"),
        h("div", { class: "grid g3" },
          h("div", { class: "card" }, h("span", { class: "tag" }, "provable"), h("h3", null, "An account signed this"), h("p", null, "That a did:plc account's repo holds a specific like, follow, post or list item, and that a key was current for it.")),
          h("div", { class: "card" }, h("span", { class: "tag" }, "not provable"), h("h3", null, "When, or whether it's still there"), h("p", null, "An account signs its own timestamps, and an old proof still verifies after a record is deleted. Rounds and fresh commits narrow this; they don't remove it.")),
          h("div", { class: "card" }, h("span", { class: "tag" }, "not provable"), h("h3", null, "That one person is one account"), h("p", null, "Bluesky accounts are free, so open campaigns can be farmed. Vouch rules and allocation lists are the real defence, and the builder shows your exposure.")),
        ),
        h("div", { class: "row", style: "margin-top:22px" }, h("a", { class: "btn ghost", href: "/docs/security" }, "Read the trust boundaries")),
      )),

      h("section", { class: "sec ethos" }, h("div", { class: "wrap" },
        h("h2", null, "Tari ", h("span", { class: "heart" }, "❤"), " atproto"),
        h("p", null, "Identity you own, data you can carry with you, and proofs anyone can check. Both projects make that bet, so the bridge between them works the same way."),
      )),
    ),
  };
}
