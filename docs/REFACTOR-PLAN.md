# Refactor plan: monolith → generic escrow + policies

Goal: features can be added, changed, and shipped **without ever redeploying the component
that holds funds**, so no deposit is ever orphaned again (today's `ARCHITECTURE.md` §Deployment:
*"Superseded components still hold their old deposits"*).

## The governing constraint

On Ootle a template is immutable WASM and a component is bound to its template for life — there is
no in-place upgrade. Therefore the only way to change code without moving funds is to make the
**fund-holding component's code never need to change.** Everything that changes must live in other
components that the vault delegates to.

## Target shape

```
               atp-verify (crate, compile-time, shared)
                     ▲            ▲            ▲
                     │            │            │
   ┌───────────┐  ┌──┴────────┐ ┌─┴────────┐ ┌┴───────────┐
   │ Escrow    │  │ClaimPolicy│ │TipPolicy │ │LinkRegistry│
   │ (vault)   │◄─┤           │ │          │ │            │
   │ PERMANENT │  └───────────┘ └──────────┘ └────────────┘
   └───────────┘   policies: redeployable, one per feature
```

- **Escrow** — permanent. Holds funds keyed by `account_id` (the DID, kept as opaque bytes so it is
  not Bluesky-specific). Each deposit is pinned to the **policy component** allowed to release it.
  Interface frozen forever:
  - `deposit(account_id, sender, refund_epoch, policy, metadata, funds)`
  - `release(account_id, selector, to)` — only callable by the pinned policy (checked via
    `CallerContext` caller address).
  - `refund(account_id, index)` — unconditional after `refund_epoch`, independent of any policy.
    The safety valve: a buggy/malicious policy can never permanently strand funds.
  - fee sub-vault: `fund`, `fee_balance`, `pay_fee_sponsored(account_id, fee)` (+ `owed` ledger,
    netted out of every `release`/`refund` via `reimburse`). Lives here because reimburse is
    intrinsic to payout; the *policy* of when/how much to sponsor stays in each policy.
  - governance: `allow_policy(template_addr)` / `revoke_policy(template_addr)`. Escrow obeys any
    component whose **template** is allowlisted, so a new policy instance of an approved template
    needs no escrow change.
- **atp-verify** — stays a shared crate (not a component). Every policy depends on a pinned version;
  you bump it only when verification genuinely changes, and only *new* policies pick it up. This is
  what ends "I have to change the verifier for every feature."
- **Policies** — one template per feature cluster, each calling atp-verify + `escrow.release`.

## Public-surface map (what moves where)

| Today's method | Lands in |
|---|---|
| `deposit`, `refund`, `total_escrowed`, `deposits_for`, `take_returned`, `returned_for` | **Escrow** |
| `fund`, `fee_balance`, `reimburse`/`charge_sponsored`/`owed` | **Escrow** (fee sub-vault) |
| `start_claim(_sponsored)`, `confirm_claim(_sponsored)`, `finalize_claim`, `sponsor_finalize`, `challenge`, `pending_for`, `expected_post_text` | **ClaimPolicy** |
| `open_budget`, `close_budget`, `budget_for`, `tip(_sponsored)` | **TipPolicy** |
| `bind`, `challenge_bind`, `observe_chain`, `binding_for`, `expected_bind_text`, `active_binding*` | **LinkRegistry** |
| `decline(_sponsored)`, `sweep`, `received_for`, `note_received` | split: custody bits in Escrow, link-gated auth via LinkRegistry |
| `known_len`/`check_chain` anti-replay | **IdentityRegistry** (small shared read, see Phase 2) |

## The real coupling to respect

1. **Binding affects three places**: deposit routing (pay straight to bound wallet), finalize
   destination, and decline authorization. LinkRegistry must expose a read `active_binding(did) ->
   Option<(addr, owner_key)>` that Escrow and ClaimPolicy both query.
2. **Sponsored fees** net against payouts. Keep the fee vault + `owed` in Escrow; keep per-DID caps
   (`sponsored` starts/finals/confirms) in the policy that draws them.
3. **Tips produce deposits** governed by ClaimPolicy — TipPolicy calls `escrow.deposit(..., policy =
   ClaimPolicy)`.
4. **`payable()`** fuses window + phrase + hold + bound. It moves whole into ClaimPolicy; phrase/hold
   are deposit `metadata` the policy interprets, so Escrow stays feature-blind.

## Phases (each ends green: `./run_tests.sh [filter]`)

**Phase 0 — Safety net.**
- Run the existing suite, record the baseline (all ~50 fns pass).
- Freeze the client ABI: list every method name + component address the web app (`web/src/config.ts`),
  `cli/bsky_cli.rs`, and `bot/` depend on. Nothing in later phases may break these without a
  matching client change in the same phase.
- Add tests for the invariants the split most endangers: fee `owed` netting on both refund and
  payout, and bound-routing of a zero-window/no-phrase deposit.

**Phase 1 — Internal seam (still one component, no ABI change).**
- Inside the monolith, route every fund move through an internal `escrow` module exposing exactly
  the future Escrow interface (`deposit/release/refund/pay_fee_sponsored`). Features call it instead
  of touching `self.vault`/`self.owed` directly.
- Proves the boundary is clean (escrow needs zero feature knowledge) with no cross-component risk.
- Tests unchanged, stay green.

**Phase 2 — IdentityRegistry seam.**
- Pull `known_len` + `check_chain`/`observe_chain` behind an internal `identity` module interface
  (`require_fresh(did, chain)`, `observe(did, chain)`). Still in-process. Tests green.

**Phase 3 — First real split: Escrow + ClaimPolicy as separate templates.** *(highest risk)*
- New `escrow/` template with the frozen interface + allowlist + per-deposit policy pin + fee vault.
- New `claim-policy/` template: pending/claim_text/held/challenge/finalize/sponsored, depends on
  atp-verify, calls `escrow.release`.
- Wire `release` authorization via **access-rule badges** (NOT `CallerContext`, which has no
  immediate-caller primitive): `release` takes a `Proof` of Escrow's `policy_badge` NFT, confirms the
  proof's resource + that its NFT id == the deposit's pinned policy. See the auth section below.
- Update `bskyclaim.rs`: deploy both templates, allowlist ClaimPolicy, thread addresses through the
  `User` helper. Assertions unchanged.
- Dedicate sub-steps to: refund safety valve (works even if ClaimPolicy is revoked), and the
  `expected_post_text` claim-code domain now binding the **ClaimPolicy** address (migration note:
  codes change, so live pending claims must finalize before cutover or re-post).

**Phase 4 — TipPolicy template.**
- Move budgets/tip; `tip` calls `escrow.deposit(recipient, ..., policy = ClaimPolicy)`.
- `tip_sponsored` draws the fee via `escrow.pay_fee_sponsored`. Tests green.

**Phase 5 — LinkRegistry template.**
- Move bindings/bind_proof/last_bind. Expose `active_binding` read.
- Escrow consults it for zero-window/no-phrase routing; ClaimPolicy for finalize destination +
  `decline` authorization. Tests green.

**Phase 6 — Sponsorship/fees finalize.**
- Confirm the fee vault + `owed` live in Escrow; caps stay per-policy. Remove any residual duplicate
  accounting. Tests green.

**Phase 7 — Governance + migration.**
- Deploy Escrow **once**. Register ClaimPolicy/TipPolicy/LinkRegistry templates via `allow_policy`.
- Old monolith component: funds cannot be moved programmatically; they stay refundable from the old
  component. App reads both — old = refund-only, new = active. **This is the last time a redeploy
  strands anything**; future features only add policies.

**Phase 8 — Clients.**
- `web/src/config.ts` lists Escrow + policy addresses; reads come from Escrow (single source for all
  of a DID's deposits — also fixes the "app only reads current component" discovery bug).
- Update `web/`, `cli/`, `bot/` method targets in lockstep with Phase 3/4/5 cutovers.

## How Escrow authenticates a policy (confirmed against template_lib)

`CallerContext` exposes only the transaction signer and *self*'s address — there is **no
immediate-caller-component primitive**. Authentication uses the Radix/Ootle access-rule layer
(`template_lib_types::access_rules`):
- The engine auto-mints a **caller-component badge**; `RuleRequirement::CallerComponent(addr)` and
  `RuleRequirement::DirectCallerTemplate(template)` gate a method on who/what called it.
- For a **governable allowlist**, Escrow mints a `policy_badge` NFT (id = the policy's component
  address), governance mints one into each approved policy, and `release` takes a `Proof` of it,
  checks the resource + that the NFT id == the deposit's pinned policy. New policy = mint it a badge;
  **no escrow redeploy, unbounded policies.**
- `refund` requires no badge — signer-gated on the original sender, so it works even if a policy is
  revoked or buggy (the safety valve).

## Reframe: a reusable Bluesky identity layer for Ootle

The headline deliverable is the **Verifier / BskyIdentity layer**: a shared immutable primitive any
Ootle contract builds on to prove, in-WASM with no oracle, that a Bluesky account controls a key or
published a record saying X. Escrow + claim/tip/link policies are the *first consumer*, not the
center. The Verifier exposes the full verification menu so a third party writes a new policy without
re-implementing atproto crypto.

### Verification menu (atp-verify today → "all types" target)

Have: `did:plc` chain → repo signing key; repo commit signature (secp256k1 + P-256); MST path to a
record; `record_text`; `commit_rev_micros`; tip-post parse. Candidate additions for "all types":
`did:web` resolution; handle↔DID verification; generic record/collection proofs (likes/follows/
reposts/custom lexicons, field = value, not just `app.bsky.feed.post` claim codes); PDS service-auth
JWT; account-status/takedown; ed25519 keys. **Scope to be confirmed before build.**

## Security track (runs alongside every phase)

Treat each phase as an audit target, per the junior/senior review methodology. Focus areas:
atp-verify (DAG-CBOR canonicalization, MST path forgery, PLC chain-completeness/replay, sig-alg
confusion, P-256/secp256k1 malleability), the badge auth (badge forgery/confusion, missing proof
checks, cross-policy release), escrow accounting (owed/reimburse netting, refund vs release
double-spend, resource confusion), rkey monotonicity/replay (tip/bind/claim), and compute-budget DoS
on long chains/MST. Findings logged in `docs/SECURITY.md` with PoC where it builds in WSL.

## Residual risk (state plainly in SECURITY.md)

Escrow trusts badge-holding policies. A buggy/malicious policy can over-release the funds it governs
(never another policy's, never past `refund`). Governance must vet a policy before minting it a badge
— same class of trade-off as "the challenge window is not a proof of log completeness."

## Order rationale

Phases 1–2 establish the seams with zero cross-component risk, so Phase 3 (the first real split, the
dangerous one) lands against an already-clean boundary. Features are carved in dependency order
(claim → tip → link) so each new template only depends on ones already extracted.
