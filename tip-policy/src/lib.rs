//   SPDX-License-Identifier: BSD-3-Clause

//! TipPolicy: tip a Bluesky user by posting `@bot tip @recipient 5`. The signed post is the authority, so
//! a relayer can neither forge nor alter a tip. A tipper funds a budget once; each tip draws from it and
//! becomes a deposit for the recipient, governed by the ClaimPolicy, which the recipient claims normally.
//!
//! The tip's funds live in this policy's budget vault; it moves them into the Escrow with the badge-gated
//! `policy_deposit`, since a relayed tip has no on-chain signer.

use tari_template_lib::{prelude::*, types::crypto::RistrettoPublicKeyBytes};

const POST: &str = "app.bsky.feed.post";
const MAX_OPS: usize = 16;
const MAX_NODES: usize = 32;
const MAX_BLOCK_LEN: usize = 16 * 1024;

fn require_signer(key: RistrettoPublicKeyBytes) {
    CallerContext::assert_badge_in_scope(&NonFungibleAddress::from_public_key(key));
}

fn key_hex(key: &RistrettoPublicKeyBytes) -> String {
    let mut s = String::new();
    for b in key.into_array() {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// A budget is owned by one key for one account: `did:ownerKeyHex`.
fn budget_key(did: &str, owner: &RistrettoPublicKeyBytes) -> String {
    let mut s = String::from(did);
    s.push(':');
    s.push_str(&key_hex(owner));
    s
}

fn slices(items: &[Bytes], max: usize) -> Vec<&[u8]> {
    assert!(items.len() <= max, "too many blocks");
    assert!(items.iter().all(|b| b.len() <= MAX_BLOCK_LEN), "block too large");
    items.iter().map(|b| b.as_slice()).collect()
}

#[template]
mod tip_policy {
    use std::collections::BTreeMap;

    use super::*;

    pub struct TipPolicy {
        escrow: ComponentAddress,
        /// The policy that governs the deposits tips create — recipients claim through it.
        claim_policy: ComponentAddress,
        /// This policy's badge, for the badge-gated `policy_deposit`.
        badge_vault: Vault,
        /// Holds budget funds (the escrowed resource) until a tip moves them into the Escrow.
        budget_vault: Vault,
        /// The account tip posts must mention first: `@bot tip @someone 5`.
        bot_did: String,
        /// "did:ownerKeyHex" -> (balance, challenge window for tips, refund-after epochs, max per tip).
        budgets: BTreeMap<String, (Amount, u64, u64, Amount)>,
        /// did -> rkey of the last tip post spent; a later post must have a larger rkey (spend once).
        last_tip: BTreeMap<String, String>,
        /// The LinkRegistry whose `chain_pin` a tip post's operation chain must reach.
        link_registry: ComponentAddress,
    }

    impl TipPolicy {
        pub fn new(
            escrow: ComponentAddress,
            claim_policy: ComponentAddress,
            resource: ResourceAddress,
            badge_resource: ResourceAddress,
            bot_did: String,
            link_registry: ComponentAddress,
        ) -> Component<Self> {
            Component::new(Self {
                escrow,
                claim_policy,
                badge_vault: Vault::new_empty(badge_resource),
                budget_vault: Vault::new_empty(resource),
                bot_did,
                budgets: BTreeMap::new(),
                last_tip: BTreeMap::new(),
                link_registry,
            })
            .with_owner_rule(OwnerRule::None)
            .with_access_rules(AccessRules::allow_all())
            .create()
        }

        pub fn receive_badge(&mut self, badge: Bucket) {
            self.badge_vault.deposit(badge);
        }

        /// Opens or tops up a tip budget for `did`, owned by `owner` (the only one who can withdraw). Tips
        /// become deposits with `window_epochs` challenge window, refundable to `owner` after `refund_after`
        /// epochs, at most `max_tip` each.
        pub fn open_budget(
            &mut self,
            did: String,
            owner: RistrettoPublicKeyBytes,
            window_epochs: u64,
            refund_after: u64,
            max_tip: Amount,
            funds: Bucket,
        ) {
            require_signer(owner);
            assert_eq!(funds.resource_address(), self.budget_vault.resource_address(), "wrong resource");
            assert!(refund_after > 0, "refund period must be positive");
            assert!(max_tip.is_positive(), "max tip must be positive");
            let amount = funds.amount();
            assert!(amount.is_positive(), "budget must be positive");
            let entry = self.budgets.entry(budget_key(&did, &owner)).or_insert((Amount::zero(), 0, 0, Amount::zero()));
            entry.0 += amount;
            entry.1 = window_epochs;
            entry.2 = refund_after;
            entry.3 = max_tip;
            self.budget_vault.deposit(funds);
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
            self.budget_vault.withdraw(amount)
        }

        pub fn budget_for(&self, did: String, owner: RistrettoPublicKeyBytes) -> Option<(Amount, u64, u64, Amount)> {
            self.budgets.get(&budget_key(&did, &owner)).copied()
        }

        /// Spends from (`did`, `owner`)'s budget on the tip described by a post in `did`'s repo, shaped
        /// `@bot tip @recipient 5`. Anyone may submit it: the post's signature is the authority. Each post
        /// can be spent once (strictly increasing rkey). The tip becomes a ClaimPolicy deposit for the
        /// recipient.
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
            let key = budget_key(&did, &owner);
            let (balance, window, refund_after, max_tip) = *self.budgets.get(&key).expect("no such budget");
            assert!(rkey.len() == 13, "tip posts have 13-character record keys");
            if let Some(last) = self.last_tip.get(&did) {
                assert!(rkey.as_str() > last.as_str(), "this post, or a later one, was already spent");
            }
            assert!(!ops.is_empty(), "empty operation chain");
            assert!(commit.len() <= MAX_BLOCK_LEN && record.len() <= MAX_BLOCK_LEN, "block too large");
            let ops_s = slices(&ops, MAX_OPS);
            let nodes = slices(&mst_nodes, MAX_NODES);
            let chain = atp_verify::verify_plc_chain(&did, &ops_s).expect("invalid operation chain");
            // A tip post spends the tipper's budget, so a rotated-away key must not be able to sign one.
            let (floor, floor_tip): (u32, Bytes) = ComponentManager::get(self.link_registry).call("chain_pin", args![did.clone()]);
            assert!(chain.extends(floor, floor_tip.as_slice()), "stale operation chain: a longer or different one has been seen");
            atp_verify::verify_record(&did, &chain.signing_key, commit.as_slice(), &nodes, record.as_slice(), POST, &rkey)
                .expect("invalid repo proof");
            let (recipient, micro) = atp_verify::tip::parse_tip(record.as_slice(), &self.bot_did).expect("not a tip post");
            let amount = Amount::from(micro);
            assert!(recipient != did, "cannot tip yourself");
            assert!(amount <= max_tip, "tip above this budget's per-tip limit");
            assert!(balance >= amount, "budget too small for this tip");

            let left = balance - amount;
            if left.is_zero() {
                self.budgets.remove(&key);
            } else {
                self.budgets.get_mut(&key).unwrap().0 = left;
            }
            self.last_tip.insert(did, rkey);

            // metadata in ClaimPolicy's layout: window ++ hold(0) ++ no phrase
            let mut metadata = window.to_be_bytes().to_vec();
            metadata.extend_from_slice(&0u64.to_be_bytes());
            let refund_epoch = Consensus::current_epoch() + refund_after;
            let funds = self.budget_vault.withdraw(amount);
            let proof = self.badge_vault.create_proof();
            ComponentManager::get(self.escrow).invoke(
                "policy_deposit",
                args![proof, recipient, owner, refund_epoch, self.claim_policy, Bytes::from_vec(metadata), funds],
            );
            proof.drop();
        }
    }
}
