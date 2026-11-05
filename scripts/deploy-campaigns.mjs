// Publishes the Campaign stack on Esmeralda: LinkRegistry + Campaign + Verifier templates, then one LinkRegistry.
// Spends real testnet funds, so it only reports what it would do unless you pass "go".
//
//   cd ~/rcv-publish equivalent (a folder with @chironbuilder/ootle-sdk, @tari-project/ootle and a publisher.json)
//   node <repo>/scripts/deploy-campaigns.mjs <folder with the .wasm files>        # report only
//   node <repo>/scripts/deploy-campaigns.mjs <folder with the .wasm files> go     # publish
//
// Paste what it prints into web-atproto/src/data/deployment.ts.
import { createRequire } from "node:module";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Resolve the SDK from the working folder, which holds the wallet and its node_modules.
const req = createRequire(join(process.cwd(), "noop.js"));
const load = async (name) => import(pathToFileURL(req.resolve(name)).href).catch((e) => { throw new Error(`${name}: ${e.message}`); });
const { deriveAccountKeys, fromHex } = await load("@chironbuilder/ootle-sdk");
const { Network, TransactionBuilder, defaultIndexerUrl, getVaultIdsForAccount, resolveMaxEpoch, sendTransaction, decodeExecuteResult, decodeSubstateValue } = await load("@tari-project/ootle");
const { IndexerProvider } = await load("@tari-project/ootle-indexer");
const { SecretKeyWallet } = await load("@tari-project/ootle-secret-key-wallet");

const dir = resolve(process.argv[2] ?? ".");
const go = process.argv[3] === "go";
const TEMPLATES = [["LinkRegistry", "bsky_link_registry"], ["Campaign", "bsky_campaign"], ["Verifier", "bsky_verifier"]];

const { entropy } = JSON.parse(readFileSync("publisher.json", "utf8"));
const { ownerSecret, viewSecret } = deriveAccountKeys(fromHex(entropy), 0);
const network = Network.Esmeralda;
const provider = await IndexerProvider.connect({ url: defaultIndexerUrl(network), network });
const signer = SecretKeyWallet.fromSecretKey(ownerSecret, network, viewSecret);
const { accountAddressFromPublicKey } = await import(pathToFileURL(resolve("../confidential-rcv-web/lib/derive.mjs")).href).catch(() => {
  throw new Error("Needs accountAddressFromPublicKey; run this from ~/rcv-publish, next to confidential-rcv-web.");
});
const account = accountAddressFromPublicKey(await signer.getPublicKey());
const vaults = await getVaultIdsForAccount(provider, account);
console.log("account", account);
for (const id of vaults) {
  const r = await provider.getSubstate(id);
  const v = r?.state?.up?.substate;
  const val = typeof v === "string" ? decodeSubstateValue(v) : v;
  console.log("vault", id, JSON.stringify(val, (_, x) => (typeof x === "bigint" ? x.toString() : x)).slice(0, 200));
}
for (const [name, file] of TEMPLATES) console.log(`${name}: ${file}.wasm, ${(statSync(join(dir, `${file}.wasm`)).size / 1024).toFixed(0)} KB`);
if (!go) {
  console.log('\nNothing was sent. Add "go" to publish. Publishing costs roughly 3 to 4 tTARI per template, from past publishes.');
  process.exit(0);
}

async function submit(build) {
  const maxEpoch = await resolveMaxEpoch(provider);
  const b = build(TransactionBuilder.new(network, maxEpoch)).feeTransactionPayFromComponent(account, 12_000_000n);
  b.addInput({ substate_id: account, version: null });
  for (const v of vaults) b.addInput({ substate_id: v, version: null });
  const res = await sendTransaction(provider, signer, b.buildUnsignedTransaction(), { timeoutMs: 240_000 });
  const fin = res?.result?.Finalized;
  const exec = typeof fin?.execution_result === "string" ? decodeExecuteResult(fin.execution_result) : fin?.execution_result;
  const accept = exec?.finalize?.result?.Accept;
  if (!accept) throw new Error(`Rejected: ${JSON.stringify(exec?.finalize?.result ?? res?.result, (_, x) => (typeof x === "bigint" ? x.toString() : x)).slice(0, 600)}`);
  return (accept.up_substates ?? []).map(([id]) => String(id));
}

const out = {};
for (const [name, file] of TEMPLATES) {
  const wasm = readFileSync(join(dir, `${file}.wasm`));
  const ups = await submit((b) => b.publishTemplate(wasm.toString("base64")));
  out[name] = ups.find((id) => id.startsWith("template_"));
  console.log(name, out[name]);
}
// Arguments are hex CBOR literals: LinkRegistry::new(bind_delay: u64 = 0, record_vault_size: u32 = 20000).
const uintLiteral = (n) => {
  const hex = n < 24 ? n.toString(16).padStart(2, "0") : n < 256 ? `18${n.toString(16).padStart(2, "0")}` : n < 65536 ? `19${n.toString(16).padStart(4, "0")}` : `1a${n.toString(16).padStart(8, "0")}`;
  return { Literal: hex };
};
const ups = await submit((b) => b.callFunction({ templateAddress: out.LinkRegistry, functionName: "new" }, [uintLiteral(0), uintLiteral(20000)]));
const registry = ups.find((id) => id.startsWith("component_") && id !== account);
console.log("\nFor web-atproto/src/data/deployment.ts:");
console.log(`  campaignTemplate: "${out.Campaign}",\n  linkRegistry: "${registry}",\n  verifier: "${out.Verifier}",`);
process.exit(0);
