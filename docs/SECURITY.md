# Security review

Reviewed 2026-10-11: the escrow contract (`bskyclaim`), the verifier (`atp-verify`), the Cloudflare Worker, the bot
(and its server setup) and the web app. Findings are listed with what was done about them. Testnet only so far.

## Fixed in this review

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 1 | Medium | **Linking a wallet could be made with an old, rotated-away key.** The proof cannot show an account's operation log is complete, so someone holding a key that was rotated away could link the account to their own address. | The wait before a link takes effect is a setting chosen when the component is created (`new(…, bind_delay_epochs)`); this deployment uses **0**, so links are instant, because the delay only protects the rare account with a rotated-away key and costs every user. The protection that remains is `observe_chain` (see 12): the bot records an account's current chain within ten minutes of any gift, link or budget appearing, and the contract refuses older chains from then on. Until then a stale-key link is possible. A component can still be created with a delay, in which case anyone (and the bot) can cancel a pending link with `challenge_bind`. |
| 2 | High | **"Post must stay up" was not enforced.** The check re-proved the same post, but an old signed repo snapshot still shows a post after it is deleted, so a claimant could save the first proof and replay it. | The proof must now come from a repo snapshot taken after the hold time (the signed commit `rev` time), later than the one before it. Snapshots can only move forward. |
| 3 | Medium | **Sponsor vault could be drained for free.** Anyone could create accounts, deposit the minimum and draw sponsored fees on them. | Sponsored fees are recorded against the account and taken back out of its payout or refund. An account's escrow has to cover everything it has drawn. |
| 4 | Medium | **A shorter chain could cancel a claim.** `challenge` accepted any valid chain with a different tip, including an old prefix. | The challenging chain must be at least as long as the one relied on. |
| 5 | Medium | **Bot could be pointed at internal addresses (SSRF).** The data host used to fetch a post comes from the account's own identity record, so any account owner could choose it, including `127.0.0.1` where other services listen. Responses were also unbounded. | Only public `https` hosts are contacted (no addresses, no internal names, no odd ports, no redirects), with a 1 MB limit and 15 s timeout. The systemd unit also denies the bot all loopback and private ranges except the local DNS stub, so a DNS trick cannot reach them. |
| 6 | Medium | **The bot repeated sender-chosen text as live mentions and links.** A challenge phrase like `@someone buy http://…` was echoed by the bot's account and made clickable. | Sender text is quoted but never turned into mentions or links. |
| 7 | Low | **Envelope registry records could be pre-registered by anyone**, including the amount text shown on the preview. | The bot and the sender's own list always show the real on-chain amount. The registry now has a per-address rate limit. (See open items for the rest.) |
| 9 | Medium | **Spam could fill an account's 32 deposit slots**, and unanswered phrase deposits could not be cleared by the owner. | At most 4 gifts per sender and 8 phrase gifts per account; the owner of a linked wallet can decline a gift (it goes back to its sender); phrase gifts nobody acts on for about 3 days can be swept back by anyone. |
| 10 | Low | **Envelope notes could be pre-registered for someone else's gift.** | A deposit commits to the SHA-256 of its envelope (style, note, cover). The registry stores a record under the hash of its own content, and the bot and app only show a record that hashes to the on-chain value, so nobody can put different content where a gift's envelope belongs. |
| 11 | Low | **A linked "account" could be any component**, including one written to fail or to take over the call that pays it. | Only a standard Tari account (the built-in account template) can be linked. |
| 12 | Medium | **A stolen, rotated-away key could still spend a tip budget or link a wallet** until someone had shown the contract the rotation. | `observe_chain` lets anyone record an account's longest operation chain; the bot does it for every linked account and every budget owner (at most hourly, only when the chain has grown), after which older-chain proofs are refused. |
| 8 | Low | **`/og` image rendering could be driven with unlimited unique queries** (CPU, font downloads), and the cache key included junk parameters. | The cache key is built from the cleaned values only; new pictures are rate limited per address. |

## Open items (known, not fixed)

- **Uploaded cover pictures are not screened.** An operator can take one down with
  `wrangler kv key put --binding COVERS "ban:<id>" 1` (the id is the 16 characters in `/c/<id>.jpg`); a banned picture stops
  being served and stops appearing on previews. They are served from this domain for 90 days (20 uploads per address per hour).
- **Stolen-key attacks rely on someone noticing in time.** The bot's watchtower now cancels suspicious links and
  claims, but if the bot is down nobody else is watching. Anyone can run the same check (`challenge`, `challenge_bind`).
- Epoch length is assumed to be about an hour when converting a hold time into real time.
- The in-browser wallet seed lives in `localStorage`. Anything that can run script on the page can read it. The page
  builds all text with DOM text nodes and sets no HTML from user data.
- Chinese translations have not been proofread by a native speaker.

## Checked and found sound

- Verification of the account's operation log, repo signature and Merkle path: signatures are checked low-S, every
  block is authenticated by its hash, and the sizes of every input are bounded.
- Claim codes bind the component, account and claimant key; replay of tip and link posts is blocked by increasing record keys.
- Direct payments and payouts update state before calling the linked account (no re-entrancy window).
- Refunds can only be taken by the deposit's own sender after its refund epoch.
- No secrets in the repository or its history; the bot's `.env` is mode 600 and ignored by git.
- Worker: share pages escape every value placed in HTML and in the redirect script; uploads must be JPEG, are served
  as `image/jpeg` with `nosniff`, and are capped at 90 KB.

## Verifier-layer invariants (the reusable bsky→Ootle layer)

As `atp-verify` grows into a general identity layer other contracts build on, these invariants must hold for every
new verification path. They were checked for the existing paths (2026-10-18 audit: no cross-account forgery, panic
or DoS found) and must be re-checked for each addition.

- **Everything trusted is signature- or hash-bound.** The CBOR reader deliberately does *not* enforce DAG-CBOR
  canonical form (minimal integers, sorted/unique keys). This is safe only because every datum the verifier trusts is
  bound either by the account's own signature (PLC ops, repo commit) or by a hash (the DID = `sha256(genesis)`, MST
  nodes keyed by `sha256`, prev-linkage CIDs). A non-canonical encoding therefore only lets an account mangle *its
  own* data, never forge another account's. **Any new path that reads a field without a covering signature or hash
  breaks this and must either add that binding or enforce canonical form.**
- **Handle resolution is one-directional on-chain.** `also_known_as` / `chain_asserts_handle` read the DID→handle
  claim from the signed PLC chain (anchored, trustless). The reverse — that a handle resolves *back* to this DID —
  lives in DNS (`_atproto.<handle>` TXT) or HTTPS (`/.well-known/atproto-did`), which the chain does not anchor and
  WASM cannot fetch. A contract must treat `chain_asserts_handle` as "the DID claims this handle", not "this handle is
  verified", unless it also accepts an off-chain attestation of the reverse mapping.
- **did:web is domain-trust, not hash-anchored.** Unlike `did:plc` (where `did = sha256(genesis)`), a `did:web`
  identifier has no cryptographic link from the DID string to its `did.json`; trust rests on TLS/DNS control of the
  domain, which cannot be verified in WASM. Any did:web support must surface this as a weaker trust tier (e.g. require
  an explicit attestation of the `did.json`), never present it as equivalent to did:plc.
- **Account status / takedown is not anchored.** Whether an account is active, deactivated or taken down is PDS
  hosting state (`com.atproto.sync.getRepoStatus`), not part of the signed repo or PLC chain, so it cannot be proven
  trustlessly in WASM. A contract needing it must accept an off-chain attestation; the Verifier must not expose a
  trustless-looking "account is active" check.
- **Service-auth JWT (`jwt::verify_service_auth`).** Checked sound: the signature is verified over the exact ASCII
  `header.payload` with the account's chain-derived key, so the header `alg` is never trusted (a wrong curve just
  fails — no alg-confusion). The payload JSON reader rejects duplicate keys (no claim shadowing), floats, negatives
  and `\u` escapes. `exp` is returned, not clock-checked — the calling contract must compare it to its own time.

## Campaign contract and Escrow capacity (2026-11-05, Ootle 0.49.2)

- **Fixed: the shared Escrow could be filled.** A substate is capped at 1 MiB and all deposits lived in one component, at about 79 bytes each: roughly 10,000 deposits at most, so anyone could fill it with minimum-size deposits and block new ones for everyone until they refunded. Each account now has its own ledger NFT (id sha256(account_id)) holding its deposits and fees owed. Ledgers sit in a vault that's replaced after `ledger_vault_size` accounts, and returned deposits stay in the ledger, pinned to escrow itself and refundable at once, replacing the shared `returned` map. Measured: 30 new accounts and 60 deposits took the component from 419 to 421 bytes (counters only). The cost: a new account needs `open_account` first, because the engine can't ask whether an NFT exists. The worst griefing left is filling one account's lanes, which was already bounded.
- **Fixed: LinkRegistry had the same shape.** Links and chain floors lived in one component. Anyone could add entries with self-made identities for only the fee, and every Campaign claim reads it, so bloat raised everyone's claim cost and a full registry would stop new rotations being recorded. Each DID now has its own record NFT, created by `open_account`. Reading a record that doesn't exist fails the transaction, so `chain_floor` either returns the real floor or aborts; there's no "no record" path that could skip a floor. Measured: 31 identities took the component from 200 to 202 bytes. A claim for a new DID adds `open_account` to the same transaction.
- **Fixed: ClaimPolicy's shared state.** It kept pending claims in shared maps, including each claim post's whole text (`claim_text`), and an account signs its own records up to the 16 KB block limit. So roughly 70 self-made accounts with minimum deposits might have filled the 1 MiB substate and blocked new claims for everyone. That was never demonstrated against the old code. Each DID now has its own record NFT, created by `open_account`, and post text is capped at 3,000 bytes, the limit in Bluesky's own post lexicon. The regression test makes 25 maximum-length claims and the component doesn't grow. A new DID's first claim adds `open_account`.
- **Test gap closed.** Mutation testing showed 23 of ClaimPolicy's 33 safety rules could be removed with no test noticing, including the claim-code check and finalize's signature check. The rules were correct; nothing proved it. `claim.rs` now covers them one by one.
- **Open: remaining policies' shared state.** TipPolicy, EngagementBounty, ListDrop, ServicePay and SocialRecovery still keep per-account maps in their components. Review before mainnet.
- **Campaign avoids this by design.** Each campaign is its own component and records claims as receipt NFTs, so its state doesn't grow per claimant (5 claims: 358 to 362 bytes).
- **Campaign limits, by design.** The order of steps can't be proven, because accounts sign their own timestamps. Nor can the wording of a reply, or that a record wasn't deleted after the proof; rounds require a newer commit, which someone holding their own repo key could still sign. Open campaigns are farmable since accounts are free; vouch rules and allocation lists are the defence.
- **Mutation check.** `scripts/wsl-mutate-campaign.sh` removes each of 21 safety checks in turn. All 21 were caught by the test suite.
