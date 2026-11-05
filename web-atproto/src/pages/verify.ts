import { encodeOps, fetchProof, latestPost, parseAtUri, pdsOf, plcLog, resolveActor, toTarget, type RepoProof } from "../lib/atproto";
import { h, pageHead, replace } from "../lib/dom";
import { explain, fieldStr, verifyChain, verifyRecord, type ChainResult, type Failure } from "../lib/verify";
import type { Page } from "../main";
import { stepCard } from "./campaign";

const kb = (n: number): string => (n < 1024 ? `${n} bytes` : `${(n / 1024).toFixed(1)} KB`);

interface Loaded { did: string; collection: string; rkey: string; ops: Uint8Array[]; chain: ChainResult; proof: RepoProof }

export function verifyPage(): Page {
  const input = h("input", { placeholder: "bsky.app/profile/name/post/3k…  or at://…", "aria-label": "Post link or at:// URI", spellcheck: "false", autocomplete: "off" });
  const go = h("button", { class: "btn primary", type: "submit" }, "Verify it");
  const sample = h("button", { class: "btn ghost", type: "button" }, "Use the latest post from @bsky.app");
  const steps = h("div", { class: "steps", "aria-live": "polite" });
  const tamper = h("div");
  const form = h("form", { class: "row", style: "margin-top:4px" }, h("div", { style: "flex:1;min-width:240px" }, input), go, sample);

  const put = (card: HTMLElement) => steps.appendChild(card);

  async function run(uriText: string): Promise<void> {
    go.disabled = sample.disabled = true;
    replace(steps);
    replace(tamper);
    let running: HTMLElement = put(stepCard("run", "Finding the record"));
    const step = (card: HTMLElement) => {
      running.replaceWith(card);
      running = card;
    };
    const next = (title: string) => {
      running = put(stepCard("run", title));
    };
    try {
      const target = uriText.startsWith("at://") ? uriText : await toTarget(uriText, "post");
      const at = parseAtUri(target);
      if (!at) throw new Error("That isn't a record address.");
      const actor = await resolveActor(at.did);
      step(stepCard("ok", "Found the account", `@${actor.handle}`, at.did));

      next("Reading the identity log");
      const log = await plcLog(at.did);
      const ops = encodeOps(log);
      const pds = pdsOf(log);
      step(stepCard("ok", "Read the identity log", `${ops.length} signed operation${ops.length === 1 ? "" : "s"} from plc.directory, ${kb(ops.reduce((n, o) => n + o.length, 0))}. That directory isn't trusted: every signature is checked next.`));

      next("Verifying the identity chain");
      let t = performance.now();
      const chain = await verifyChain(at.did, ops);
      if (!chain.ok) {
        step(stepCard("fail", "The identity chain failed", explain(chain)));
        return;
      }
      step(stepCard("ok", "Identity chain verified", `The log hashes to this DID, each operation is signed by a key the previous one allowed. Took ${Math.round(performance.now() - t)} ms.`, `signing key (${chain.alg}): ${chain.key}`));

      next("Fetching the signed repo proof");
      const proof = await fetchProof(pds, at.did, at.collection, at.rkey);
      step(stepCard("ok", "Fetched the repo proof", `From the account's own data host, which isn't trusted either: a commit, ${proof.nodes.length} tree node${proof.nodes.length === 1 ? "" : "s"} and the record, ${kb(proof.commit.length + proof.record.length + proof.nodes.reduce((n, x) => n + x.length, 0))}.`, new URL(pds).host));

      next("Verifying the commit and the tree path");
      t = performance.now();
      const rec = await verifyRecord(at.did, chain, proof, at.collection, at.rkey);
      if (!rec.ok) {
        step(stepCard("fail", "The record failed", explain(rec)));
        return;
      }
      step(stepCard("ok", "Commit and path verified", `The signing key signed a commit to this tree, and hashes link that tree to these exact bytes. Took ${Math.round(performance.now() - t)} ms.`, `tree root: ${rec.root}`));

      const text = await fieldStr(proof.record, ["text"]);
      put(stepCard("ok", "A contract could now trust this record", text ? `Its signed text: “${text.slice(0, 280)}”` : `Type ${rec.type}.`, `${rec.type} · commit time ${new Date(rec.rev / 1000).toISOString()} (signed by the account itself)`));
      offerTamper({ did: at.did, collection: at.collection, rkey: at.rkey, ops, chain, proof });
    } catch (e) {
      step(stepCard("fail", "That didn't work", (e as Error).message));
    } finally {
      go.disabled = sample.disabled = false;
    }
  }

  function offerTamper(l: Loaded): void {
    const out = h("div", { class: "steps" });
    const attempt = async (name: string, change: () => Promise<{ ok: boolean; why: string }>) => {
      const r = await change();
      out.appendChild(stepCard(r.ok ? "fail" : "ok", name, r.ok ? "It still passed. That would be a bug: please report it." : `Rejected, as it should be. ${r.why}`));
    };
    const flip = (b: Uint8Array) => {
      const c = b.slice();
      c[Math.floor(c.length / 2)]! ^= 1;
      return c;
    };
    const result = (r: { ok: true } | Failure) => ({ ok: r.ok, why: r.ok ? "" : explain(r) });
    replace(tamper,
      h("h2", { class: "big", style: "margin-top:38px" }, "Now try to fool it"),
      h("p", { class: "muted", style: "margin-top:8px" }, "These change the data in your browser and rerun the same checks."),
      h("div", { class: "row", style: "margin-top:14px" },
        h("button", { class: "btn ghost small", type: "button", onclick: () => attempt("Changed one bit of the record", async () => result(await verifyRecord(l.did, l.chain, { ...l.proof, record: flip(l.proof.record) }, l.collection, l.rkey))) }, "Change one bit of the record"),
        h("button", { class: "btn ghost small", type: "button", onclick: () => attempt("Changed one bit of the signed commit", async () => result(await verifyRecord(l.did, l.chain, { ...l.proof, commit: flip(l.proof.commit) }, l.collection, l.rkey))) }, "Change one bit of the commit"),
        h("button", { class: "btn ghost small", type: "button", onclick: () => attempt("Claimed the record belongs to another account", async () => result(await verifyRecord("did:plc:z72i7hdynmk6r22z27h6tvur" === l.did ? "did:plc:ewvi7nxzyoun6zhxrhs64oiz" : "did:plc:z72i7hdynmk6r22z27h6tvur", l.chain, l.proof, l.collection, l.rkey))) }, "Claim it's another account's"),
        h("button", { class: "btn ghost small", type: "button", onclick: () => attempt("Removed the last identity operation", async () => { if (l.ops.length < 2) { const r = await verifyChain("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", l.ops); return result(r); } const shorter = await verifyChain(l.did, l.ops.slice(0, -1)); if (!shorter.ok) return result(shorter); return { ok: false, why: "That shorter chain is valid on its own, which is why contracts keep a floor of the longest chain seen: once a rotation has been observed, shorter chains are refused." }; }) }, "Hide a key rotation"),
      ),
      out,
    );
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (input.value.trim()) void run(input.value.trim());
    else input.focus();
  });
  sample.addEventListener("click", async () => {
    sample.disabled = true;
    try {
      const p = await latestPost("bsky.app");
      if (!p) throw new Error("Couldn't load a sample post.");
      input.value = p.uri;
      await run(p.uri);
    } catch (e) {
      replace(steps, stepCard("fail", "That didn't work", (e as Error).message));
    } finally {
      sample.disabled = false;
    }
  });

  return {
    title: "Live proof",
    body: h("div", { class: "wrap narrow" },
      pageHead("Live proof", "Verify a Bluesky post, right here", "This page runs the same Rust verifier the Ootle contracts link, compiled to WebAssembly. It fetches public data from sources it doesn't trust and checks every signature itself. No account or wallet needed."),
      form,
      steps,
      tamper,
      h("div", { class: "note", style: "margin-top:34px" }, h("strong", null, "One limit the proof can't remove. "), "A contract can't prove an identity log is complete, because a later key rotation could have been left out. That's why contracts keep a floor of the longest chain anyone has shown them, and why higher-value payouts use a challenge window. ", h("a", { href: "/docs/security" }, "Trust boundaries")),
      h("div", { class: "spacer" }),
    ),
  };
}
