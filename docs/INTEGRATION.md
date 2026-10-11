# Integration guide

How to build on Skydrop: link to it, reuse its TypeScript, call the contract directly, read its state, or run your own instance. For how it works inside, see [ARCHITECTURE.md](ARCHITECTURE.md).

Everything here targets the Ootle Esmeralda testnet. The current deployment values are in `web/src/config.ts`.

## Pick a level

| You want to | Use | Effort |
|---|---|---|
| Let your users send or collect tTARI for a Bluesky handle | [Deep links](#1-deep-links) | Minutes |
| Embed the flow in your own web app | [The TypeScript modules](#2-typescript-modules) | An afternoon |
| Call the contract from your own wallet, CLI or another template | [Contract reference](#3-contract-reference) | Varies |
| Index deposits, show balances, build dashboards | [Reading state](#4-reading-state) | Minutes |
| Add tip posts to your own bot | [Relayers](#7-running-a-relayer-or-bot) | An hour |
| Run a separate deployment | [Your own instance](#8-your-own-instance) | An hour |

## 1. Deep links

The app is a static site with hash routes. A handle can be given with or without `@`.

| Link | What it does |
|---|---|
| `https://skydrop.tari.mw/#/send/alice.bsky.social` | Send form with the recipient filled in |
| `https://skydrop.tari.mw/#/claim/alice.bsky.social` | Collect page. Shows what is waiting and walks the owner through claiming |
| `https://skydrop.tari.mw/#/tips/alice.bsky.social` | Fund a tip budget for that account |

Put the claim link in anything you send to a recipient. It works with no wallet installed: the page makes a wallet in the browser. Visitors who have the Sapient extension can choose it from the wallet menu.

## 2. TypeScript modules

There is no published package yet. Copy these files from `web/src/` into your project:

| File | Gives you |
|---|---|
| `config.ts` | Component and template addresses, bot handle, public API URLs |
| `cbor.ts` | `lit()` for hex-CBOR instruction arguments, `toHex`, `fromHex` |
| `bsky.ts` | Handle lookup, claim code, post search, `buildClaimProof` |
| `chain.ts` | Reads (`readEscrow`, `readBudget`) and transactions (`sendTip`, `startClaim`, `finalizeClaim`, `openBudget`, `closeBudget`, sponsored variants) |
| `wallet.ts` | The `Wallet` interface, built-in and Sapient implementations |

You also need the patched `@tari-project/ootle` and `@tari-project/ootle-wasm` from `web/vendor/`, plus `@chironbuilder/ootle-sdk` and `@tari-project/ootle-indexer`. The stock 0.42 packages produce "Invalid transaction signature". See `web/package.json` for the exact overrides.

### Send

```ts
import * as chain from "./chain";
import * as bsky from "./bsky";
import { builtinWallet } from "./wallet";

chain.initStorage();
const account = chain.openAccount(chain.savedSeed() ?? chain.createSeed());
const wallet = await builtinWallet(account, () => chain.tariBalance(account));
const provider = await account.getProvider();

const profile = await bsky.lookupProfile("@alice.bsky.social"); // throws for did:web or unknown handles
const { epoch } = await chain.readEscrow(provider, profile.did);
await chain.sendTip(wallet, { did: profile.did, amount: 1_000_000n, window: 0 }, epoch, console.log);
```

Amounts are in µT: 1,000,000 = 1 tTARI. `window` is the challenge window in epochs (about one hour each, 0 to `maxWindow`).

### Claim

```ts
const code = await bsky.claimCode(CONFIG.component, did, wallet.publicKey);
// Ask the user to post text containing `code`, then:
const post = await bsky.findClaimPost(did, code);        // null until the post is public
const proof = await bsky.buildClaimProof(did, post!.rkey);
await chain.startClaim(wallet, proof);                   // or startClaimSponsored(wallet, proof)
await chain.finalizeClaim(wallet, did, undefined, true); // after each deposit's window has passed
```

`finalizeClaim`'s last argument says the caller already knows the payout is due. The pre-flight check runs one epoch behind the real execution, so without it a window-0 payout can look "too early" for a moment. Use it only when your own epoch check says the payout is due.

`startClaimSponsored` and `finalizeClaimSponsored` pay the network fee from the contract's fee vault, so the claimant needs no funds. They require a wallet that exposes its signing key (`wallet.account !== null`, the built-in wallet). With Sapient, use the normal calls.

### The `Wallet` interface

```ts
interface Wallet {
  kind: "builtin" | "sapient";
  publicKey: Uint8Array;        // binds claim codes and deposits
  componentAddress: string;     // the account that holds tokens
  walletAddress: string;        // bech32m address others pay to
  balance(): Promise<bigint>;
  execute(instructions: unknown[], opts: { maxFee: bigint; dryRun?: boolean }): Promise<unknown>;
  account: OotleAccount | null; // set when fee-phase transactions are possible
}
```

To support another wallet, implement this. `execute` receives raw Ootle instructions. The Sapient implementation in `wallet.ts` is the reference: it uses `tari_createTransactionRequest`, polls `tari_getTransactionRequest` for approval, then `tari_submitTransactionRequest`. A dry run goes through `tari_signAndSubmitTransaction` with `dryRun: true`. The claimant key is the owner key decoded from the bech32m address with `parseOotleAddress`.

## 3. Contract reference

Component methods. "Signer" is a key that must have signed the transaction.

| Method | Arguments | Signer | Returns |
|---|---|---|---|
| `deposit` | `did`, `sender`, `refund_epoch`, `window_epochs`, `challenge: String` (optional phrase the claim post must contain, max 80 bytes, `""` for none), `funds: Bucket` | `sender` | none |
| `start_claim` | `did`, `claimant`, `ops`, `commit`, `mst_nodes`, `record`, `rkey` | `claimant` | none |
| `start_claim_sponsored` | as above plus `fee: Amount` | `claimant` | none. Call in the fee phase |
| `finalize_claim` | `did` | the pending claimant | `Bucket` |
| `sponsor_finalize` | `did`, `fee` | the pending claimant | none. Call in the fee phase, before `finalize_claim` |
| `challenge` | `did`, `ops` | none | none. Cancels a pending claim with a different valid chain |
| `refund` | `did`, `index: u32` | the deposit's sender | `Bucket`. After `refund_epoch` |
| `fund` | `bucket` (TARI) | none | none. Tops up the fee vault |
| `open_budget` | `did`, `owner`, `window_epochs`, `refund_after`, `max_tip`, `funds` | `owner` | none |
| `close_budget` | `did`, `owner`, `amount` | `owner` | `Bucket` |
| `tip` | `did`, `owner`, `ops`, `commit`, `mst_nodes`, `record`, `rkey` | none | none. The signed post is the authority |
| `tip_sponsored` | as `tip` plus `fee` | none | none. Fee phase. Fee is charged to the budget |

Read-only: `expected_post_text(did, claimant)`, `deposits_for(did)`, `pending_for(did)`, `budget_for(did, owner)`, `fee_balance()`, `total_escrowed()`.

Types: `did` is a `did:plc:` string of 32 characters. Keys are 32-byte Ristretto public keys. `ops`, `commit`, `mst_nodes` and `record` are raw DAG-CBOR blocks (`Vec<Bytes>` / `Bytes`). `rkey` is the record key of the post.

Limits: at most 16 PLC operations, 32 MST nodes, 16 KiB per block, 32 deposits per DID, 3 sponsored starts and 3 sponsored payouts per DID, 100,000 µT per sponsored call.

### Calling from another template

The component is an ordinary Ootle component with `allow_all` access rules, so another template can call `deposit` with a bucket it holds. Escrow is by DID, so the depositing template must supply a `sender` key that can later sign `refund`. A template that wants to forward a claim payout should call `finalize_claim` with the claimant's signature in scope, then deposit the returned bucket.

### Claim code

```
code = "tari-claim:" + hex( sha256( "tari-bsky-claim:v1:" ‖ component_address ‖ ":" ‖ did ‖ ":" ‖ claimant_key_32_bytes )[0..16] )
```

`component_address` is the full string (`component_fa64…`), `did` is the UTF-8 DID, and the key is the raw 32 bytes. The post text only has to contain the code anywhere. `expected_post_text` on the component returns the same value, which is a quick way to test your implementation.

### Tip post format

A tip is a normal Bluesky post with real mention facets:

```
@taridrop.bsky.social tip @friend.bsky.social 0.5 tTARI
```

- The text starts with `@`. The first mention is the bot, at byte offset 0.
- Then ` tip `, then a mention of the recipient at the next byte offset, then a space and the amount.
- The amount is a positive decimal with at most 12 whole digits and 6 decimals, no trailing dot, optionally followed by ` tTARI`.
- The recipient must be a `did:plc` and not the bot or the tipper.
- The record key must be a 13-character TID strictly greater than the last tip spent for that DID.

Plain-text `@handle` without a facet is ignored. The parser is `atp-verify/src/tip.rs` and its tests are in `atp-verify/tests/tip.rs`.

### Envelopes and share links

An envelope is cosmetic and never touches the contract. The sender picks a colour or a cover picture and an optional note (80 characters), and they travel in the link:

```
https://skydrop.tari.mw/e/<handle>?e=red&m=<note>&c=<cover id>&a=2%20tTARI
```

| Param | Meaning |
|---|---|
| `e` | colour: `air`, `red`, `gold`, `sakura`, `night`, `mint` |
| `m` | note, URL-encoded, at most 80 characters |
| `c` | cover picture id: 16 hex characters, the start of the SHA-256 of the JPEG |
| `a` | amount text for the preview image only (the real amount is read from the chain) |

`/e/<handle>` returns Open Graph tags and sends people on to `/#/claim/<handle>`, so chat apps show a preview image of the envelope (`/og?...`, a PNG drawn by the Worker). Covers are JPEGs of at most 90 KB: `POST /cover` stores one and returns `{ "id": ... }`, `GET /c/<id>.jpg` serves it. Uploads are limited to 20 per address per hour and are kept for a year.

### Challenge phrases

`deposit` takes an optional `challenge` string (at most 80 bytes). That deposit is only paid out if the claim post also contains the phrase exactly (case sensitive). The contract stores the text of the post the claim was proven with and checks it at payout. A deposit whose phrase was not posted stays escrowed and the claimant can post again; the sender can refund it after the refund epoch. Build the claim post as the phrases (one per line) followed by the claim line, which is what the app suggests.

## 4. Reading state

Anything that can call the indexer can read the escrow. The component state is a CBOR array (indexes in [ARCHITECTURE.md](ARCHITECTURE.md#data-model)).

```ts
import { IndexerProvider } from "@tari-project/ootle-indexer";
import { Network, defaultIndexerUrl } from "@tari-project/ootle";

const provider = await IndexerProvider.connect({ url: defaultIndexerUrl(Network.Esmeralda), network: Network.Esmeralda });
const escrow = await chain.readEscrow(provider, "did:plc:…");   // deposits, pending claim, epoch
const sponsor = await chain.readSponsorBalance(provider);       // fee vault, in µT
const budgets = await chain.readBudgetsFor(provider, "did:plc:…");
```

To list everything waiting, read state index 3 (`deposits`) once and sum per DID. Poll about every 20 seconds. Epochs advance roughly hourly on Esmeralda.

## 5. Building a proof without the web app

`bsky.buildClaimProof(did, rkey)` is the reference. Server-side, the same logic lives in `src/atproto.ts`. Steps:

1. `GET https://plc.directory/<did>/log` returns the identity operations. Convert them to DAG-CBOR with signatures, oldest first, as `ops`.
2. `GET <pds>/xrpc/com.atproto.sync.getRecord?did=…&collection=app.bsky.feed.post&rkey=…` returns a CAR with the signed commit, the MST nodes on the path and the record. Split it into `commit`, `mst_nodes` and `record`.
3. Pass them as shown in the contract table.

`<pds>` comes from the last PLC operation's `atproto_pds` service endpoint. Fetch the PLC log fresh for every claim: the contract rejects a chain shorter than the longest one it has seen.

## 6. Errors

The contract fails with plain messages. The app maps them in `chain.friendly`.

| Message | Meaning |
|---|---|
| `nothing deposited for this account` | No deposit for that DID, so nothing to claim |
| `the post does not contain the claim code` | Wrong code, wrong component, or the wrong claimant key |
| `invalid repo proof` / `invalid operation chain` | A block was altered or the wrong post or log was supplied |
| `stale operation chain: a longer one has been seen` | Fetch the PLC log again |
| `the challenge window is still open` | A deposit's window has not elapsed since the claim started |
| `this account has used its sponsored claims` / `…payouts` | Sponsored cap reached. Pay the fee yourself |
| `sponsored fee out of range` | `fee` must be positive and at most 100,000 µT |
| `this post, or a later one, was already spent` | Tip replay or out-of-order tip |
| `tip above this budget's per-tip limit` / `budget too small for this tip` | Budget rules |
| `not refundable yet` | Wait until `refund_epoch` |

## 7. Running a relayer or bot

Anyone can relay tips: the contract trusts the post's signature, not the relayer. The reference bot (`bot/index.ts`) does this:

1. Lists notifications for the bot account and picks mentions.
2. Checks the record's facets for the tip shape and finds a budget for the posting DID with enough balance and a high enough `max_tip`.
3. Builds the proof with `buildClaimProof` and submits `tip_sponsored` through `relayTipSponsored`.
4. Replies with a link to `#/claim/<recipient>`.

A relayer needs a small signing key (any seed, no funds required, since the fee vault and the tipper's budget pay) and a Bluesky app password. Run it in dry-run first.

```
cd bot
cp .env.example .env     # BSKY_HANDLE, BSKY_APP_PASSWORD, CLAIM_URL, OOTLE_SEED
npx tsx index.ts         # dry run: prints what it would post
BOT_LIVE=1 npx tsx index.ts
```

`bot/skydrop-bot.service` is a hardened systemd unit. Keep `.env` out of version control and rotate the app password if it is ever pasted somewhere.

If you run your own relayer for the same component, note that each tip post can be spent only once. Two relayers racing is safe: the loser's transaction fails with "already spent".

## 8. Your own instance

Use this to test changes or run a private escrow.

1. **Build the template.** In a Linux or WSL workspace with tari-ootle checked out, `sync.sh` copies `atp-verify/`, `bskyclaim/` and the tests in. Then `cargo build --target wasm32-unknown-unknown --release --target-dir ~/ootle-target-atp` inside the template directory.
2. **Run the tests.** `./run_tests.sh` (28 tests with a synthetic Bluesky account). Pass `--target-dir` to cargo, never the `CARGO_TARGET_DIR` environment variable: the template's child build deadlocks on the parent's lock.
3. **Publish and create.**
   ```
   bsky_cli publish <bskyclaim.wasm>
   bsky_cli new <template> [min_deposit_µT] [max_window_epochs] [bot_did]
   bsky_cli fundfees <component> <amount_µT>
   ```
   Publishing costs a few tTARI on Esmeralda.
4. **Point the app at it.** Edit `component`, `template`, `botHandle` and `botDid` in `web/src/config.ts`.
5. **Deploy.** `cd web && npm run build && npx wrangler deploy` (set the route in `wrangler.jsonc`).
6. **Start the bot** as above and set `CLAIM_URL` to your site.

Other CLI commands: `addr`, `balance`, `deposit`, `code`, `claim`, `challenge`, `finalize`, `pending`. The header comment of `cli/bsky_cli.rs` lists every command and its arguments.

### Tests and scripts

| What | How |
|---|---|
| Contract and verifier | `./run_tests.sh` (engine), `cargo test` in `atp-verify/` |
| Live claim from Node | `web/scripts/e2e.ts`, `e2e-sponsored.ts`, `e2e-tips.ts` (need a funded `E2E_SEED`) |
| Live claim with the bot's account | `bot/e2e_claim.ts` (posts a code, claims, collects, deletes the post) |

## 9. Security notes for integrators

- Never take a handle from a user and trust it. Resolve it to a DID with `lookupProfile` and show the DID next to it. The contract only knows DIDs.
- Do not store seeds server-side. The browser wallet keeps its 16-byte seed in `localStorage`. Ask users to export it.
- Treat claim windows as a feature. For anything above tip money, offer a window, and tell users why.
- A tip budget's spending authority is the Bluesky account itself. Show `max_tip` prominently and keep it low.
- Testnet only. The contract has not been audited.

## Linking a wallet (instant payouts)

`bind(did, address, ops, commit, mst_nodes, record, rkey)` links a did:plc to an Ootle account. The proof is a post in the DID's repo containing `tari-bind:<hex>` = sha256("tari-bsky-bind:v1:" ‖ component ‖ ":" ‖ did ‖ ":" ‖ address)[..16]; anyone may relay it. Reads: `binding_for(did)`, `expected_bind_text(did, address)`; state index 12 holds `did -> (address, effective epoch, replaced address)`, 13 the last bind rkey.

- A deposit or tip with window 0 and no challenge phrase for a bound DID is paid straight to the address (no escrow, no refund).
- Anything else escrows as before, and `finalize_claim` pays the bound address (the caller gets an empty bucket).
- A first binding applies at once. A replacement applies after one epoch, the old address keeps receiving until then, and a bind post can only be used once (rkeys must increase), so an old post cannot move the binding back.

For a linked account the claim post needs no `tari-claim:` code, only the sender's challenge phrase: the payout goes to the linked address whoever submits it, so a copied post can only pay the owner. A pending claim of a linked account can only be restarted by a newer post (larger rkey), and anyone may call `finalize_claim` for it. Unlinked accounts still need the code (it ties the post to the claimant's wallet). The intended order is: link a wallet once, then do challenges with just the phrase.

**Order of steps for a challenge.** A deposit with a challenge phrase only pays an account that has linked a wallet (`bind`), and only for a claim post made after the link post. The link post itself (anything containing `tari-bind:`, or any post not newer than the last link post) is stored with an empty claim text, so linking and the challenge can never share a post. Unlinked accounts can still collect their other deposits with the claim code; challenge deposits wait until they link.

**Direct payments are recorded.** When a deposit or tip is paid straight to a linked wallet, the contract keeps the latest 8 per DID in state index 15 (`received_for(did)`: sender, amount, refund epoch, window, epoch paid). The bot reads it and posts "You received N tTARI … already in your linked wallet. Nothing to claim." instead of the claim mention.
