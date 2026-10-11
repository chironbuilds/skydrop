//   SPDX-License-Identifier: BSD-3-Clause

//! BskyClaim: send funds to a Bluesky account that has no Ootle wallet yet. The account's owner claims
//! them later by proving, with no trusted party, that they control the account.
//!
//! * `deposit` escrows funds under a `did:plc` identifier (not a handle: handles can change hands).
//! * `start_claim` takes a self-contained proof: the DID's PLC operation chain (which yields the repo
//!   signing key), a signed repo commit, and the Merkle-search-tree path to a post that contains a claim
//!   code. The code commits to this component, the DID and the claimant's Ootle key, so the post cannot be
//!   redirected to anyone else.
//! * The proof cannot show that the operation log is complete. A stale chain could come from a former key
//!   holder, so a claim only pays out after a challenge window in which anyone can submit a conflicting
//!   chain (for example the owner's key-rotation operation) to cancel it.
//! * A deposit may carry a challenge phrase. It is only paid out if the claim post also contained that
//!   phrase, so a sender can ask for something specific to be said publicly. Deposits whose phrase was not
//!   posted stay escrowed (the claimant can post again), which keeps a hostile phrase from blocking others.
//! * An owner may `bind` their account to an Ootle account address with one signed post. Deposits and tips
//!   for a bound account that need no challenge window and no phrase are paid straight to that address;
//!   anything else still escrows, and a payout goes to the bound address too. A new binding replaces an old
//!   one only after a delay, and a post can be used once, so an old post cannot move the binding back.
//! * A deposit with a phrase may also ask that the claim post stay up for some epochs. The claimant then
//!   re-proves the same post (`confirm_claim`) once that time has passed, and only then is it paid.
//! * A deposit with a challenge phrase only pays out to a linked account, and only for a post made after the
//!   link post (the link post itself never counts), so linking and the challenge are two separate steps.
//! * For a linked account the claim post needs no claim code: whoever submits it, the money goes to the
//!   linked address. Such a claim can only be restarted by a newer post, so a copied old post cannot reset it.
//! * A linked account's owner can decline a waiting deposit by signing from the linked wallet (an account that has
//!   not linked a wallet has to link first). The money goes into a returned balance its sender takes back. Phrase
//!   deposits nobody answers for a few days can be swept back to their senders by anyone.
//! * `refund` returns an unclaimed deposit to its sender after the refund epoch.

use atp_verify::{commit_rev_micros, record_text, sha256, verify_plc_chain, verify_record};
use tari_template_lib::{
    Consensus,
    caller_context::CallerContext,
    prelude::*,
    types::{constants::TARI_TOKEN, crypto::RistrettoPublicKeyBytes},
};

const CODE_DOMAIN: &[u8] = b"tari-bsky-claim:v1:";
const COLLECTION: &str = "app.bsky.feed.post";
const MAX_OPS: usize = 16;
const MAX_NODES: usize = 32;
const MAX_DEPOSITS_PER_DID: usize = 32;
/// Gifts one sender may have waiting for one account, and how many of an account's slots may wait on a phrase, so
/// a few cheap deposits cannot fill an account up.
const MAX_PER_SENDER: usize = 4;
const MAX_PHRASE_DEPOSITS: usize = 8;
/// A phrase deposit nobody has acted on for this many epochs (about three days) can be swept back to its sender.
const SWEEP_AFTER_EPOCHS: u64 = 72;
/// Longest challenge phrase a sender may attach to a deposit (bytes).
const MAX_CHALLENGE: usize = 80;
/// Longest claim post the contract keeps for checking challenges (bytes). Bluesky allows 3000.
const MAX_CLAIM_TEXT: usize = 4096;
/// Epochs before a binding takes effect. During them anyone can cancel it with a newer operation chain (see
/// `challenge_bind`), because the proof cannot show that the chain it came from is complete.
const BIND_DELAY_EPOCHS: u64 = 2;
/// An epoch as a length of real time (an hour), for holding a post up: the repo snapshots that prove it must be at
/// least this much apart per epoch of hold time.
const EPOCH_MICROS: u64 = 3_600_000_000;
const BIND_DOMAIN: &[u8] = b"tari-bsky-bind:v1:";
/// Longest time (epochs) a sender may ask a claim post to stay up.
const MAX_HOLD_EPOCHS: u64 = 72;
/// Direct payments to linked accounts kept per DID, so the bot can tell the owner what arrived.
const MAX_RECEIVED_KEPT: usize = 8;
const MAX_BLOCK_LEN: usize = 16 * 1024;
/// Ceiling on the fee one sponsored call may offer from the sponsor vault (µT).
const MAX_SPONSORED_FEE: u64 = 100_000;
/// Sponsored claim starts and payouts one account may draw. Beyond that the claimant pays their own fee.
const MAX_SPONSORED_STARTS: u32 = 3;
const MAX_SPONSORED_FINALS: u32 = 3;
const MAX_SPONSORED_CONFIRMS: u32 = 3;

/// The text a claimant must post: `tari-claim:` followed by this code.
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

/// The text an owner must post to bind `did` to the account `address` (whose owner key is `owner`) here.
fn bind_code(component: &str, did: &str, address: &ComponentAddress, owner: &RistrettoPublicKeyBytes) -> String {
    let mut data = BIND_DOMAIN.to_vec();
    data.extend_from_slice(component.as_bytes());
    data.push(b':');
    data.extend_from_slice(did.as_bytes());
    data.push(b':');
    data.extend_from_slice(address.to_string().as_bytes());
    data.push(b':');
    data.extend_from_slice(&owner.into_array());
    let digest = sha256(&data);
    let mut s = String::from("tari-bind:");
    for b in &digest[..16] {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// (sender, amount, refund epoch, challenge window, required phrase, hold epochs, epoch made)
type Dep = (RistrettoPublicKeyBytes, Amount, u64, u64, String, u64, u64);

fn key_hex(key: &RistrettoPublicKeyBytes) -> String {
    let mut s = String::new();
    for b in key.into_array() {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn valid_did(did: &str) -> bool {
    did.len() == 32
        && did.starts_with("did:plc:")
        && did[8..].bytes().all(|c| matches!(c, b'a'..=b'z' | b'2'..=b'7'))
}

fn budget_key(did: &str, owner: &RistrettoPublicKeyBytes) -> String {
    let mut s = String::from(did);
    s.push(':');
    for b in owner.into_array() {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn require_signer(key: RistrettoPublicKeyBytes) {
    CallerContext::get_signer_proof_for_public_key(key).drop();
}

#[template]
mod bskyclaim {
    use std::collections::BTreeMap;

    use super::*;

    pub struct BskyClaim {
        vault: Vault,
        min_deposit: Amount,
        /// Epochs a started claim must wait before it can be finalised.
        /// Longest challenge window a sender may ask for on a deposit.
        max_window_epochs: u64,
        /// DID -> (sender, amount, refund epoch, challenge window in epochs, required phrase). Each sender picks
        /// the window for their own deposit: 0 for a small tip, longer for a large transfer. An empty phrase
        /// means none is required.
        /// The last element is how many epochs the claim post must stay up (0 for none; needs a phrase).
        deposits: BTreeMap<String, Vec<Dep>>,
        /// DID -> (claimant, hash of the chain tip, chain length, epoch the claim started).
        pending: BTreeMap<String, (RistrettoPublicKeyBytes, Bytes, u32, u64)>,
        /// DID -> longest valid operation chain seen. A claim must present a chain at least this long.
        known_len: BTreeMap<String, u32>,
        /// TARI that pays the network fee of claims that verify, so a brand-new claimant needs no funds.
        /// Kept apart from `vault`: deposits are never spent on fees.
        fee_vault: Vault,
        /// DID -> (sponsored claim starts, sponsored finalisations). Bounds what one account can draw.
        sponsored: BTreeMap<String, (u32, u32, u32)>,
        /// "did:owner-key-hex" -> tip budget: (balance, challenge window for tips, refund after epochs, max per tip).
        /// The owner key funds and withdraws it. Whoever controls the DID can spend it, by posting a tip command.
        budgets: BTreeMap<String, (Amount, u64, u64, Amount)>,
        /// DID -> rkey of the last tip post spent. Tip posts must have a larger rkey, so a post tips once.
        last_tip: BTreeMap<String, String>,
        /// The bot account that tip posts mention: `@bot tip @someone 5`.
        bot_did: String,
        /// DID -> text of the post the pending claim was proven with, checked against deposit phrases at payout.
        claim_text: BTreeMap<String, String>,
        /// DID -> (bound account, epoch it takes effect, the account it replaces). A first binding "replaces" this
        /// component's own address, which means nothing is bound until it takes effect.
        /// Each also carries the owner key of the bound wallet and of the one it replaces: that key signs a decline.
        bindings: BTreeMap<String, (ComponentAddress, u64, ComponentAddress, RistrettoPublicKeyBytes, RistrettoPublicKeyBytes)>,
        /// DID -> (tip of the operation chain a binding relied on, its length), so a longer or different chain can cancel it.
        bind_proof: BTreeMap<String, (Bytes, u32)>,
        /// DID -> rkey of the last bind post used. Bind posts must have a larger rkey.
        last_bind: BTreeMap<String, String>,
        /// DID -> (rkey of the claim post, epoch it was last proven to exist, repo snapshot time when the claim
        /// started, repo snapshot time of the latest proof). Times are microseconds from the commit's `rev`.
        held: BTreeMap<String, (String, u64, u64, u64)>,
        /// DID -> the latest payments sent straight to its linked wallet: (sender, amount, refund epoch, window, epoch paid).
        received: BTreeMap<String, Vec<(RistrettoPublicKeyBytes, Amount, u64, u64, u64)>>,
        /// DID -> network fees the sponsor vault paid for its claims. They are taken back out of what the account
        /// is paid (or refunded), so using sponsored fees costs the account's own escrow, never the vault.
        owed: BTreeMap<String, Amount>,
        /// Sender key (hex) -> money returned to them by declined or swept deposits, taken back with `take_returned`.
        returned: BTreeMap<String, Amount>,
    }

    impl BskyClaim {
        pub fn new(
            resource: ResourceAddress,
            min_deposit: Amount,
            max_window_epochs: u64,
            bot_did: String,
        ) -> Component<Self> {
            assert!(min_deposit.is_positive(), "minimum deposit must be positive");
            assert!(valid_did(&bot_did), "bot must be a did:plc identifier");
            Component::new(Self {
                vault: Vault::new_empty(resource),
                min_deposit,
                max_window_epochs,
                deposits: BTreeMap::new(),
                pending: BTreeMap::new(),
                known_len: BTreeMap::new(),
                fee_vault: Vault::new_empty(TARI_TOKEN),
                sponsored: BTreeMap::new(),
                budgets: BTreeMap::new(),
                last_tip: BTreeMap::new(),
                bot_did,
                claim_text: BTreeMap::new(),
                bindings: BTreeMap::new(),
                bind_proof: BTreeMap::new(),
                last_bind: BTreeMap::new(),
                held: BTreeMap::new(),
                received: BTreeMap::new(),
                owed: BTreeMap::new(),
                returned: BTreeMap::new(),
            })
            .with_access_rules(AccessRules::allow_all())
            .create()
        }

        /// Escrows `funds` for the owner of `did`. `sender` (who must sign) can take them back once the
        /// current epoch reaches `refund_epoch`.
        pub fn deposit(
            &mut self,
            did: String,
            sender: RistrettoPublicKeyBytes,
            refund_epoch: u64,
            window_epochs: u64,
            challenge: String,
            hold_epochs: u64,
            funds: Bucket,
        ) {
            assert!(valid_did(&did), "not a did:plc identifier");
            assert!(hold_epochs <= MAX_HOLD_EPOCHS, "hold time above the maximum");
            assert!(hold_epochs == 0 || !challenge.is_empty(), "a hold time needs a challenge phrase");
            assert!(window_epochs <= self.max_window_epochs, "challenge window above the maximum");
            assert!(challenge.len() <= MAX_CHALLENGE, "challenge phrase too long");
            assert!(!challenge.chars().any(|c| c.is_control()), "challenge phrase has control characters");
            require_signer(sender);
            assert_eq!(funds.resource_address(), self.vault.resource_address(), "wrong resource");
            let amount = funds.amount();
            assert!(amount >= self.min_deposit, "deposit below the minimum");
            assert!(refund_epoch > Consensus::current_epoch(), "refund epoch must be in the future");
            if window_epochs == 0 && challenge.is_empty() {
                if let Some(to) = self.active_binding(&did) {
                    self.note_received(&did, sender, amount, refund_epoch, window_epochs);
                    ComponentManager::get(to).invoke("deposit", args![funds]);
                    return;
                }
            }
            let list = self.deposits.entry(did).or_default();
            assert!(list.len() < MAX_DEPOSITS_PER_DID, "too many deposits for this account");
            assert!(list.iter().filter(|e| e.0 == sender).count() < MAX_PER_SENDER, "you already have several gifts waiting for this account");
            if !challenge.is_empty() {
                assert!(list.iter().filter(|e| !e.4.is_empty()).count() < MAX_PHRASE_DEPOSITS, "this account already has several gifts waiting on a phrase");
            }
            list.push((sender, amount, refund_epoch, window_epochs, challenge, hold_epochs, Consensus::current_epoch()));
            self.vault.deposit(funds);
        }

        /// Cancels a binding that has not taken effect yet. Present a valid operation chain for the DID that is at
        /// least as long as the one the binding relied on and differs from it (for example a key rotation the binder
        /// left out). Anyone may call. The previous binding, if there was one, stays.
        pub fn challenge_bind(&mut self, did: String, ops: Vec<Bytes>) {
            let (_, since, old, _, old_owner) = self.bindings.get(&did).cloned().expect("no binding");
            assert!(Consensus::current_epoch() < since, "the binding is already in effect");
            let (tip, len) = self.bind_proof.get(&did).cloned().expect("no binding");
            let chain = self.check_chain(&did, &ops);
            assert!(chain.len >= len, "that chain is shorter than the one the binding relied on");
            assert!(chain.tip.as_slice() != tip.as_slice(), "that is the chain the binding already relies on");
            self.known_len.entry(did.clone()).and_modify(|l| *l = (*l).max(chain.len)).or_insert(chain.len);
            if old == CallerContext::current_component_address() {
                self.bindings.remove(&did);
            } else {
                self.bindings.insert(did.clone(), (old, 0, old, old_owner, old_owner));
            }
            self.bind_proof.remove(&did);
        }

        /// The account `did`'s owner has bound, if one is in effect.
        pub fn binding_for(&self, did: String) -> Option<ComponentAddress> {
            self.active_binding(&did)
        }

        /// The exact text an owner must post to bind `did` to `address`.
        pub fn expected_bind_text(&self, did: String, address: ComponentAddress, owner: RistrettoPublicKeyBytes) -> String {
            bind_code(&CallerContext::current_component_address().to_string(), &did, &address, &owner)
        }

        /// Binds `did` to the Ootle account `address`. The proof is a post in the DID's repo containing the bind
        /// code for `address`; the post's signature is the authority, so anyone may submit it. A first binding
        /// applies at once. A replacement applies after a delay, and the old one keeps working until then.
        pub fn bind(
            &mut self,
            did: String,
            address: ComponentAddress,
            owner: RistrettoPublicKeyBytes,
            ops: Vec<Bytes>,
            commit: Bytes,
            mst_nodes: Vec<Bytes>,
            record: Bytes,
            rkey: String,
        ) {
            assert!(rkey.len() == 13, "posts have 13-character record keys");
            if let Some(last) = self.last_bind.get(&did) {
                assert!(rkey.as_str() > last.as_str(), "this post, or a later one, was already used to bind");
            }
            let chain = self.check_chain(&did, &ops);
            if let Some(&known) = self.known_len.get(&did) {
                assert!(chain.len >= known, "stale operation chain: a longer one has been seen");
            }
            let nodes = slices(&mst_nodes, MAX_NODES);
            assert!(commit.len() <= MAX_BLOCK_LEN && record.len() <= MAX_BLOCK_LEN, "block too large");
            verify_record(&did, &chain.signing_key, commit.as_slice(), &nodes, record.as_slice(), COLLECTION, &rkey)
                .expect("invalid repo proof");
            let text = record_text(record.as_slice()).expect("record has no text");
            let code = bind_code(&CallerContext::current_component_address().to_string(), &did, &address, &owner);
            assert!(text.contains(&code), "the post does not contain the bind code");

            let now = Consensus::current_epoch();
            let nothing = CallerContext::current_component_address();
            let entry = match self.active_binding_full(&did) {
                Some((c, co)) if c == address && co == owner => (address, now, address, owner, owner),
                Some((c, co)) => (address, now + BIND_DELAY_EPOCHS, c, owner, co),
                None => (address, now + BIND_DELAY_EPOCHS, nothing, owner, owner),
            };
            self.known_len.insert(did.clone(), chain.len);
            self.last_bind.insert(did.clone(), rkey);
            self.bind_proof.insert(did.clone(), (Bytes::from_vec(chain.tip.to_vec()), chain.len));
            self.bindings.insert(did, entry);
        }

        /// The exact text a claimant must put in a post for `claimant` to claim `did`'s funds here.
        pub fn expected_post_text(&self, did: String, claimant: RistrettoPublicKeyBytes) -> String {
            claim_code(&CallerContext::current_component_address().to_string(), &did, &claimant)
        }

        /// Starts a claim. The proof must show that `did`'s repo contains a post at `rkey` whose text
        /// contains the claim code for `claimant`, who must sign this transaction.
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
            self.begin_claim(did, claimant, ops, commit, mst_nodes, record, rkey);
        }

        /// `start_claim`, with the network fee paid from the sponsor vault. Call it from the fee phase of a
        /// transaction signed by `claimant`: the fee is only paid once the proof has verified, so an invalid
        /// claim costs the vault nothing. The fee phase has a fixed compute allowance, so very long identity
        /// histories must pay their own fee with `start_claim`.
        pub fn start_claim_sponsored(
            &mut self,
            did: String,
            claimant: RistrettoPublicKeyBytes,
            ops: Vec<Bytes>,
            commit: Bytes,
            mst_nodes: Vec<Bytes>,
            record: Bytes,
            rkey: String,
            fee: Amount,
        ) {
            assert!(fee.is_positive() && fee <= Amount::from(MAX_SPONSORED_FEE), "sponsored fee out of range");
            let used = self.sponsored.get(&did).map_or(0, |s| s.0);
            assert!(used < MAX_SPONSORED_STARTS, "this account has used its sponsored claims");
            self.begin_claim(did.clone(), claimant, ops, commit, mst_nodes, record, rkey);
            self.charge_sponsored(&did, fee);
            self.sponsored.entry(did).or_insert((0, 0, 0)).0 += 1;
            self.fee_vault.pay_fee(fee);
        }

        /// Proves again that the post the pending claim was made with is still up. Once a deposit's hold time has
        /// passed since the claim started, this proof is what releases it. The post is the authority, so anyone
        /// may submit it.
        pub fn confirm_claim(
            &mut self,
            did: String,
            ops: Vec<Bytes>,
            commit: Bytes,
            mst_nodes: Vec<Bytes>,
            record: Bytes,
            rkey: String,
        ) {
            self.begin_confirm(did, ops, commit, mst_nodes, record, rkey);
        }

        /// `confirm_claim`, with the network fee paid from the sponsor vault. Call it from the fee phase.
        pub fn confirm_claim_sponsored(
            &mut self,
            did: String,
            ops: Vec<Bytes>,
            commit: Bytes,
            mst_nodes: Vec<Bytes>,
            record: Bytes,
            rkey: String,
            fee: Amount,
        ) {
            assert!(fee.is_positive() && fee <= Amount::from(MAX_SPONSORED_FEE), "sponsored fee out of range");
            let used = self.sponsored.get(&did).map_or(0, |s| s.2);
            assert!(used < MAX_SPONSORED_CONFIRMS, "this account has used its sponsored confirmations");
            self.begin_confirm(did.clone(), ops, commit, mst_nodes, record, rkey);
            self.charge_sponsored(&did, fee);
            self.sponsored.entry(did).or_insert((0, 0, 0)).2 += 1;
            self.fee_vault.pay_fee(fee);
        }

        fn begin_confirm(&mut self, did: String, ops: Vec<Bytes>, commit: Bytes, mst_nodes: Vec<Bytes>, record: Bytes, rkey: String) {
            assert!(self.pending.contains_key(&did), "no pending claim");
            let (held_rkey, _, start_rev, last_rev) = self.held.get(&did).cloned().expect("no pending claim");
            assert!(rkey == held_rkey, "that is not the post the claim was made with");
            let chain = self.check_chain(&did, &ops);
            if let Some(&known) = self.known_len.get(&did) {
                assert!(chain.len >= known, "stale operation chain: a longer one has been seen");
            }
            let nodes = slices(&mst_nodes, MAX_NODES);
            assert!(commit.len() <= MAX_BLOCK_LEN && record.len() <= MAX_BLOCK_LEN, "block too large");
            verify_record(&did, &chain.signing_key, commit.as_slice(), &nodes, record.as_slice(), COLLECTION, &rkey)
                .expect("invalid repo proof");
            let text = record_text(record.as_slice()).expect("record has no text");
            assert!(self.claim_text.get(&did).is_some_and(|t| t.as_str() == text), "the post has changed since the claim started");
            // A proof is only as fresh as the repo snapshot it carries. An old snapshot still shows the post, even if
            // it has since been deleted, so a hold time counts the time between the snapshots, not just epochs.
            let rev = commit_rev_micros(commit.as_slice()).expect("bad commit revision");
            assert!(rev >= last_rev, "that snapshot of your account is older than one already proven");
            self.known_len.insert(did.clone(), chain.len);
            self.held.insert(did, (rkey, Consensus::current_epoch(), start_rev, rev));
        }

        /// Pays the fee of the claimant's `finalize_claim`, called from the fee phase. Only when a claim is
        /// pending, signed for by its claimant, and at least one deposit is already payable.
        pub fn sponsor_finalize(&mut self, did: String, fee: Amount) {
            assert!(fee.is_positive() && fee <= Amount::from(MAX_SPONSORED_FEE), "sponsored fee out of range");
            let (claimant, _, _, start) = self.pending.get(&did).cloned().expect("no pending claim");
            if self.active_binding(&did).is_none() {
                require_signer(claimant);
            }
            let now = Consensus::current_epoch();
            let text = self.claim_text.get(&did).map(|t| t.as_str()).unwrap_or("");
            let (seen, gap) = self.held.get(&did).map_or((start, 0), |h| (h.1, h.3.saturating_sub(h.2)));
            assert!(
                self.deposits.get(&did).is_some_and(|d| d.iter().any(|e| payable(e, now, start, text, seen, gap, self.active_binding(&did).is_some()))),
                "nothing is payable yet"
            );
            let used = self.sponsored.get(&did).map_or(0, |s| s.1);
            assert!(used < MAX_SPONSORED_FINALS, "this account has used its sponsored payouts");
            self.charge_sponsored(&did, fee);
            self.sponsored.entry(did).or_insert((0, 0, 0)).1 += 1;
            self.fee_vault.pay_fee(fee);
        }

        /// Adds TARI to the sponsor vault. Anyone may contribute.
        pub fn fund(&mut self, bucket: Bucket) {
            assert_eq!(bucket.resource_address(), TARI_TOKEN, "fee funding must be TARI");
            self.fee_vault.deposit(bucket);
        }

        pub fn fee_balance(&self) -> Amount {
            self.fee_vault.balance()
        }

        /// Opens or tops up a tip budget for `did`, owned by `owner` (who must sign and is the only one who can
        /// withdraw). Tips drawn from it become deposits for the recipient with `window_epochs` of challenge
        /// window, refundable to `owner` after `refund_after` epochs, and at most `max_tip` each.
        pub fn open_budget(
            &mut self,
            did: String,
            owner: RistrettoPublicKeyBytes,
            window_epochs: u64,
            refund_after: u64,
            max_tip: Amount,
            funds: Bucket,
        ) {
            assert!(valid_did(&did), "not a did:plc identifier");
            require_signer(owner);
            assert_eq!(funds.resource_address(), self.vault.resource_address(), "wrong resource");
            assert!(window_epochs <= self.max_window_epochs, "challenge window above the maximum");
            assert!(refund_after > 0, "refund period must be positive");
            assert!(max_tip >= self.min_deposit, "max tip below the minimum deposit");
            let amount = funds.amount();
            assert!(amount >= self.min_deposit, "budget below the minimum deposit");
            let entry = self.budgets.entry(budget_key(&did, &owner)).or_insert((Amount::zero(), 0, 0, Amount::zero()));
            entry.0 += amount;
            entry.1 = window_epochs;
            entry.2 = refund_after;
            entry.3 = max_tip;
            self.vault.deposit(funds);
        }

        /// Takes `amount` back out of the budget. Only its owner.
        pub fn close_budget(&mut self, did: String, owner: RistrettoPublicKeyBytes, amount: Amount) -> Bucket {
            require_signer(owner);
            assert!(amount.is_positive(), "amount must be positive");
            let key = budget_key(&did, &owner);
            let entry = self.budgets.get_mut(&key).expect("no such budget");
            assert!(entry.0 >= amount, "budget too small");
            entry.0 -= amount;
            if entry.0.is_zero() {
                self.budgets.remove(&key);
            }
            self.vault.withdraw(amount)
        }

        /// (balance, window, refund after, max per tip)
        pub fn budget_for(&self, did: String, owner: RistrettoPublicKeyBytes) -> Option<(Amount, u64, u64, Amount)> {
            self.budgets.get(&budget_key(&did, &owner)).copied()
        }

        /// Spends from the budget of (`did`, `owner`) on the tip described by a post in `did`'s repo, shaped
        /// `@bot tip @recipient 5`. Anyone may submit it: the post's signature is the authority, so a relayer
        /// can neither forge nor alter a tip. Each post can be spent once.
        pub fn tip(
            &mut self,
            did: String,
            owner: RistrettoPublicKeyBytes,
            ops: Vec<Bytes>,
            commit: Bytes,
            mst_nodes: Vec<Bytes>,
            record: Bytes,
            rkey: String,
        ) {
            self.begin_tip(did, owner, ops, commit, mst_nodes, record, rkey, Amount::zero());
        }

        /// `tip`, with the network fee paid from the sponsor vault and charged to the tipper's budget, so the
        /// relayer needs no funds. Call it from the fee phase.
        pub fn tip_sponsored(
            &mut self,
            did: String,
            owner: RistrettoPublicKeyBytes,
            ops: Vec<Bytes>,
            commit: Bytes,
            mst_nodes: Vec<Bytes>,
            record: Bytes,
            rkey: String,
            fee: Amount,
        ) {
            assert!(fee.is_positive() && fee <= Amount::from(MAX_SPONSORED_FEE), "sponsored fee out of range");
            self.begin_tip(did, owner, ops, commit, mst_nodes, record, rkey, fee);
            self.fee_vault.deposit(self.vault.withdraw(fee));
            self.fee_vault.pay_fee(fee);
        }

        fn begin_tip(
            &mut self,
            did: String,
            owner: RistrettoPublicKeyBytes,
            ops: Vec<Bytes>,
            commit: Bytes,
            mst_nodes: Vec<Bytes>,
            record: Bytes,
            rkey: String,
            fee: Amount,
        ) {
            let key = budget_key(&did, &owner);
            let (balance, window, refund_after, max_tip) = *self.budgets.get(&key).expect("no such budget");
            assert!(rkey.len() == 13, "tip posts have 13-character record keys");
            if let Some(last) = self.last_tip.get(&did) {
                assert!(rkey.as_str() > last.as_str(), "this post, or a later one, was already spent");
            }
            let chain = self.check_chain(&did, &ops);
            if let Some(&known) = self.known_len.get(&did) {
                assert!(chain.len >= known, "stale operation chain: a longer one has been seen");
            }
            let nodes = slices(&mst_nodes, MAX_NODES);
            assert!(commit.len() <= MAX_BLOCK_LEN && record.len() <= MAX_BLOCK_LEN, "block too large");
            verify_record(&did, &chain.signing_key, commit.as_slice(), &nodes, record.as_slice(), COLLECTION, &rkey)
                .expect("invalid repo proof");
            let (recipient, micro) = atp_verify::tip::parse_tip(record.as_slice(), &self.bot_did).expect("not a tip post");
            let amount = Amount::from(micro);
            assert!(recipient != did, "cannot tip yourself");
            assert!(amount >= self.min_deposit, "tip below the minimum deposit");
            assert!(amount <= max_tip, "tip above this budget's per-tip limit");
            assert!(balance >= amount + fee, "budget too small for this tip");

            let left = balance - amount - fee;
            if left.is_zero() {
                self.budgets.remove(&key);
            } else {
                self.budgets.get_mut(&key).unwrap().0 = left;
            }
            self.known_len.insert(did.clone(), chain.len);
            self.last_tip.insert(did, rkey);
            if window == 0 {
                if let Some(to) = self.active_binding(&recipient) {
                    self.note_received(&recipient, owner, amount, Consensus::current_epoch() + refund_after, window);
                    let paid = self.vault.withdraw(amount);
                    ComponentManager::get(to).invoke("deposit", args![paid]);
                    return;
                }
            }
            let list = self.deposits.entry(recipient).or_default();
            assert!(list.len() < MAX_DEPOSITS_PER_DID, "too many deposits for the recipient");
            list.push((owner, amount, Consensus::current_epoch() + refund_after, window, String::new(), 0, Consensus::current_epoch()));
        }

        fn begin_claim(
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
            assert!(self.deposits.get(&did).is_some_and(|d| !d.is_empty()), "nothing deposited for this account");
            assert!(rkey.len() <= 32, "rkey too long");
            let chain = self.check_chain(&did, &ops);
            if let Some(&known) = self.known_len.get(&did) {
                assert!(chain.len >= known, "stale operation chain: a longer one has been seen");
            }
            let nodes = slices(&mst_nodes, MAX_NODES);
            assert!(commit.len() <= MAX_BLOCK_LEN && record.len() <= MAX_BLOCK_LEN, "block too large");
            verify_record(&did, &chain.signing_key, commit.as_slice(), &nodes, record.as_slice(), COLLECTION, &rkey)
                .expect("invalid repo proof");
            let text = record_text(record.as_slice()).expect("record has no text");
            let code = claim_code(&CallerContext::current_component_address().to_string(), &did, &claimant);
            if !text.contains(&code) {
                // Without the code the post is not tied to this claimant. That is only safe when the money cannot go
                // to the claimant: a linked account's payouts go to its linked address. And a copied old post must
                // not be able to restart a pending claim, so it has to be newer than the one already proven.
                assert!(self.active_binding(&did).is_some(), "the post does not contain the claim code");
                if self.pending.contains_key(&did) {
                    let last = self.held.get(&did).map(|h| h.0.clone()).unwrap_or_default();
                    assert!(rkey.as_str() > last.as_str(), "a newer post than the pending claim's is needed");
                }
            }

            assert!(text.len() <= MAX_CLAIM_TEXT, "claim post too long");
            self.known_len.insert(did.clone(), chain.len);
            // The link post (or anything older) can never be the challenge post: linking and the challenge are separate.
            let is_link_post = text.contains("tari-bind:") || self.last_bind.get(&did).is_some_and(|lb| rkey.as_str() <= lb.as_str());
            let stored = if is_link_post { String::new() } else { text.to_string() };
            self.claim_text.insert(did.clone(), stored);
            let rev = commit_rev_micros(commit.as_slice()).expect("bad commit revision");
            self.held.insert(did.clone(), (rkey, Consensus::current_epoch(), rev, rev));
            self.pending.insert(did, (claimant, Bytes::from_vec(chain.tip.to_vec()), chain.len, Consensus::current_epoch()));
        }

        /// Cancels a pending claim by presenting a valid operation chain for the DID that differs from the
        /// one the claim relied on: a later key rotation, or the canonical branch of a fork. Anyone may call.
        /// It works while any deposit's challenge window, counted from the claim's start, is still open.
        pub fn challenge(&mut self, did: String, ops: Vec<Bytes>) {
            let (_, tip, claim_len, start) = self.pending.get(&did).expect("no pending claim");
            let longest = self.deposits.get(&did).map_or(0, |d| d.iter().map(|e| e.3).max().unwrap_or(0));
            assert!(Consensus::current_epoch() < *start + longest, "the challenge window has closed");
            let chain = self.check_chain(&did, &ops);
            assert!(chain.len >= *claim_len, "that chain is shorter than the one the claim relied on");
            assert!(chain.tip.as_slice() != tip.as_slice(), "that is the chain the claim already relies on");
            self.known_len.entry(did.clone()).and_modify(|l| *l = (*l).max(chain.len)).or_insert(chain.len);
            self.pending.remove(&did);
            self.claim_text.remove(&did);
            self.held.remove(&did);
        }

        /// Pays out every deposit whose challenge window has passed since the claim started. Deposits with a
        /// longer window stay escrowed and the claim stays pending. Only the claimant can call it.
        pub fn finalize_claim(&mut self, did: String) -> Bucket {
            let (claimant, _, _, start) = self.pending.get(&did).cloned().expect("no pending claim");
            let bound = self.active_binding(&did);
            // a linked account is paid to its linked address whoever asks, so anyone may finish its claim
            if bound.is_none() {
                require_signer(claimant);
            }
            let now = Consensus::current_epoch();
            let list = self.deposits.remove(&did).unwrap_or_default();
            let text = self.claim_text.get(&did).cloned().unwrap_or_default();
            let (seen, gap) = self.held.get(&did).map_or((start, 0), |h| (h.1, h.3.saturating_sub(h.2)));
            let (ready, waiting): (Vec<_>, Vec<_>) = list.into_iter().partition(|e| payable(e, now, start, &text, seen, gap, bound.is_some()));
            assert!(!ready.is_empty(), "the challenge window is still open, or a required phrase was not posted");
            let total = ready.iter().fold(Amount::zero(), |acc, e| acc + e.1);
            let took = self.reimburse(&did, total);
            if waiting.is_empty() {
                self.pending.remove(&did);
                self.claim_text.remove(&did);
                self.held.remove(&did);
            } else {
                self.deposits.insert(did, waiting);
            }
            let paid = self.vault.withdraw(total - took);
            match bound {
                Some(to) => {
                    ComponentManager::get(to).invoke("deposit", args![paid]);
                    self.vault.withdraw(Amount::zero())
                }
                None => paid,
            }
        }

        /// Returns the deposit at `index` to its sender once its refund epoch has passed.
        pub fn refund(&mut self, did: String, index: u32) -> Bucket {
            let list = self.deposits.get_mut(&did).expect("no deposits for this account");
            let (sender, amount, refund_epoch, _, _, _, _) = list.get(index as usize).cloned().expect("no such deposit");
            require_signer(sender);
            assert!(Consensus::current_epoch() >= refund_epoch, "not refundable yet");
            list.remove(index as usize);
            if list.is_empty() {
                self.deposits.remove(&did);
            }
            let took = self.reimburse(&did, amount);
            self.vault.withdraw(amount - took)
        }

        pub fn deposits_for(&self, did: String) -> Vec<Dep> {
            self.deposits.get(&did).cloned().unwrap_or_default()
        }

        /// (claimant, chain length, epoch the claim started)
        pub fn pending_for(&self, did: String) -> Option<(RistrettoPublicKeyBytes, u32, u64)> {
            self.pending.get(&did).map(|(c, _, l, s)| (*c, *l, *s))
        }

        pub fn total_escrowed(&self) -> Amount {
            self.vault.balance()
        }

        /// Records a sponsored fee against `did`. The account's escrow has to be able to cover everything it has
        /// drawn, so draining the sponsor vault costs more than the attacker's own deposit.
        fn charge_sponsored(&mut self, did: &str, fee: Amount) {
            let total = self.deposits.get(did).map_or(Amount::zero(), |l| l.iter().fold(Amount::zero(), |a, e| a + e.1));
            let owed = self.owed.get(did).copied().unwrap_or(Amount::zero());
            assert!(total >= owed + fee, "this account's escrow is too small to cover more sponsored fees");
            self.owed.insert(did.to_string(), owed + fee);
        }

        /// Moves what `did` owes the sponsor vault out of `available` into it, and returns how much was moved.
        fn reimburse(&mut self, did: &str, available: Amount) -> Amount {
            if self.vault.resource_address() != TARI_TOKEN {
                return Amount::zero();
            }
            let owed = self.owed.get(did).copied().unwrap_or(Amount::zero());
            if !owed.is_positive() || !available.is_positive() {
                return Amount::zero();
            }
            let take = if owed < available { owed } else { available };
            if owed == take {
                self.owed.remove(did);
            } else {
                self.owed.insert(did.to_string(), owed - take);
            }
            self.fee_vault.deposit(self.vault.withdraw(take));
            take
        }

        fn note_received(&mut self, did: &str, sender: RistrettoPublicKeyBytes, amount: Amount, refund_epoch: u64, window: u64) {
            let list = self.received.entry(did.to_string()).or_default();
            list.push((sender, amount, refund_epoch, window, Consensus::current_epoch()));
            if list.len() > MAX_RECEIVED_KEPT {
                list.remove(0);
            }
        }

        /// Declines a waiting deposit and returns it to its sender. Only the owner of the account's linked wallet can
        /// sign this, so an account has to link a wallet first.
        pub fn decline(&mut self, did: String, sender: RistrettoPublicKeyBytes, amount: Amount, refund_epoch: u64) {
            self.do_decline(&did, sender, amount, refund_epoch);
        }

        /// `decline`, with the network fee paid from the sponsor vault and taken back out of the returned amount.
        /// Call it from the fee phase of a transaction signed by the linked wallet.
        pub fn decline_sponsored(&mut self, did: String, sender: RistrettoPublicKeyBytes, amount: Amount, refund_epoch: u64, fee: Amount) {
            assert!(fee.is_positive() && fee <= Amount::from(MAX_SPONSORED_FEE), "sponsored fee out of range");
            let used = self.sponsored.get(&did).map_or(0, |s| s.1);
            assert!(used < MAX_SPONSORED_FINALS, "this account has used its sponsored payouts");
            self.charge_sponsored(&did, fee);
            self.do_decline(&did, sender, amount, refund_epoch);
            self.sponsored.entry(did).or_insert((0, 0, 0)).1 += 1;
            self.fee_vault.pay_fee(fee);
        }

        /// Takes back everything that was returned to `sender`: declined gifts and swept ones.
        pub fn take_returned(&mut self, sender: RistrettoPublicKeyBytes) -> Bucket {
            require_signer(sender);
            let amount = self.returned.remove(&key_hex(&sender)).expect("nothing has been returned to you");
            self.vault.withdraw(amount)
        }

        pub fn returned_for(&self, sender: RistrettoPublicKeyBytes) -> Amount {
            self.returned.get(&key_hex(&sender)).copied().unwrap_or(Amount::zero())
        }

        /// Returns phrase deposits that nobody has acted on for about three days to their senders. Anyone may call it;
        /// it does nothing while a claim for the account is in progress.
        pub fn sweep(&mut self, did: String) -> u32 {
            assert!(!self.pending.contains_key(&did), "a claim for this account is in progress");
            let now = Consensus::current_epoch();
            let list = self.deposits.remove(&did).unwrap_or_default();
            let (old, keep): (Vec<_>, Vec<_>) = list.into_iter().partition(|e| !e.4.is_empty() && now >= e.6 + SWEEP_AFTER_EPOCHS);
            assert!(!old.is_empty(), "nothing has expired");
            if !keep.is_empty() {
                self.deposits.insert(did.clone(), keep);
            }
            for e in &old {
                let took = self.reimburse(&did, e.1);
                self.credit_returned(e.0, e.1 - took);
            }
            old.len() as u32
        }

        /// Payments recently sent straight to `did`'s linked wallet.
        pub fn received_for(&self, did: String) -> Vec<(RistrettoPublicKeyBytes, Amount, u64, u64, u64)> {
            self.received.get(&did).cloned().unwrap_or_default()
        }

        fn active_binding(&self, did: &str) -> Option<ComponentAddress> {
            self.active_binding_full(did).map(|b| b.0)
        }

        /// The bound account and its owner key, if a binding is in effect.
        fn active_binding_full(&self, did: &str) -> Option<(ComponentAddress, RistrettoPublicKeyBytes)> {
            let (address, since, old, owner, old_owner) = self.bindings.get(did)?;
            if Consensus::current_epoch() >= *since {
                Some((*address, *owner))
            } else if *old == CallerContext::current_component_address() {
                None
            } else {
                Some((*old, *old_owner))
            }
        }

        fn credit_returned(&mut self, sender: RistrettoPublicKeyBytes, amount: Amount) {
            if amount.is_positive() {
                let key = key_hex(&sender);
                let had = self.returned.get(&key).copied().unwrap_or(Amount::zero());
                self.returned.insert(key, had + amount);
            }
        }

        fn do_decline(&mut self, did: &str, sender: RistrettoPublicKeyBytes, amount: Amount, refund_epoch: u64) {
            let (_, owner) = self.active_binding_full(did).expect("link your wallet first, then you can decline");
            require_signer(owner);
            let list = self.deposits.get_mut(did).expect("no deposits for this account");
            let at = list.iter().position(|e| e.0 == sender && e.1 == amount && e.2 == refund_epoch).expect("no such deposit");
            list.remove(at);
            if list.is_empty() {
                self.deposits.remove(did);
                self.pending.remove(did);
                self.claim_text.remove(did);
                self.held.remove(did);
            }
            let took = self.reimburse(did, amount);
            self.credit_returned(sender, amount - took);
        }

        fn check_chain(&self, did: &str, ops: &[Bytes]) -> atp_verify::ChainInfo {
            assert!(valid_did(did), "not a did:plc identifier");
            assert!(!ops.is_empty() && ops.len() <= MAX_OPS, "operation chain length out of range");
            assert!(ops.iter().all(|o| o.len() <= MAX_BLOCK_LEN), "operation too large");
            let ops = slices(ops, MAX_OPS);
            verify_plc_chain(did, &ops).expect("invalid operation chain")
        }
    }
}

/// A deposit pays out once its challenge window has run since the claim started, the claim post (of a linked
/// account) said what the sender asked for, and (if asked) the post was proven to still be up `hold` epochs after the claim started.
fn payable(e: &Dep, now: u64, start: u64, text: &str, seen: u64, gap: u64, bound: bool) -> bool {
    now >= start + e.3
        && (e.4.is_empty() || (bound && text.contains(e.4.as_str())))
        && seen >= start + e.5
        && gap >= e.5.saturating_mul(EPOCH_MICROS)
}

fn slices(items: &[Bytes], max: usize) -> Vec<&[u8]> {
    assert!(items.len() <= max, "too many blocks");
    items.iter().map(|b| b.as_slice()).collect()
}
