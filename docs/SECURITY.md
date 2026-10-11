# Security review

Reviewed 2026-10-11: the escrow contract (`bskyclaim`), the verifier (`atp-verify`), the Cloudflare Worker, the bot
(and its server setup) and the web app. Findings are listed with what was done about them. Testnet only so far.

## Fixed in this review

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 1 | High | **Linking a wallet took effect at once.** The proof cannot show that an account's operation log is complete, so someone holding an old, rotated-away key could link the account to their own address and receive every later gift. Claims had a challenge window for exactly this; linking did not. | A link now takes effect after 2 epochs. In that time anyone can cancel it with a longer or different operation chain (`challenge_bind`). The bot watches pending links and cancels them itself. Stale chains are refused once a longer one has been seen. |
| 2 | High | **"Post must stay up" was not enforced.** The check re-proved the same post, but an old signed repo snapshot still shows a post after it is deleted, so a claimant could save the first proof and replay it. | The proof must now come from a repo snapshot taken after the hold time (the signed commit `rev` time), later than the one before it. Snapshots can only move forward. |
| 3 | Medium | **Sponsor vault could be drained for free.** Anyone could create accounts, deposit the minimum and draw sponsored fees on them. | Sponsored fees are recorded against the account and taken back out of its payout or refund. An account's escrow has to cover everything it has drawn. |
| 4 | Medium | **A shorter chain could cancel a claim.** `challenge` accepted any valid chain with a different tip, including an old prefix. | The challenging chain must be at least as long as the one relied on. |
| 5 | Medium | **Bot could be pointed at internal addresses (SSRF).** The data host used to fetch a post comes from the account's own identity record, so any account owner could choose it, including `127.0.0.1` where other services listen. Responses were also unbounded. | Only public `https` hosts are contacted (no addresses, no internal names, no odd ports, no redirects), with a 1 MB limit and 15 s timeout. The systemd unit also denies the bot all loopback and private ranges except the local DNS stub, so a DNS trick cannot reach them. |
| 6 | Medium | **The bot repeated sender-chosen text as live mentions and links.** A challenge phrase like `@someone buy http://…` was echoed by the bot's account and made clickable. | Sender text is quoted but never turned into mentions or links. |
| 7 | Low | **Envelope registry records could be pre-registered by anyone**, including the amount text shown on the preview. | The bot and the sender's own list always show the real on-chain amount. The registry now has a per-address rate limit. (See open items for the rest.) |
| 9 | Medium | **Spam could fill an account's 32 deposit slots**, and unanswered phrase deposits could not be cleared by the owner. | At most 4 gifts per sender and 8 phrase gifts per account; the owner of a linked wallet can decline a gift (it goes back to its sender); phrase gifts nobody acts on for about 3 days can be swept back by anyone. |
| 8 | Low | **`/og` image rendering could be driven with unlimited unique queries** (CPU, font downloads), and the cache key included junk parameters. | The cache key is built from the cleaned values only; new pictures are rate limited per address. |

## Open items (known, not fixed)

- **Envelope notes can be pre-registered by anyone** (first write wins) for a predictable deposit. The text is cleaned
  and capped at 80 characters, but it can be offensive or misleading. Plan: commit a hash of the envelope in the
  deposit so the registry can be checked against the chain.
- **Uploaded cover pictures are not moderated** and are served from this domain for 90 days (20 uploads per address per hour).
- **Stolen-key attacks rely on someone noticing in time.** The bot's watchtower now cancels suspicious links and
  claims, but if the bot is down nobody else is watching. Anyone can run the same check (`challenge`, `challenge_bind`).
- **A malicious linked account can make payments to it fail** (its `deposit` can panic). That only affects the account
  that chose the link, but a relayed tip to it will fail until it is changed.
- **The tip budget is spendable by whoever controls the account's current key**, including a stale one. `max_tip` limits it.
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
