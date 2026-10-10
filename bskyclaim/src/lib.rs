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
//! * `refund` returns an unclaimed deposit to its sender after the refund epoch.

use atp_verify::{record_text, sha256, verify_plc_chain, verify_record};
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
const MAX_BLOCK_LEN: usize = 16 * 1024;
/// Ceiling on the fee one sponsored call may offer from the sponsor vault (µT).
const MAX_SPONSORED_FEE: u64 = 100_000;
/// Sponsored claim starts and payouts one account may draw. Beyond that the claimant pays their own fee.
const MAX_SPONSORED_STARTS: u32 = 3;
const MAX_SPONSORED_FINALS: u32 = 3;

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

fn valid_did(did: &str) -> bool {
    did.len() == 32
        && did.starts_with("did:plc:")
        && did[8..].bytes().all(|c| matches!(c, b'a'..=b'z' | b'2'..=b'7'))
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
        /// DID -> (sender, amount, refund epoch, challenge window in epochs). Each sender picks the window for
        /// their own deposit: 0 for a small tip, longer for a large transfer.
        deposits: BTreeMap<String, Vec<(RistrettoPublicKeyBytes, Amount, u64, u64)>>,
        /// DID -> (claimant, hash of the chain tip, chain length, epoch the claim started).
        pending: BTreeMap<String, (RistrettoPublicKeyBytes, Bytes, u32, u64)>,
        /// DID -> longest valid operation chain seen. A claim must present a chain at least this long.
        known_len: BTreeMap<String, u32>,
        /// TARI that pays the network fee of claims that verify, so a brand-new claimant needs no funds.
        /// Kept apart from `vault`: deposits are never spent on fees.
        fee_vault: Vault,
        /// DID -> (sponsored claim starts, sponsored finalisations). Bounds what one account can draw.
        sponsored: BTreeMap<String, (u32, u32)>,
    }

    impl BskyClaim {
        pub fn new(resource: ResourceAddress, min_deposit: Amount, max_window_epochs: u64) -> Component<Self> {
            assert!(min_deposit.is_positive(), "minimum deposit must be positive");
            Component::new(Self {
                vault: Vault::new_empty(resource),
                min_deposit,
                max_window_epochs,
                deposits: BTreeMap::new(),
                pending: BTreeMap::new(),
                known_len: BTreeMap::new(),
                fee_vault: Vault::new_empty(TARI_TOKEN),
                sponsored: BTreeMap::new(),
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
            funds: Bucket,
        ) {
            assert!(valid_did(&did), "not a did:plc identifier");
            assert!(window_epochs <= self.max_window_epochs, "challenge window above the maximum");
            require_signer(sender);
            assert_eq!(funds.resource_address(), self.vault.resource_address(), "wrong resource");
            let amount = funds.amount();
            assert!(amount >= self.min_deposit, "deposit below the minimum");
            assert!(refund_epoch > Consensus::current_epoch(), "refund epoch must be in the future");
            let list = self.deposits.entry(did).or_default();
            assert!(list.len() < MAX_DEPOSITS_PER_DID, "too many deposits for this account");
            list.push((sender, amount, refund_epoch, window_epochs));
            self.vault.deposit(funds);
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
            self.sponsored.entry(did).or_insert((0, 0)).0 += 1;
            self.fee_vault.pay_fee(fee);
        }

        /// Pays the fee of the claimant's `finalize_claim`, called from the fee phase. Only when a claim is
        /// pending, signed for by its claimant, and at least one deposit is already payable.
        pub fn sponsor_finalize(&mut self, did: String, fee: Amount) {
            assert!(fee.is_positive() && fee <= Amount::from(MAX_SPONSORED_FEE), "sponsored fee out of range");
            let (claimant, _, _, start) = self.pending.get(&did).cloned().expect("no pending claim");
            require_signer(claimant);
            let now = Consensus::current_epoch();
            assert!(
                self.deposits.get(&did).is_some_and(|d| d.iter().any(|e| now >= start + e.3)),
                "nothing is payable yet"
            );
            let used = self.sponsored.get(&did).map_or(0, |s| s.1);
            assert!(used < MAX_SPONSORED_FINALS, "this account has used its sponsored payouts");
            self.sponsored.entry(did).or_insert((0, 0)).1 += 1;
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
            assert!(text.contains(&code), "the post does not contain the claim code");

            self.known_len.insert(did.clone(), chain.len);
            self.pending.insert(did, (claimant, Bytes::from_vec(chain.tip.to_vec()), chain.len, Consensus::current_epoch()));
        }

        /// Cancels a pending claim by presenting a valid operation chain for the DID that differs from the
        /// one the claim relied on: a later key rotation, or the canonical branch of a fork. Anyone may call.
        /// It works while any deposit's challenge window, counted from the claim's start, is still open.
        pub fn challenge(&mut self, did: String, ops: Vec<Bytes>) {
            let (_, tip, _, start) = self.pending.get(&did).expect("no pending claim");
            let longest = self.deposits.get(&did).map_or(0, |d| d.iter().map(|e| e.3).max().unwrap_or(0));
            assert!(Consensus::current_epoch() < *start + longest, "the challenge window has closed");
            let chain = self.check_chain(&did, &ops);
            assert!(chain.tip.as_slice() != tip.as_slice(), "that is the chain the claim already relies on");
            self.known_len.entry(did.clone()).and_modify(|l| *l = (*l).max(chain.len)).or_insert(chain.len);
            self.pending.remove(&did);
        }

        /// Pays out every deposit whose challenge window has passed since the claim started. Deposits with a
        /// longer window stay escrowed and the claim stays pending. Only the claimant can call it.
        pub fn finalize_claim(&mut self, did: String) -> Bucket {
            let (claimant, _, _, start) = self.pending.get(&did).cloned().expect("no pending claim");
            require_signer(claimant);
            let now = Consensus::current_epoch();
            let list = self.deposits.remove(&did).unwrap_or_default();
            let (ready, waiting): (Vec<_>, Vec<_>) = list.into_iter().partition(|e| now >= start + e.3);
            assert!(!ready.is_empty(), "the challenge window is still open");
            let total = ready.iter().fold(Amount::zero(), |acc, e| acc + e.1);
            if waiting.is_empty() {
                self.pending.remove(&did);
            } else {
                self.deposits.insert(did, waiting);
            }
            self.vault.withdraw(total)
        }

        /// Returns the deposit at `index` to its sender once its refund epoch has passed.
        pub fn refund(&mut self, did: String, index: u32) -> Bucket {
            let list = self.deposits.get_mut(&did).expect("no deposits for this account");
            let (sender, amount, refund_epoch, _) = *list.get(index as usize).expect("no such deposit");
            require_signer(sender);
            assert!(Consensus::current_epoch() >= refund_epoch, "not refundable yet");
            list.remove(index as usize);
            if list.is_empty() {
                self.deposits.remove(&did);
            }
            self.vault.withdraw(amount)
        }

        pub fn deposits_for(&self, did: String) -> Vec<(RistrettoPublicKeyBytes, Amount, u64, u64)> {
            self.deposits.get(&did).cloned().unwrap_or_default()
        }

        /// (claimant, chain length, epoch the claim started)
        pub fn pending_for(&self, did: String) -> Option<(RistrettoPublicKeyBytes, u32, u64)> {
            self.pending.get(&did).map(|(c, _, l, s)| (*c, *l, *s))
        }

        pub fn total_escrowed(&self) -> Amount {
            self.vault.balance()
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

fn slices(items: &[Bytes], max: usize) -> Vec<&[u8]> {
    assert!(items.len() <= max, "too many blocks");
    items.iter().map(|b| b.as_slice()).collect()
}
