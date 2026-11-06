//   SPDX-License-Identifier: BSD-3-Clause

//! ClaimPolicy: the first feature policy in the generic architecture. It governs deposits escrowed under
//! its own address and implements the claim semantics; the permanent Escrow only moves funds when this
//! policy presents its badge. Verification is via the `atp-verify` crate (compile-time, the cheap hot
//! path).
//!
//! Claim flow:
//!  * A sender escrows a deposit in the Escrow, pinned to this policy, with the challenge window encoded
//!    in the opaque `metadata` (8-byte big-endian epoch count; empty / short means 0 = pay immediately).
//!  * `start_claim` proves the account's repo contains a post carrying this policy's claim code for the
//!    claimant, and records a pending claim at the current epoch.
//!  * During the window anyone may `challenge` with a longer/different identity chain (a key the claimant
//!    rotated away), cancelling the claim. This closes the gap that a PLC log cannot be proven complete.
//!  * `finalize_claim` releases every deposit of this policy whose window has elapsed since the claim
//!    started, merging them into one bucket for the claimant.
//!
//! **Each DID's claim data lives in its own record NFT, not in this component.** A substate is capped at 1 MiB and
//! identities are free to make, so shared maps could be filled by self-made accounts with minimum deposits, blocking new
//! claims for everyone. `open_account` creates a DID's record (anyone may call it, and the caller pays); reading a record
//! that doesn't exist fails the transaction, so a client adds `open_account` to a new DID's first claim. Post text is also
//! capped at the 3,000 bytes Bluesky's own post lexicon allows: an account signs its own records, so nothing else limits it.

use atp_verify::sha256;
use tari_template_lib::{prelude::*, types::crypto::RistrettoPublicKeyBytes};

const CODE_DOMAIN: &[u8] = b"tari-bsky-claim:v1:";
const COLLECTION: &str = "app.bsky.feed.post";
const MAX_OPS: usize = 16;
const MAX_NODES: usize = 32;
const MAX_BLOCK_LEN: usize = 16 * 1024;

/// Escrow's deposit tuple, mirrored so `deposits_for` decodes: (sender, amount, refund epoch, policy,
/// metadata, epoch it was made — recorded by escrow, so it can be trusted).
type EscDep = (RistrettoPublicKeyBytes, Amount, u64, ComponentAddress, Bytes, u64);

fn require_signer(key: RistrettoPublicKeyBytes) {
    CallerContext::assert_badge_in_scope(&NonFungibleAddress::from_public_key(key));
}

// A ClaimPolicy deposit's metadata is
//   window (8-byte BE u64) ++ hold (8-byte BE u64) ++ envelope flag (1 byte: 0 none, 1 present)
//   ++ envelope (32 bytes, only when flagged) ++ phrase (UTF-8 tail)
// All optional (a shorter metadata reads as zero / none). `phrase`: the claim post must contain it to pay.
// `hold`: the post must be re-proven still up this many epochs after the claim started (`confirm_claim`).
// `envelope`: a hash the sender commits to (an off-chain message or gift); the policy only carries it.
//
// The depositor writes metadata and escrow never checks it, so a policy cannot assume it is in range: a
// deposit whose metadata is malformed or out of range is *invalid* — it never pays, and anyone may send
// it back to its sender with `sweep`. That keeps one bad deposit from blocking an account's real ones.

/// One epoch as real time (an hour) — a hold counts the time between repo snapshots, not just epochs, so
/// an old snapshot of a since-deleted post cannot satisfy it.
const EPOCH_MICROS: u64 = 3_600_000_000;
/// Sponsored calls of each kind a single account may draw before it must pay its own fee.
const MAX_SPONSORED: u32 = 3;
/// Longest challenge window, hold and phrase a valid deposit may carry.
const MAX_WINDOW: u64 = 10;
const MAX_HOLD: u64 = 168;
const MAX_PHRASE: usize = 80;
/// Epochs after which a phrase gift nobody has answered may be swept back to its sender.
const SWEEP_AFTER: u64 = 72;
/// Direct deliveries remembered per account, newest last (for senders' history).
const MAX_DELIVERED: usize = 32;
/// Longest post text a claim accepts: `maxLength` of `text` in the app.bsky.feed.post lexicon, so real posts all fit.
const MAX_POST_TEXT: usize = 3_000;
const MAX_DID: usize = 256;
/// The most ids a record vault may hold before it's replaced. Each id takes about 40 bytes of a 1 MiB substate.
const MAX_RECORD_VAULT_SIZE: u32 = 20_000;

/// (claimant, epoch the claim started, chain tip hash, chain length).
type Pending = (RistrettoPublicKeyBytes, u64, Bytes, u32);
/// (claim post rkey, epoch last proven up, repo-snapshot micros at claim start, latest proven micros).
type Held = (String, u64, u64, u64);
/// One DID's data.
#[derive(Clone, Default)]
struct ClaimRecord {
    pending: Option<Pending>,
    /// Longest valid chain seen; a later claim must present a chain at least this long.
    known_len: u32,
    /// Text of the post the pending claim was proven with, checked against deposit phrases at payout.
    claim_text: Option<String>,
    held: Option<Held>,
    /// Sponsored starts, finalises, confirms and declines drawn, each bounded per account.
    sponsored: (u32, u32, u32, u32),
    /// Deliveries `pay_linked` made straight to the linked wallet: (sender, amount, epoch).
    delivered: Vec<(RistrettoPublicKeyBytes, Amount, u64)>,
}

/// How a record is stored: the same fields as `ClaimRecord`, in order.
type StoredRecord = (Option<Pending>, u32, Option<String>, Option<Held>, (u32, u32, u32, u32), Vec<(RistrettoPublicKeyBytes, Amount, u64)>);

impl ClaimRecord {
    fn stored(&self) -> StoredRecord {
        (self.pending.clone(), self.known_len, self.claim_text.clone(), self.held.clone(), self.sponsored, self.delivered.clone())
    }

    fn from_stored(s: StoredRecord) -> Self {
        Self { pending: s.0, known_len: s.1, claim_text: s.2, held: s.3, sponsored: s.4, delivered: s.5 }
    }
}

fn record_id(did: &str) -> NonFungibleId {
    NonFungibleId::from_u256(sha256(did.as_bytes()))
}

fn u64_at(b: &[u8], off: usize) -> u64 {
    if b.len() >= off + 8 {
        let mut a = [0u8; 8];
        a.copy_from_slice(&b[off..off + 8]);
        u64::from_be_bytes(a)
    } else {
        0
    }
}

/// The challenge window (epochs) a sender encoded in a deposit's metadata.
fn window_of(metadata: &Bytes) -> u64 {
    u64_at(metadata.as_slice(), 0)
}

/// The hold time (epochs) the post must stay up after the claim started.
fn hold_of(metadata: &Bytes) -> u64 {
    u64_at(metadata.as_slice(), 8)
}

/// Where the phrase starts, or `None` when the envelope flag is malformed.
fn phrase_start(b: &[u8]) -> Option<usize> {
    match b.get(16) {
        None => Some(b.len()),
        Some(0) => Some(17),
        Some(1) if b.len() >= 17 + 32 => Some(17 + 32),
        Some(_) => None,
    }
}

/// The optional challenge phrase (the metadata tail), empty if none.
fn phrase_of(metadata: &Bytes) -> String {
    let b = metadata.as_slice();
    phrase_start(b).and_then(|s| String::from_utf8(b[s.min(b.len())..].to_vec()).ok()).unwrap_or_default()
}

/// Whether a deposit's metadata is well-formed and in range. An invalid deposit never pays.
fn metadata_valid(metadata: &Bytes) -> bool {
    let b = metadata.as_slice();
    let Some(start) = phrase_start(b) else { return false };
    let phrase_fits = std::str::from_utf8(&b[start.min(b.len())..]).is_ok_and(|p| p.len() <= MAX_PHRASE);
    window_of(metadata) <= MAX_WINDOW && hold_of(metadata) <= MAX_HOLD && phrase_fits
}

/// Whether a deposit's phrase requirement is met by the claim post `text`.
fn phrase_ok(text: &str, metadata: &Bytes) -> bool {
    let p = phrase_of(metadata);
    p.is_empty() || text.contains(&p)
}

/// Whether deposit `d` of this policy pays now to a claim that started at `start`, given the claim post
/// `text`, the epoch it was last proven up (`seen`), and the repo-snapshot time between proofs (`gap`).
fn payable(d: &EscDep, me: &ComponentAddress, now: u64, start: u64, text: &str, seen: u64, gap: u64) -> bool {
    let hold = hold_of(&d.4);
    d.3 == *me
        && metadata_valid(&d.4)
        && now >= start.saturating_add(window_of(&d.4))
        && phrase_ok(text, &d.4)
        && seen >= start.saturating_add(hold)
        && gap >= hold.saturating_mul(EPOCH_MICROS)
}

fn claim_code(component: &str, did: &str, claimant: &RistrettoPublicKeyBytes) -> String {
    let mut data = CODE_DOMAIN.to_vec();
    data.extend_from_slice(component.as_bytes());
    data.push(b':');
    data.extend_from_slice(did.as_bytes());
    data.push(b':');
    data.extend_from_slice(&claimant.into_array());
    let digest = sha256(&data);
    let mut s = String::from("tari-claim:");
    for b in &digest[..16] {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn slices(items: &[Bytes], max: usize) -> Vec<&[u8]> {
    assert!(items.len() <= max, "too many blocks");
    assert!(items.iter().all(|b| b.len() <= MAX_BLOCK_LEN), "block too large");
    items.iter().map(|b| b.as_slice()).collect()
}

#[template]
mod claim_policy {
    use super::*;

    pub struct ClaimPolicy {
        escrow: ComponentAddress,
        badge_vault: Vault,
        /// The LinkRegistry this policy consults: where a bound account's payout goes, and the longest
        /// operation chain seen for each account (its `chain_pin`). Fixed at construction — a setter would
        /// leave a window in which anyone could point the policy at a registry of their own.
        link_registry: ComponentAddress,
        /// One NFT per DID.
        records: ResourceAddress,
        /// Holds the single badge allowed to mint and update records.
        record_badge: Vault,
        /// Holds the records of recent DIDs; replaced when full.
        record_vault: Vault,
        record_vault_count: u32,
        record_vault_size: u32,
        /// Vaults that are full. Nothing reads them: a record is reached by its own address.
        full_vaults: Vec<Vault>,
        accounts: u64,
    }

    impl ClaimPolicy {
        pub fn new(escrow: ComponentAddress, badge_resource: ResourceAddress, link_registry: ComponentAddress, record_vault_size: u32) -> Component<Self> {
            assert!(record_vault_size >= 1 && record_vault_size <= MAX_RECORD_VAULT_SIZE, "record vault size out of range");
            let badge_id = NonFungibleId::from_u32(0);
            let record_badge = ResourceBuilder::non_fungible().with_owner_rule(OwnerRule::None).initial_supply([badge_id.clone()]);
            let badge_address = NonFungibleAddress::new(record_badge.resource_address(), badge_id);
            let records = ResourceBuilder::non_fungible()
                .with_owner_rule(OwnerRule::None)
                .with_token_symbol("SKYCLAIM")
                .mintable(rule!(non_fungible(badge_address.clone())), rule!(deny_all))
                .update_non_fungible_data(rule!(non_fungible(badge_address)), rule!(deny_all))
                .withdrawable(rule!(deny_all), rule!(deny_all))
                .build();
            Component::new(Self {
                escrow,
                badge_vault: Vault::new_empty(badge_resource),
                link_registry,
                records,
                record_badge: Vault::from_bucket(record_badge),
                record_vault: Vault::new_empty(records),
                record_vault_count: 0,
                record_vault_size,
                full_vaults: Vec::new(),
                accounts: 0,
            })
            .with_owner_rule(OwnerRule::None)
            .with_access_rules(AccessRules::allow_all())
            .create()
        }

        /// Creates `did`'s record. Anyone may call it, and the caller pays for the storage. Fails if it already exists.
        pub fn open_account(&mut self, did: String) {
            assert!(!did.is_empty() && did.len() <= MAX_DID, "a DID must be 1-256 bytes");
            if self.record_vault_count >= self.record_vault_size {
                let full = core::mem::replace(&mut self.record_vault, Vault::new_empty(self.records));
                self.full_vaults.push(full);
                self.record_vault_count = 0;
            }
            let manager = ResourceManager::get(self.records);
            let empty = ClaimRecord::default().stored();
            let record = self.record_badge.authorize_with(|| manager.mint_non_fungible(record_id(&did), &did, &empty));
            self.record_vault.deposit(record);
            self.record_vault_count += 1;
            self.accounts += 1;
        }

        pub fn account_count(&self) -> u64 {
            self.accounts
        }

        pub fn record_resource(&self) -> ResourceAddress {
            self.records
        }

        fn read(&self, did: &str) -> ClaimRecord {
            let stored: StoredRecord = ResourceManager::get(self.records).get_non_fungible(&record_id(did)).get_mutable_data();
            ClaimRecord::from_stored(stored)
        }

        fn write(&self, did: &str, record: &ClaimRecord) {
            let manager = ResourceManager::get(self.records);
            let id = record_id(did);
            let stored = record.stored();
            self.record_badge.authorize_with(|| manager.update_non_fungible_data(id, &stored));
        }

        pub fn receive_badge(&mut self, badge: Bucket) {
            self.badge_vault.deposit(badge);
        }

        pub fn expected_post_text(&self, did: String, claimant: RistrettoPublicKeyBytes) -> String {
            claim_code(&CallerContext::current_component_address().to_string(), &did, &claimant)
        }

        pub fn pending_for(&self, did: String) -> Option<(RistrettoPublicKeyBytes, u64)> {
            self.read(&did).pending.map(|(c, s, _, _)| (c, s))
        }

        /// Refuses a chain shorter than the longest this policy or the registry has seen for `did`.
        fn require_fresh_chain(&self, did: &str, chain: &atp_verify::ChainInfo) {
            assert!(chain.len >= self.read(did).known_len, "stale operation chain: a longer one has been seen");
            let (floor, floor_tip): (u32, Bytes) = ComponentManager::get(self.link_registry).call("chain_pin", args![did.to_string()]);
            assert!(chain.extends(floor, floor_tip.as_slice()), "stale operation chain: a longer or different one has been seen");
        }

        /// Starts a claim for a LINKED account: the post needs no claim code, because the payout can only go
        /// to the account's linked wallet (see `finalize_to_linked`), so no claimant binding is required.
        /// Anyone may submit it; a copied old post cannot reset a pending claim (the rkey must be newer).
        pub fn start_linked_claim(&mut self, did: String, ops: Vec<Bytes>, commit: Bytes, mst_nodes: Vec<Bytes>, record: Bytes, rkey: String) {
            let reg = self.link_registry;
            let me = CallerContext::current_component_address();
            let bound: Option<(ComponentAddress, RistrettoPublicKeyBytes)> = ComponentManager::get(reg).call("active_binding", args![did.clone()]);
            let (_, owner) = bound.expect("account is not linked");
            let deps: Vec<EscDep> = ComponentManager::get(self.escrow).call("deposits_for", args![did.clone()]);
            assert!(deps.iter().any(|d| d.3 == me), "no deposits for this account under this policy");
            let mut rec = self.read(&did);
            if let Some(h) = &rec.held {
                assert!(rkey.as_str() > h.0.as_str(), "a newer post than the pending claim's is needed");
            }
            let (chain, text) = self.verify_in_repo(&did, &ops, &commit, &mst_nodes, &record, &rkey);
            let rev = atp_verify::commit_rev_micros(commit.as_slice()).expect("bad commit revision");
            let now = Consensus::current_epoch();
            rec.known_len = chain.len;
            rec.claim_text = Some(text);
            rec.held = Some((rkey, now, rev, rev));
            rec.pending = Some((owner, now, Bytes::from_vec(chain.tip.to_vec()), chain.len));
            self.write(&did, &rec);
        }

        /// Pays a linked account's payable deposits straight into its linked wallet. Anyone may call it (the
        /// destination is fixed by the binding, so there is nothing to steal). Returns how many were paid.
        pub fn finalize_to_linked(&mut self, did: String) -> u32 {
            let mut rec = self.read(&did);
            let start = rec.pending.as_ref().expect("no pending claim").1;
            let reg = self.link_registry;
            let bound: Option<(ComponentAddress, RistrettoPublicKeyBytes)> = ComponentManager::get(reg).call("active_binding", args![did.clone()]);
            let (addr, _) = bound.expect("account is not linked");
            let me = CallerContext::current_component_address();
            let now = Consensus::current_epoch();
            let text = rec.claim_text.clone().unwrap_or_default();
            let (seen, gap) = rec.held.as_ref().map_or((start, 0u64), |h| (h.1, h.3.saturating_sub(h.2)));
            let deps: Vec<EscDep> = ComponentManager::get(self.escrow).call("deposits_for", args![did.clone()]);
            let mut idx: Vec<u32> = deps
                .iter()
                .enumerate()
                .filter(|(_, d)| payable(d, &me, now, start, &text, seen, gap))
                .map(|(i, _)| i as u32)
                .collect();
            assert!(!idx.is_empty(), "nothing payable yet");
            idx.sort_unstable_by(|a, b| b.cmp(a));
            let paid = idx.len() as u32;
            for i in idx {
                let proof = self.badge_vault.create_proof();
                ComponentManager::get(self.escrow).invoke("release_to", args![proof, did.clone(), i, addr]);
                proof.drop();
            }
            let remaining: Vec<EscDep> = ComponentManager::get(self.escrow).call("deposits_for", args![did.clone()]);
            // Invalid deposits never pay, so they don't keep a claim open (and `sweep` returns them).
            if !remaining.iter().any(|d| d.3 == me && metadata_valid(&d.4)) {
                rec.pending = None;
                rec.claim_text = None;
                rec.held = None;
                self.write(&did, &rec);
            }
            paid
        }

        /// Proves the account's repo contains a post carrying this policy's claim code for `claimant` (who
        /// signs), and records a pending claim. Requires at least one deposit governed by this policy.
        pub fn start_claim(
            &mut self,
            did: String,
            claimant: RistrettoPublicKeyBytes,
            ops: Vec<Bytes>,
            commit: Bytes,
            mst_nodes: Vec<Bytes>,
            record: Bytes,
            rkey: String,
        ) {
            require_signer(claimant);
            self.do_start(&did, claimant, &ops, &commit, &mst_nodes, &record, &rkey);
        }

        /// `start_claim` with the network fee paid from the fee vault; call from the fee phase. The fee is
        /// drawn only after the proof verifies, so an invalid claim costs the vault nothing. Capped per DID.
        #[allow(clippy::too_many_arguments)]
        pub fn start_claim_sponsored(&mut self, did: String, claimant: RistrettoPublicKeyBytes, ops: Vec<Bytes>, commit: Bytes, mst_nodes: Vec<Bytes>, record: Bytes, rkey: String, fee: Amount) {
            require_signer(claimant);
            assert!(self.read(&did).sponsored.0 < MAX_SPONSORED, "this account has used its sponsored claims");
            self.do_start(&did, claimant, &ops, &commit, &mst_nodes, &record, &rkey);
            let proof = self.badge_vault.create_proof();
            ComponentManager::get(self.escrow).invoke("pay_fee_sponsored", args![proof, did.clone(), fee]);
            proof.drop();
            let mut rec = self.read(&did);
            rec.sponsored.0 += 1;
            self.write(&did, &rec);
        }

        #[allow(clippy::too_many_arguments)]
        fn do_start(&mut self, did: &str, claimant: RistrettoPublicKeyBytes, ops: &[Bytes], commit: &Bytes, mst_nodes: &[Bytes], record: &Bytes, rkey: &str) {
            let me = CallerContext::current_component_address();
            let deps: Vec<EscDep> = ComponentManager::get(self.escrow).call("deposits_for", args![did.to_string()]);
            assert!(deps.iter().any(|d| d.3 == me), "no deposits for this account under this policy");
            let (chain, text) = self.verify_post(did, &claimant, ops, commit, mst_nodes, record, rkey, &me);
            let rev = atp_verify::commit_rev_micros(commit.as_slice()).expect("bad commit revision");
            let now = Consensus::current_epoch();
            let mut rec = self.read(did);
            rec.known_len = chain.len;
            rec.claim_text = Some(text);
            rec.held = Some((rkey.to_string(), now, rev, rev));
            rec.pending = Some((claimant, now, Bytes::from_vec(chain.tip.to_vec()), chain.len));
            self.write(did, &rec);
        }

        /// Cancels a pending claim with a longer or different valid chain (a rotated-away key), while any of
        /// this policy's deposits is still inside its challenge window. Anyone may call.
        pub fn challenge(&mut self, did: String, ops: Vec<Bytes>) {
            let mut rec = self.read(&did);
            let (_, start, tip, len) = rec.pending.clone().expect("no pending claim");
            let me = CallerContext::current_component_address();
            let deps: Vec<EscDep> = ComponentManager::get(self.escrow).call("deposits_for", args![did.clone()]);
            let max_window = deps.iter().filter(|d| d.3 == me && metadata_valid(&d.4)).map(|d| window_of(&d.4)).max().unwrap_or(0);
            assert!(Consensus::current_epoch() < start.saturating_add(max_window), "the challenge window has closed");
            let ops_s = slices(&ops, MAX_OPS);
            let chain = atp_verify::verify_plc_chain(&did, &ops_s).expect("invalid operation chain");
            assert!(chain.len >= len, "that chain is shorter than the one the claim relied on");
            assert!(chain.tip.as_slice() != tip.as_slice(), "that is the chain the claim already relies on");
            rec.known_len = rec.known_len.max(chain.len);
            rec.pending = None;
            rec.claim_text = None;
            rec.held = None;
            self.write(&did, &rec);
        }

        /// Re-proves the pending claim's post is still up. Once a deposit's hold has passed since the claim
        /// started, this re-proof is what releases it. The post is the authority, so anyone may submit it.
        pub fn confirm_claim(&mut self, did: String, ops: Vec<Bytes>, commit: Bytes, mst_nodes: Vec<Bytes>, record: Bytes, rkey: String) {
            let mut rec = self.read(&did);
            assert!(rec.pending.is_some(), "no pending claim");
            let (held_rkey, _, start_rev, last_rev) = rec.held.clone().expect("no pending claim");
            assert!(rkey == held_rkey, "that is not the post the claim was made with");
            assert!(!ops.is_empty(), "empty operation chain");
            assert!(commit.len() <= MAX_BLOCK_LEN && record.len() <= MAX_BLOCK_LEN, "block too large");
            let ops_s = slices(&ops, MAX_OPS);
            let nodes = slices(&mst_nodes, MAX_NODES);
            let chain = atp_verify::verify_plc_chain(&did, &ops_s).expect("invalid operation chain");
            self.require_fresh_chain(&did, &chain);
            atp_verify::verify_record(&did, &chain.signing_key, commit.as_slice(), &nodes, record.as_slice(), COLLECTION, &rkey)
                .expect("invalid repo proof");
            let text = atp_verify::record_text(record.as_slice()).expect("record has no text");
            assert!(rec.claim_text.as_deref() == Some(text), "the post has changed since the claim started");
            // A proof is only as fresh as its repo snapshot; require each re-proof to carry a newer one.
            let rev = atp_verify::commit_rev_micros(commit.as_slice()).expect("bad commit revision");
            assert!(rev >= last_rev, "that snapshot of the account is older than one already proven");
            rec.known_len = chain.len;
            rec.held = Some((rkey, Consensus::current_epoch(), start_rev, rev));
            self.write(&did, &rec);
        }

        /// Releases every deposit of this policy whose challenge window has elapsed since the claim started,
        /// merged into one bucket for the claimant (who signs). Deposits still inside their window stay
        /// escrowed and the claim stays pending.
        pub fn finalize_claim(&mut self, did: String) -> Bucket {
            let mut rec = self.read(&did);
            let (claimant, start, _, _) = rec.pending.clone().expect("no pending claim");
            require_signer(claimant);
            let me = CallerContext::current_component_address();
            let now = Consensus::current_epoch();
            let text = rec.claim_text.clone().unwrap_or_default();
            // seen = epoch the post was last proven up; gap = real time between the first and latest snapshots.
            let (seen, gap) = rec.held.as_ref().map_or((start, 0u64), |h| (h.1, h.3.saturating_sub(h.2)));
            let deps: Vec<EscDep> = ComponentManager::get(self.escrow).call("deposits_for", args![did.clone()]);
            // Payable indices, highest first so each release does not shift a still-pending lower index. A
            // deposit pays once its window has elapsed, its phrase (if any) was posted, and its hold (if any)
            // has been satisfied by a re-proof both late enough and far enough apart in repo-snapshot time.
            let mut idx: Vec<u32> = deps
                .iter()
                .enumerate()
                .filter(|(_, d)| payable(d, &me, now, start, &text, seen, gap))
                .map(|(i, _)| i as u32)
                .collect();
            assert!(!idx.is_empty(), "the challenge window is still open, or a required phrase was not posted");
            idx.sort_unstable_by(|a, b| b.cmp(a));
            let mut out: Option<Bucket> = None;
            for i in idx {
                let proof = self.badge_vault.create_proof();
                let b: Bucket = ComponentManager::get(self.escrow).call("release", args![proof, did.clone(), i]);
                proof.drop();
                out = Some(match out {
                    Some(acc) => acc.join(b),
                    None => b,
                });
            }
            // Clear the pending claim once none of this policy's deposits remain for the account.
            let remaining: Vec<EscDep> = ComponentManager::get(self.escrow).call("deposits_for", args![did.clone()]);
            // Invalid deposits never pay, so they don't keep a claim open (and `sweep` returns them).
            if !remaining.iter().any(|d| d.3 == me && metadata_valid(&d.4)) {
                rec.pending = None;
                rec.claim_text = None;
                rec.held = None;
                self.write(&did, &rec);
            }
            out.expect("nothing released")
        }

        /// Pays the fee of a `finalize_claim` made in the same transaction; call from the fee phase. Only
        /// when a claim is pending, signed by its claimant, and at least one deposit is already payable, so
        /// the vault never pays for a finalize that would revert. Capped per DID.
        pub fn sponsor_finalize(&mut self, did: String, fee: Amount) {
            let mut rec = self.read(&did);
            let (claimant, start, _, _) = rec.pending.clone().expect("no pending claim");
            require_signer(claimant);
            let me = CallerContext::current_component_address();
            let now = Consensus::current_epoch();
            let text = rec.claim_text.clone().unwrap_or_default();
            let (seen, gap) = rec.held.as_ref().map_or((start, 0u64), |h| (h.1, h.3.saturating_sub(h.2)));
            let deps: Vec<EscDep> = ComponentManager::get(self.escrow).call("deposits_for", args![did.clone()]);
            assert!(deps.iter().any(|d| payable(d, &me, now, start, &text, seen, gap)), "nothing is payable yet");
            assert!(rec.sponsored.1 < MAX_SPONSORED, "this account has used its sponsored payouts");
            let proof = self.badge_vault.create_proof();
            ComponentManager::get(self.escrow).invoke("pay_fee_sponsored", args![proof, did.clone(), fee]);
            proof.drop();
            rec.sponsored.1 += 1;
            self.write(&did, &rec);
        }

        /// `confirm_claim` with the network fee paid from the fee vault; call from the fee phase. The re-proof
        /// is checked first, so a bad one costs the vault nothing. Capped per DID.
        #[allow(clippy::too_many_arguments)]
        pub fn confirm_claim_sponsored(&mut self, did: String, ops: Vec<Bytes>, commit: Bytes, mst_nodes: Vec<Bytes>, record: Bytes, rkey: String, fee: Amount) {
            assert!(self.read(&did).sponsored.2 < MAX_SPONSORED, "this account has used its sponsored confirmations");
            self.confirm_claim(did.clone(), ops, commit, mst_nodes, record, rkey);
            let proof = self.badge_vault.create_proof();
            ComponentManager::get(self.escrow).invoke("pay_fee_sponsored", args![proof, did.clone(), fee]);
            proof.drop();
            let mut rec = self.read(&did);
            rec.sponsored.2 += 1;
            self.write(&did, &rec);
        }

        /// `decline` with the network fee paid from the fee vault; call from the fee phase. The fee is drawn
        /// while the declined deposit still backs it, then netted out of what goes back to the sender.
        pub fn decline_sponsored(&mut self, did: String, sender: RistrettoPublicKeyBytes, amount: Amount, refund_epoch: u64, fee: Amount) {
            assert!(self.read(&did).sponsored.3 < MAX_SPONSORED, "this account has used its sponsored declines");
            let proof = self.badge_vault.create_proof();
            ComponentManager::get(self.escrow).invoke("pay_fee_sponsored", args![proof, did.clone(), fee]);
            proof.drop();
            self.decline(did.clone(), sender, amount, refund_epoch);
            let mut rec = self.read(&did);
            rec.sponsored.3 += 1;
            self.write(&did, &rec);
        }

        /// Sends back to their senders this policy's deposits for `did` that can no longer pay: invalid ones
        /// (malformed or out-of-range metadata) at any time, and — when no claim is pending, since a pending
        /// one may still answer them — phrase gifts nobody answered within `SWEEP_AFTER` epochs of being
        /// made. Anyone may call; each sender takes theirs back with escrow's `refund`. Returns how
        /// many moved.
        pub fn sweep(&mut self, did: String) -> u32 {
            let claiming = self.read(&did).pending.is_some();
            let me = CallerContext::current_component_address();
            let now = Consensus::current_epoch();
            let deps: Vec<EscDep> = ComponentManager::get(self.escrow).call("deposits_for", args![did.clone()]);
            let mut idx: Vec<u32> = deps
                .iter()
                .enumerate()
                .filter(|(_, d)| {
                    d.3 == me && (!metadata_valid(&d.4) || (!claiming && !phrase_of(&d.4).is_empty() && now >= d.5.saturating_add(SWEEP_AFTER)))
                })
                .map(|(i, _)| i as u32)
                .collect();
            if idx.is_empty() {
                assert!(!claiming, "a claim for this account is in progress");
                panic!("nothing has expired");
            }
            idx.sort_unstable_by(|a, b| b.cmp(a));
            let moved = idx.len() as u32;
            for i in idx {
                let proof = self.badge_vault.create_proof();
                ComponentManager::get(self.escrow).invoke("return_to_sender", args![proof, did.clone(), i]);
                proof.drop();
            }
            moved
        }

        /// Pays `funds` straight into `did`'s linked wallet, with no escrow and no claim: what a gift with no
        /// window, hold or phrase becomes once the account has linked a wallet. `sender` signs, and the
        /// delivery is remembered so the sender's history can show it.
        pub fn pay_linked(&mut self, did: String, sender: RistrettoPublicKeyBytes, funds: Bucket) {
            require_signer(sender);
            let reg = self.link_registry;
            let bound: Option<(ComponentAddress, RistrettoPublicKeyBytes)> = ComponentManager::get(reg).call("active_binding", args![did.clone()]);
            let (addr, _) = bound.expect("account is not linked");
            let amount = funds.amount();
            assert!(amount.is_positive(), "nothing to deliver");
            ComponentManager::get(addr).invoke("deposit", args![funds]);
            let mut rec = self.read(&did);
            if rec.delivered.len() >= MAX_DELIVERED {
                rec.delivered.remove(0);
            }
            rec.delivered.push((sender, amount, Consensus::current_epoch()));
            self.write(&did, &rec);
        }

        pub fn delivered_for(&self, did: String) -> Vec<(RistrettoPublicKeyBytes, Amount, u64)> {
            self.read(&did).delivered
        }

        /// A linked account's owner declines a waiting deposit, returning it to its sender. Only the owner of
        /// the account's linked wallet can sign (so the account must have linked a wallet first). The deposit
        /// is identified by its sender, amount and refund epoch.
        pub fn decline(&mut self, did: String, sender: RistrettoPublicKeyBytes, amount: Amount, refund_epoch: u64) {
            let reg = self.link_registry;
            let bound: Option<(ComponentAddress, RistrettoPublicKeyBytes)> = ComponentManager::get(reg).call("active_binding", args![did.clone()]);
            let (_, owner) = bound.expect("link your wallet first, then you can decline");
            require_signer(owner);
            let me = CallerContext::current_component_address();
            let deps: Vec<EscDep> = ComponentManager::get(self.escrow).call("deposits_for", args![did.clone()]);
            let at = deps
                .iter()
                .position(|d| d.3 == me && d.0 == sender && d.1 == amount && d.2 == refund_epoch)
                .expect("no such deposit");
            let proof = self.badge_vault.create_proof();
            ComponentManager::get(self.escrow).invoke("return_to_sender", args![proof, did, at as u32]);
            proof.drop();
        }

        #[allow(clippy::too_many_arguments)]
        fn verify_post(
            &self,
            did: &str,
            claimant: &RistrettoPublicKeyBytes,
            ops: &[Bytes],
            commit: &Bytes,
            mst_nodes: &[Bytes],
            record: &Bytes,
            rkey: &str,
            me: &ComponentAddress,
        ) -> (atp_verify::ChainInfo, String) {
            let (chain, text) = self.verify_in_repo(did, ops, commit, mst_nodes, record, rkey);
            let code = claim_code(&me.to_string(), did, claimant);
            assert!(text.contains(&code), "the post does not contain the claim code");
            (chain, text)
        }

        /// Verifies a post is in `did`'s repo (chain + commit + MST), with no claim-code requirement. Used
        /// by the coded claim path (then it checks the code) and the linked path (which needs none).
        fn verify_in_repo(&self, did: &str, ops: &[Bytes], commit: &Bytes, mst_nodes: &[Bytes], record: &Bytes, rkey: &str) -> (atp_verify::ChainInfo, String) {
            assert!(!ops.is_empty(), "empty operation chain");
            assert!(commit.len() <= MAX_BLOCK_LEN && record.len() <= MAX_BLOCK_LEN, "block too large");
            let ops_s = slices(ops, MAX_OPS);
            let nodes = slices(mst_nodes, MAX_NODES);
            let chain = atp_verify::verify_plc_chain(did, &ops_s).expect("invalid operation chain");
            self.require_fresh_chain(did, &chain);
            atp_verify::verify_record(did, &chain.signing_key, commit.as_slice(), &nodes, record.as_slice(), COLLECTION, rkey)
                .expect("invalid repo proof");
            let text = atp_verify::record_text(record.as_slice()).expect("record has no text");
            assert!(text.len() <= MAX_POST_TEXT, "that post is longer than Bluesky allows");
            (chain, text.to_string())
        }
    }
}
