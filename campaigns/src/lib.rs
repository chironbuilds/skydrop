//   SPDX-License-Identifier: BSD-3-Clause

//! Campaign: one funded, self-contained, rule-driven reward campaign on Bluesky. Anyone can create one; no
//! governance approves it, and nobody but the funder has any authority over it, and only after it closes.
//!
//! * **Each campaign is its own component** with its own vault, so campaigns are isolated from one another
//!   and can pay in any fungible resource.
//! * **Double claims are stopped by a receipt NFT, not by a set in component state.** The receipt's id is a
//!   hash of the DID, so minting it twice fails. Component state stays the same size however many people
//!   claim, which matters because a substate is capped at 1 MiB and every call pays to load it.
//! * **Rules are ANDed**, except that rules sharing a non-zero group are either/or: one of them is enough. A claimant
//!   proves every required rule (up to `MAX_RULES`), each from a signed repo:
//!   - in the claimant's repo: like, repost, follow, post containing text, reply to a post, quote of a post. A reply
//!     or quote can also be required to contain text, checked on that same record;
//!   - in a voucher's repo: a list item, a follow *of* the claimant, or a Bluesky verification record. These are
//!     the rules that limit fake accounts, because the voucher decides who gets one.
//! * **Allocations** (optional): a Merkle root of `(did, amount)` set by the funder pays each DID its own amount.
//! * **Rounds** (optional): the reward repeats up to `rounds` times, at least `round_epochs` apart. Each round
//!   needs its own new code post and a re-proof of every rule from a newer commit, so it pays people who stay.
//! * **Referrals** (optional): a new claimant may name a DID that already claimed; that DID's account is paid
//!   `referral_bonus`, up to `max_referrals` times.
//! * **Payout binding**: `claim` needs a post in the DID's repo whose code commits to this campaign, the DID, the
//!   wallet key and the round, so nobody can redirect a claim. `claim_linked` needs no code: it pays the wallet
//!   the DID linked in the LinkRegistry and anyone may submit it.
//! * **Funder limits**: the pool can be topped up by anyone and the close epoch can only move later. Only after
//!   the close epoch can the funder take what is left. Rounds not claimed by then are forfeited.
//!
//! What this cannot prove: *when* a claimant's record was made (the account signs its own timestamps), or that it
//! has not been deleted since. See docs/SECURITY.md.

use atp_verify::sha256;
use tari_template_lib::{events::emit_event, prelude::*, types::crypto::RistrettoPublicKeyBytes};

const CODE_DOMAIN: &[u8] = b"tari-campaign:v1:";
const POST: &str = "app.bsky.feed.post";
const MAX_RULES: usize = 8;
const MAX_OPS: usize = 16;
const MAX_NODES: usize = 32;
const MAX_BLOCK_LEN: usize = 16 * 1024;
const MAX_TARGET: usize = 300;
const MAX_TEXT: usize = 200;
const MAX_NAME: usize = 64;
const MAX_INFO: usize = 256;
const MAX_ROUNDS: u16 = 52;
const MAX_DURATION: u64 = 20_000;
const MAX_MERKLE_DEPTH: usize = 32;

const LIKE: u8 = 0;
const REPOST: u8 = 1;
const FOLLOW: u8 = 2;
const POST_CONTAINS: u8 = 3;
const REPLY: u8 = 4;
const QUOTE: u8 = 5;
const IN_LIST: u8 = 6;
const FOLLOWED_BY: u8 = 7;
const VERIFIED_BY: u8 = 8;

fn require_signer(key: RistrettoPublicKeyBytes) {
    CallerContext::assert_badge_in_scope(&NonFungibleAddress::from_public_key(key));
}

fn collection(kind: u8) -> &'static str {
    match kind {
        LIKE => "app.bsky.feed.like",
        REPOST => "app.bsky.feed.repost",
        FOLLOW | FOLLOWED_BY => "app.bsky.graph.follow",
        POST_CONTAINS | REPLY | QUOTE => POST,
        IN_LIST => "app.bsky.graph.listitem",
        VERIFIED_BY => "app.bsky.graph.verification",
        _ => panic!("unknown rule kind"),
    }
}

fn is_vouch(kind: u8) -> bool {
    matches!(kind, IN_LIST | FOLLOWED_BY | VERIFIED_BY)
}

/// The DID whose repo must hold a vouch rule's record: the owner of the list, or the voucher named directly.
fn voucher_of(kind: u8, target: &str) -> String {
    if kind == IN_LIST {
        let rest = target.strip_prefix("at://").expect("a list rule's target is at://<did:plc>/app.bsky.graph.list/<rkey>");
        let (org, path) = rest.split_once('/').expect("a list rule's target is at://<did:plc>/app.bsky.graph.list/<rkey>");
        let rkey = path.strip_prefix("app.bsky.graph.list/").expect("a list rule's target must name an app.bsky.graph.list");
        assert!(!rkey.is_empty() && !rkey.contains('/'), "a list rule's target is at://<did:plc>/app.bsky.graph.list/<rkey>");
        assert!(org.starts_with("did:plc:"), "a list owner must be a did:plc");
        String::from(org)
    } else {
        assert!(target.starts_with("did:plc:"), "a voucher must be a did:plc");
        String::from(target)
    }
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn claim_code(component: &str, did: &str, claimant: &RistrettoPublicKeyBytes, round: u16) -> String {
    let mut data = CODE_DOMAIN.to_vec();
    data.extend_from_slice(component.as_bytes());
    data.push(b':');
    data.extend_from_slice(did.as_bytes());
    data.push(b':');
    data.extend_from_slice(&claimant.into_array());
    data.push(b':');
    data.extend_from_slice(&round.to_be_bytes());
    let digest = sha256(&data);
    let mut s = String::from("tari-quest:");
    s.push_str(&hex(&digest[..16]));
    s
}

/// The receipt id for a DID: its hash, so minting one twice fails.
fn receipt_id(did: &str) -> NonFungibleId {
    NonFungibleId::from_u256(sha256(did.as_bytes()))
}

/// Merkle leaf for an allocation. Domain-separated from inner nodes so a node can't be replayed as a leaf.
fn allocation_leaf(did: &str, amount: u64) -> [u8; 32] {
    let mut data = vec![0u8];
    data.extend_from_slice(did.as_bytes());
    data.push(0);
    data.extend_from_slice(&amount.to_be_bytes());
    sha256(&data)
}

/// Whether `path` links `leaf` to `root`. Inner nodes hash their two children in sorted order.
fn merkle_ok(root: &[u8], leaf: [u8; 32], path: &[Bytes]) -> bool {
    assert!(path.len() <= MAX_MERKLE_DEPTH, "allocation proof too long");
    let mut node = leaf;
    for sibling in path {
        assert!(sibling.len() == 32, "allocation proof nodes are 32 bytes");
        let (a, b) = if node.as_slice() <= sibling.as_slice() { (node.as_slice(), sibling.as_slice()) } else { (sibling.as_slice(), node.as_slice()) };
        let mut data = vec![1u8];
        data.extend_from_slice(a);
        data.extend_from_slice(b);
        node = sha256(&data);
    }
    node.as_slice() == root
}

fn slices(items: &[Bytes], max: usize) -> Vec<&[u8]> {
    assert!(!items.is_empty() && items.len() <= max, "bad block count");
    assert!(items.iter().all(|b| b.len() <= MAX_BLOCK_LEN), "block too large");
    items.iter().map(|b| b.as_slice()).collect()
}

/// A receipt's immutable data: the DID and the account its rewards go to.
type ReceiptData = (String, ComponentAddress);
/// A receipt's mutable data: rounds paid, epoch of the last payment, newest commit time proven, referrals paid.
type ReceiptState = (u16, u64, u64, u32);

#[template]
mod campaign {
    use super::*;

    pub struct Campaign {
        name: String,
        /// A URL or content hash with the campaign's public description; opaque to the contract.
        info: String,
        funder: RistrettoPublicKeyBytes,
        vault: Vault,
        receipts: ResourceAddress,
        /// Holds the single badge that may mint and update receipts, so only this component can.
        mint_badge: Vault,
        link_registry: ComponentAddress,
        kinds: Vec<u8>,
        targets: Vec<String>,
        /// Per rule: the earliest commit time (µs) a voucher's proof may come from. Ignored for claimant repos,
        /// whose timestamps the claimant signs; a voucher's own signature makes it meaningful there.
        snapshots: Vec<u64>,
        /// Per rule: text a reply or quote must itself contain. Empty = any.
        texts: Vec<String>,
        /// Per rule: 0 = required; rules sharing another value are either/or.
        groups: Vec<u8>,
        reward: Amount,
        /// Merkle root of (did, amount); empty = everyone gets `reward`.
        allocation_root: Bytes,
        rounds: u16,
        round_epochs: u64,
        referral_bonus: Amount,
        max_referrals: u32,
        open_epoch: u64,
        close_epoch: u64,
        claimants: u64,
        payments: u64,
        paid: Amount,
    }

    impl Campaign {
        /// Creates and funds a campaign. See the module docs for what each setting does.
        #[allow(clippy::too_many_arguments)]
        pub fn create(
            name: String,
            info: String,
            funder: RistrettoPublicKeyBytes,
            link_registry: ComponentAddress,
            kinds: Vec<u8>,
            targets: Vec<String>,
            snapshots: Vec<u64>,
            texts: Vec<String>,
            groups: Vec<u8>,
            reward: Amount,
            allocation_root: Bytes,
            rounds: u16,
            round_epochs: u64,
            referral_bonus: Amount,
            max_referrals: u32,
            open_epoch: u64,
            close_epoch: u64,
            funds: Bucket,
        ) -> Component<Self> {
            require_signer(funder);
            assert!(!name.is_empty() && name.len() <= MAX_NAME, "name must be 1-64 bytes");
            assert!(info.len() <= MAX_INFO, "info too long");
            assert!(kinds.len() <= MAX_RULES, "too many rules");
            assert!(kinds.len() == targets.len() && kinds.len() == snapshots.len() && kinds.len() == texts.len() && kinds.len() == groups.len(), "rule lists differ in length");
            for (kind, text) in kinds.iter().zip(&texts) {
                assert!(text.len() <= MAX_TEXT, "required text is too long");
                assert!(text.is_empty() || matches!(*kind, REPLY | QUOTE), "only replies and quotes can require text");
            }
            assert!(!kinds.is_empty() || !allocation_root.is_empty(), "a campaign needs a rule or an allocation list");
            for (kind, target) in kinds.iter().zip(&targets) {
                collection(*kind);
                assert!(!target.is_empty() && target.len() <= MAX_TARGET, "rule target must be 1-300 bytes");
                if is_vouch(*kind) {
                    voucher_of(*kind, target);
                }
            }
            assert!(allocation_root.is_empty() || allocation_root.len() == 32, "allocation root must be 32 bytes");
            assert!(reward.is_positive() || !allocation_root.is_empty(), "reward must be positive");
            assert!(rounds >= 1 && rounds <= MAX_ROUNDS, "rounds must be 1-52");
            assert!(rounds == 1 || round_epochs >= 1, "repeating rounds need a spacing");
            assert!(!referral_bonus.is_negative(), "bonus cannot be negative");
            let now = Consensus::current_epoch();
            assert!(close_epoch > now && close_epoch > open_epoch, "close epoch must be in the future, after opening");
            assert!(close_epoch <= now.saturating_add(MAX_DURATION), "close epoch too far in the future");
            assert!(funds.amount().is_positive(), "a campaign needs funds");

            let badge_id = NonFungibleId::from_u32(0);
            let badge = ResourceBuilder::non_fungible().with_owner_rule(OwnerRule::None).initial_supply([badge_id.clone()]);
            let badge_address = NonFungibleAddress::new(badge.resource_address(), badge_id);
            let receipts = ResourceBuilder::non_fungible()
                .with_owner_rule(OwnerRule::None)
                .with_token_symbol("QUEST")
                .mintable(rule!(non_fungible(badge_address.clone())), rule!(deny_all))
                .update_non_fungible_data(rule!(non_fungible(badge_address)), rule!(deny_all))
                .withdrawable(rule!(deny_all), rule!(deny_all))
                .build();

            let mut key_hex = String::new();
            key_hex.push_str(&hex(&funder.into_array()));
            emit_event("campaign.created", metadata!["funder" => key_hex, "name" => name.clone()]);
            Component::new(Self {
                name,
                info,
                funder,
                vault: Vault::from_bucket(funds),
                receipts,
                mint_badge: Vault::from_bucket(badge),
                link_registry,
                kinds,
                targets,
                snapshots,
                texts,
                groups,
                reward,
                allocation_root,
                rounds,
                round_epochs,
                referral_bonus,
                max_referrals,
                open_epoch,
                close_epoch,
                claimants: 0,
                payments: 0,
                paid: Amount::zero(),
            })
            .with_owner_rule(OwnerRule::None)
            .with_access_rules(AccessRules::allow_all())
            .create()
        }

        /// The text `did` must post so round `round` (0-based) pays the wallet key `claimant`.
        pub fn expected_post_text(&self, did: String, claimant: RistrettoPublicKeyBytes, round: u16) -> String {
            claim_code(&CallerContext::current_component_address().to_string(), &did, &claimant, round)
        }

        pub fn balance(&self) -> Amount {
            self.vault.balance()
        }

        pub fn receipt_resource(&self) -> ResourceAddress {
            self.receipts
        }

        /// (claimants, payments, total paid, balance, open epoch, close epoch).
        pub fn stats(&self) -> (u64, u64, Amount, Amount, u64, u64) {
            (self.claimants, self.payments, self.paid, self.vault.balance(), self.open_epoch, self.close_epoch)
        }

        /// First claim. `claimant` signs and is bound by a code post in `did`'s repo (`c_*`). `commits`, `nodes`,
        /// `records` and `rkeys` hold one proof per rule, in rule order; `vouch_ops` holds the voucher's PLC chain
        /// for each vouch rule, in rule order. `amount`/`path` prove an allocation (ignored without one).
        #[allow(clippy::too_many_arguments)]
        pub fn claim(
            &mut self,
            did: String,
            claimant: RistrettoPublicKeyBytes,
            account: ComponentAddress,
            ops: Vec<Bytes>,
            commits: Vec<Bytes>,
            nodes: Vec<Vec<Bytes>>,
            records: Vec<Bytes>,
            rkeys: Vec<String>,
            vouch_ops: Vec<Vec<Bytes>>,
            c_commit: Bytes,
            c_nodes: Vec<Bytes>,
            c_record: Bytes,
            c_rkey: String,
            amount: u64,
            path: Vec<Bytes>,
            referrer: Option<String>,
        ) {
            require_signer(claimant);
            self.assert_open();
            let key = self.verify_chain(&did, &ops);
            self.verify_code(&did, &key, &claimant, 0, &c_commit, &c_nodes, &c_record, &c_rkey);
            let rev = self.verify_rules(&did, &key, &commits, &nodes, &records, &rkeys, &vouch_ops);
            self.first_payment(did, account, rev, amount, path, referrer);
        }

        /// First claim paid to the wallet `did` linked in the LinkRegistry. Needs no code post and no signature:
        /// the registry already binds the DID to its wallet, so anyone may submit it (a relayer can pay the fee).
        #[allow(clippy::too_many_arguments)]
        pub fn claim_linked(
            &mut self,
            did: String,
            ops: Vec<Bytes>,
            commits: Vec<Bytes>,
            nodes: Vec<Vec<Bytes>>,
            records: Vec<Bytes>,
            rkeys: Vec<String>,
            vouch_ops: Vec<Vec<Bytes>>,
            amount: u64,
            path: Vec<Bytes>,
            referrer: Option<String>,
        ) {
            self.assert_open();
            let key = self.verify_chain(&did, &ops);
            let rev = self.verify_rules(&did, &key, &commits, &nodes, &records, &rkeys, &vouch_ops);
            let wallet: Option<ComponentAddress> = ComponentManager::get(self.link_registry).call("binding_for", args![did.clone()]);
            let account = wallet.expect("this account has not linked a wallet");
            self.first_payment(did, account, rev, amount, path, referrer);
        }

        /// A later round for `did`. It needs a new code post for this round, a re-proof of every rule from a newer
        /// commit than the last one proven, and `round_epochs` since the last payment. Pays the receipt's account.
        #[allow(clippy::too_many_arguments)]
        pub fn claim_round(
            &mut self,
            did: String,
            claimant: RistrettoPublicKeyBytes,
            ops: Vec<Bytes>,
            commits: Vec<Bytes>,
            nodes: Vec<Vec<Bytes>>,
            records: Vec<Bytes>,
            rkeys: Vec<String>,
            vouch_ops: Vec<Vec<Bytes>>,
            c_commit: Bytes,
            c_nodes: Vec<Bytes>,
            c_record: Bytes,
            c_rkey: String,
            amount: u64,
            path: Vec<Bytes>,
        ) {
            require_signer(claimant);
            self.assert_open();
            let manager = ResourceManager::get(self.receipts);
            let id = receipt_id(&did);
            let nft = manager.get_non_fungible(&id);
            let (_, account): ReceiptData = nft.get_data();
            let (paid_rounds, last_epoch, last_rev, referrals): ReceiptState = nft.get_mutable_data();
            assert!(paid_rounds < self.rounds, "every round has been paid");
            let now = Consensus::current_epoch();
            assert!(now >= last_epoch.saturating_add(self.round_epochs), "this round is not open yet");

            let key = self.verify_chain(&did, &ops);
            self.verify_code(&did, &key, &claimant, paid_rounds, &c_commit, &c_nodes, &c_record, &c_rkey);
            let rev = self.verify_rules(&did, &key, &commits, &nodes, &records, &rkeys, &vouch_ops);
            // `rev` is 0 only when this claim proved nothing from the claimant's own repo (only vouches)
            assert!(rev == 0 || rev > last_rev, "these proofs are not newer than the last round's");

            let pay = self.amount_for(&did, amount, &path);
            self.pay(account, pay);
            let state: ReceiptState = (paid_rounds + 1, now, rev.max(last_rev), referrals);
            self.mint_badge.authorize_with(|| manager.update_non_fungible_data(id, &state));
            emit_event("campaign.claim", metadata!["did" => did, "round" => paid_rounds.to_string(), "amount" => pay.to_string()]);
        }

        /// Adds to the pool. Anyone may.
        pub fn top_up(&mut self, funds: Bucket) {
            self.vault.deposit(funds);
        }

        /// Moves the close epoch later. It can never move earlier, so nobody loses a promised window.
        pub fn extend(&mut self, close_epoch: u64) {
            require_signer(self.funder);
            assert!(close_epoch > self.close_epoch, "the close epoch can only move later");
            assert!(close_epoch <= Consensus::current_epoch().saturating_add(MAX_DURATION), "close epoch too far in the future");
            self.close_epoch = close_epoch;
        }

        /// After the close epoch, the funder takes back whatever is left.
        pub fn close(&mut self) -> Bucket {
            require_signer(self.funder);
            assert!(Consensus::current_epoch() >= self.close_epoch, "the campaign has not closed yet");
            self.vault.withdraw(self.vault.balance())
        }

        fn assert_open(&self) {
            let now = Consensus::current_epoch();
            assert!(now >= self.open_epoch, "the campaign has not opened yet");
            assert!(now < self.close_epoch, "the campaign has closed");
        }

        /// Verifies a PLC chain and checks it reaches the shared floor, so a rotated-away key proves nothing.
        fn verify_chain(&self, did: &str, ops: &[Bytes]) -> atp_verify::Key {
            let chain = atp_verify::verify_plc_chain(did, &slices(ops, MAX_OPS)).expect("invalid operation chain");
            let floor: u32 = ComponentManager::get(self.link_registry).call("chain_floor", args![String::from(did)]);
            assert!(chain.len >= floor, "stale operation chain: a longer one has been seen");
            chain.signing_key
        }

        #[allow(clippy::too_many_arguments)]
        fn verify_code(&self, did: &str, key: &atp_verify::Key, claimant: &RistrettoPublicKeyBytes, round: u16, commit: &Bytes, nodes: &[Bytes], record: &Bytes, rkey: &str) {
            assert!(commit.len() <= MAX_BLOCK_LEN && record.len() <= MAX_BLOCK_LEN, "block too large");
            atp_verify::verify_record(did, key, commit.as_slice(), &slices(nodes, MAX_NODES), record.as_slice(), POST, rkey).expect("invalid claim-code proof");
            let text = atp_verify::record_text(record.as_slice()).expect("claim post has no text");
            let code = claim_code(&CallerContext::current_component_address().to_string(), did, claimant, round);
            assert!(text.contains(&code), "the post does not contain the claim code");
        }

        /// Proves every rule. Returns the newest commit time among proofs from the claimant's own repo. A proof that
        /// repeats the previous commit of that repo skips its signature check, which saves most of the cost.
        #[allow(clippy::too_many_arguments)]
        fn verify_rules(&self, did: &str, key: &atp_verify::Key, commits: &[Bytes], nodes: &[Vec<Bytes>], records: &[Bytes], rkeys: &[String], vouch_ops: &[Vec<Bytes>]) -> u64 {
            let n = self.kinds.len();
            assert!(commits.len() == n && nodes.len() == n && records.len() == n && rkeys.len() == n, "one proof per rule");
            let mut proven = vec![false; n];
            let mut newest = 0u64;
            let mut own_root: Option<(&[u8], [u8; 32])> = None;
            let mut vouch = 0usize;
            for i in 0..n {
                // An either/or rule may be skipped by leaving its commit empty; the check after the loop needs one per group.
                if commits[i].is_empty() {
                    assert!(self.groups[i] != 0, "a required step has no proof");
                    continue;
                }
                proven[i] = true;
                let (kind, target) = (self.kinds[i], self.targets[i].as_str());
                let (commit, record) = (commits[i].as_slice(), records[i].as_slice());
                assert!(commit.len() <= MAX_BLOCK_LEN && record.len() <= MAX_BLOCK_LEN, "block too large");
                let node_slices = slices(&nodes[i], MAX_NODES);
                if is_vouch(kind) {
                    let voucher = voucher_of(kind, target);
                    let vkey = self.verify_chain(&voucher, vouch_ops.get(vouch).expect("one operation chain per proven vouch rule"));
                    vouch += 1;
                    atp_verify::verify_record(&voucher, &vkey, commit, &node_slices, record, collection(kind), &rkeys[i]).expect("invalid voucher proof");
                    assert!(atp_verify::field_eq(record, &["subject"], did), "that record vouches for another account");
                    if kind == IN_LIST {
                        assert!(atp_verify::field_eq(record, &["list"], target), "that list item is on another list");
                    }
                    let rev = atp_verify::commit_rev_micros(commit).expect("bad voucher commit");
                    assert!(rev >= self.snapshots[i], "that voucher proof predates the campaign's snapshot");
                    continue;
                }
                let root = match own_root {
                    Some((c, r)) if c == commit => r,
                    _ => {
                        let r = atp_verify::verify_commit(did, key, commit).expect("invalid repo commit");
                        own_root = Some((commit, r));
                        r
                    },
                };
                atp_verify::verify_in_root(&root, &node_slices, record, collection(kind), &rkeys[i]).expect("invalid engagement proof");
                newest = newest.max(atp_verify::commit_rev_micros(commit).expect("bad commit rev"));
                let ok = match kind {
                    LIKE | REPOST => atp_verify::field_eq(record, &["subject", "uri"], target),
                    FOLLOW => atp_verify::field_eq(record, &["subject"], target),
                    POST_CONTAINS => atp_verify::field_contains(record, &["text"], target),
                    REPLY => atp_verify::field_eq(record, &["reply", "parent", "uri"], target) || atp_verify::field_eq(record, &["reply", "root", "uri"], target),
                    QUOTE => atp_verify::field_eq(record, &["embed", "record", "uri"], target) || atp_verify::field_eq(record, &["embed", "record", "record", "uri"], target),
                    _ => false,
                };
                assert!(ok, "a record does not satisfy its campaign rule");
                let text = self.texts[i].as_str();
                assert!(text.is_empty() || atp_verify::field_contains(record, &["text"], text), "that post does not contain the required text");
            }
            assert!(vouch == vouch_ops.len(), "one operation chain per proven vouch rule");
            for i in 0..n {
                let g = self.groups[i];
                assert!(g == 0 || (0..n).any(|j| self.groups[j] == g && proven[j]), "an either/or step has no proof");
            }
            newest
        }

        fn amount_for(&self, did: &str, amount: u64, path: &[Bytes]) -> Amount {
            if self.allocation_root.is_empty() {
                return self.reward;
            }
            assert!(amount > 0, "allocations are positive");
            assert!(merkle_ok(self.allocation_root.as_slice(), allocation_leaf(did, amount), path), "this account is not on the allocation list for that amount");
            Amount::from(amount)
        }

        fn first_payment(&mut self, did: String, account: ComponentAddress, rev: u64, amount: u64, path: Vec<Bytes>, referrer: Option<String>) {
            assert!(ComponentManager::get(account).get_template_address() == TemplateAddress::from_array([0; 32]), "rewards go to a standard Tari account");
            let pay = self.amount_for(&did, amount, &path);
            if let Some(from) = referrer {
                self.pay_referral(&did, &from);
            }
            self.pay(account, pay);
            // Minting an id that exists fails the transaction: this is what makes a claim once-only.
            let manager = ResourceManager::get(self.receipts);
            let data: ReceiptData = (did.clone(), account);
            let state: ReceiptState = (1, Consensus::current_epoch(), rev, 0);
            let receipt = self.mint_badge.authorize_with(|| manager.mint_non_fungible(receipt_id(&did), &data, &state));
            ComponentManager::get(account).invoke("deposit", args![receipt]);
            self.claimants += 1;
            emit_event("campaign.claim", metadata!["did" => did, "round" => "0", "amount" => pay.to_string()]);
        }

        fn pay_referral(&mut self, did: &str, from: &str) {
            if !self.referral_bonus.is_positive() {
                return;
            }
            assert!(from != did, "an account cannot refer itself");
            let manager = ResourceManager::get(self.receipts);
            let id = receipt_id(from);
            let nft = manager.get_non_fungible(&id);
            let (_, account): ReceiptData = nft.get_data();
            let (rounds, epoch, rev, referrals): ReceiptState = nft.get_mutable_data();
            assert!(referrals < self.max_referrals, "that referrer has used all its referrals");
            let bonus = self.referral_bonus;
            self.pay(account, bonus);
            let state: ReceiptState = (rounds, epoch, rev, referrals + 1);
            self.mint_badge.authorize_with(|| manager.update_non_fungible_data(id, &state));
        }

        fn pay(&mut self, account: ComponentAddress, amount: Amount) {
            assert!(self.vault.balance() >= amount, "the campaign's pool is exhausted");
            let funds = self.vault.withdraw(amount);
            ComponentManager::get(account).invoke("deposit", args![funds]);
            self.payments += 1;
            self.paid += amount;
        }
    }
}
