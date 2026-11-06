//   SPDX-License-Identifier: BSD-3-Clause

//! EngagementBounty: a policy that pays a pool to everyone who likes, reposts (retweets) or follows a
//! target on Bluesky. It shows the layer scaled to many claimants on one permanent Escrow.
//!
//! * The funder escrows a **pool of equal slots** (deposits) under one campaign id, each slot's opaque
//!   metadata holding `[kind byte][target]` — kind 0 = like, 1 = repost, 2 = follow (target = the post
//!   uri or followed DID), 3 = **proof of post** (target = text the post must contain, e.g. a hashtag).
//! * A campaign id is `<funder key hex>:<name>`, and only slots deposited by that funder count. Anyone can
//!   deposit for any id, so without this a stranger could put an unclaimable slot at the front of someone
//!   else's campaign and make every claim fail.
//! * A claimant proves two records in their own repo: the engagement itself (whose `subject` is the
//!   campaign target, or a post containing it), and a claim-code post that **binds the payout to their
//!   own wallet** so a bystander cannot claim someone else's repost to their address. For proof of post the
//!   two may be the same post.
//! * One claim per account per campaign. When the slots run out the bounty is closed; unclaimed slots are
//!   refundable to the funder after their refund epoch.

use atp_verify::sha256;
use tari_template_lib::{prelude::*, types::crypto::RistrettoPublicKeyBytes};

const CODE_DOMAIN: &[u8] = b"tari-bsky-claim:v1:";
const POST: &str = "app.bsky.feed.post";
const MAX_OPS: usize = 16;
const MAX_NODES: usize = 32;
const MAX_BLOCK_LEN: usize = 16 * 1024;

/// Escrow's deposit tuple, mirrored so `deposits_for` decodes: (sender, amount, refund epoch, policy,
/// metadata, epoch it was made).
type Deposit = (RistrettoPublicKeyBytes, Amount, u64, ComponentAddress, Bytes, u64);

fn require_signer(key: RistrettoPublicKeyBytes) {
    CallerContext::assert_badge_in_scope(&NonFungibleAddress::from_public_key(key));
}

fn collection(kind: u8) -> &'static str {
    match kind {
        0 => "app.bsky.feed.like",
        1 => "app.bsky.feed.repost",
        2 => "app.bsky.graph.follow",
        3 => POST,
        _ => panic!("unknown engagement kind"),
    }
}

fn key_hex(key: &RistrettoPublicKeyBytes) -> String {
    let mut s = String::new();
    for b in key.into_array() {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// The funder key (hex) a campaign id `<funder key hex>:<name>` names.
fn campaign_funder(campaign: &str) -> &str {
    let (funder, name) = campaign.split_once(':').expect("a campaign id is <funder key hex>:<name>");
    assert!(funder.len() == 64 && funder.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()), "a campaign id is <funder key hex>:<name>");
    assert!(!name.is_empty(), "a campaign id is <funder key hex>:<name>");
    funder
}

/// Whether escrow deposit `d` is one of `campaign`'s slots: governed by this policy and made by its funder.
fn is_slot(d: &Deposit, me: &ComponentAddress, funder: &str) -> bool {
    d.3 == *me && key_hex(&d.0) == funder
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
mod engagement_bounty {
    use std::collections::{BTreeMap, BTreeSet};

    use super::*;

    pub struct EngagementBounty {
        escrow: ComponentAddress,
        badge_vault: Vault,
        /// campaign id -> the DIDs that have already claimed it.
        claimed: BTreeMap<String, BTreeSet<String>>,
        /// The LinkRegistry whose `chain_pin` a claim's operation chain must reach.
        link_registry: ComponentAddress,
    }

    impl EngagementBounty {
        pub fn new(escrow: ComponentAddress, badge_resource: ResourceAddress, link_registry: ComponentAddress) -> Component<Self> {
            Component::new(Self { escrow, badge_vault: Vault::new_empty(badge_resource), claimed: BTreeMap::new(), link_registry })
                .with_owner_rule(OwnerRule::None)
                .with_access_rules(AccessRules::allow_all())
                .create()
        }

        pub fn receive_badge(&mut self, badge: Bucket) {
            self.badge_vault.deposit(badge);
        }

        /// The text an engager must post so the payout binds to their wallet `claimant`.
        pub fn expected_post_text(&self, did: String, claimant: RistrettoPublicKeyBytes) -> String {
            claim_code(&CallerContext::current_component_address().to_string(), &did, &claimant)
        }

        /// How many unclaimed slots remain in `campaign`.
        pub fn slots_left(&self, campaign: String) -> u32 {
            let me = CallerContext::current_component_address();
            let funder = campaign_funder(&campaign).to_string();
            let deps: Vec<Deposit> = ComponentManager::get(self.escrow).call("deposits_for", args![campaign]);
            deps.iter().filter(|d| is_slot(d, &me, &funder)).count() as u32
        }

        /// Claims one bounty slot for `claimant` (who signs). `e_*` prove the engagement record; `c_*`
        /// prove the claim-code post that binds the payout. Returns the slot's funds.
        #[allow(clippy::too_many_arguments)]
        pub fn claim(
            &mut self,
            campaign: String,
            did: String,
            claimant: RistrettoPublicKeyBytes,
            ops: Vec<Bytes>,
            e_commit: Bytes,
            e_nodes: Vec<Bytes>,
            e_record: Bytes,
            e_rkey: String,
            c_commit: Bytes,
            c_nodes: Vec<Bytes>,
            c_record: Bytes,
            c_rkey: String,
        ) -> Bucket {
            require_signer(claimant);
            // one claim per account per campaign
            let done = self.claimed.entry(campaign.clone()).or_default();
            assert!(done.insert(did.clone()), "this account already claimed this bounty");

            let me = CallerContext::current_component_address();
            let funder = campaign_funder(&campaign).to_string();
            let deps: Vec<Deposit> = ComponentManager::get(self.escrow).call("deposits_for", args![campaign.clone()]);
            let (idx, meta) = deps
                .iter()
                .enumerate()
                .find(|(_, d)| is_slot(d, &me, &funder))
                .map(|(i, d)| (i as u32, d.4.clone()))
                .expect("this bounty is exhausted");
            let m = meta.as_slice();
            assert!(m.len() >= 2, "slot metadata must be [kind][target]");
            let kind = m[0];
            let target = String::from_utf8(m[1..].to_vec()).expect("target uri not utf-8");

            assert!(!ops.is_empty(), "empty operation chain");
            assert!(e_commit.len() <= MAX_BLOCK_LEN && e_record.len() <= MAX_BLOCK_LEN, "block too large");
            assert!(c_commit.len() <= MAX_BLOCK_LEN && c_record.len() <= MAX_BLOCK_LEN, "block too large");
            let ops_s = slices(&ops, MAX_OPS);
            let chain = atp_verify::verify_plc_chain(&did, &ops_s).expect("invalid operation chain");
            let (floor, floor_tip): (u32, Bytes) = ComponentManager::get(self.link_registry).call("chain_pin", args![did.clone()]);
            assert!(chain.extends(floor, floor_tip.as_slice()), "stale operation chain: a longer or different one has been seen");

            // 1. the claim-code post binds the payout to this claimant's key (no front-running)
            let c_nodes_s = slices(&c_nodes, MAX_NODES);
            atp_verify::verify_record(&did, &chain.signing_key, c_commit.as_slice(), &c_nodes_s, c_record.as_slice(), POST, &c_rkey)
                .expect("invalid claim-code proof");
            let text = atp_verify::record_text(c_record.as_slice()).expect("claim post has no text");
            let code = claim_code(&me.to_string(), &did, &claimant);
            assert!(text.contains(&code), "the post does not contain the claim code");

            // 2. the engagement itself points at the campaign target
            let e_nodes_s = slices(&e_nodes, MAX_NODES);
            atp_verify::verify_record(&did, &chain.signing_key, e_commit.as_slice(), &e_nodes_s, e_record.as_slice(), collection(kind), &e_rkey)
                .expect("invalid engagement proof");
            if kind == 3 {
                // proof of post: the post's text carries the campaign's required text
                assert!(atp_verify::field_contains(e_record.as_slice(), &["text"], &target), "the post does not contain the required text");
            } else {
                let subject = if kind == 2 {
                    // follow: `subject` is the followed DID
                    atp_verify::field_str(e_record.as_slice(), &["subject"]).expect("follow has no subject")
                } else {
                    // like / repost: `subject.uri` is the post
                    atp_verify::field_str(e_record.as_slice(), &["subject", "uri"]).expect("engagement has no subject uri")
                };
                assert!(subject == target, "engagement is not for the campaign target");
            }

            // 3. release one slot to the bound claimant
            let proof = self.badge_vault.create_proof();
            let paid: Bucket = ComponentManager::get(self.escrow).call("release", args![proof, campaign, idx]);
            proof.drop();
            paid
        }
    }
}
