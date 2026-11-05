//   SPDX-License-Identifier: BSD-3-Clause

//! ListDrop: an airdrop to the members of a Bluesky **list** — an org's team, a DAO's contributors, a
//! conference's speakers. It is the safe form of a "handle allowlist".
//!
//! Why not gate on handles? An account's PLC chain *asserts* handles in `alsoKnownAs`, but anyone can
//! assert any handle in their own chain (`ceo.yourorg.com` included); that the handle resolves back is
//! DNS/HTTPS the chain does not anchor. Membership must instead be vouched for by the org, in a record the
//! org signs. A Bluesky list is exactly that: each `app.bsky.graph.listitem` in the **org's** repo names a
//! member DID and the list it belongs to.
//!
//! * The funder escrows a pool of equal slots under a campaign id `<funder key hex>:<name>` (only the
//!   funder's own deposits count, as in EngagementBounty). Each slot's metadata is
//!   `snapshot (8 BE, µs since the Unix epoch) ++ list uri` (`at://<org did>/app.bsky.graph.list/<rkey>`).
//! * A member claims by proving (1) a listitem in the org's repo whose `subject` is their DID and whose
//!   `list` is the campaign list, from a commit made at or after the snapshot — so items the org created and
//!   deleted before the campaign count for nothing — and (2) a claim-code post in their own repo that binds
//!   the payout to their wallet, so nobody can claim a member's slot to another address.
//! * One claim per account per campaign. Both chains (member and org) must reach the shared LinkRegistry's
//!   chain floor, so a rotated-away key of either proves nothing.
//! * A record proof shows the item existed at that commit, not that it still does: someone removed from
//!   the list *after* the snapshot can still claim with a commit from between. Pick the snapshot as the
//!   moment the list is final.

use atp_verify::sha256;
use tari_template_lib::{prelude::*, types::crypto::RistrettoPublicKeyBytes};

const CODE_DOMAIN: &[u8] = b"tari-bsky-listdrop:v1:";
const POST: &str = "app.bsky.feed.post";
const LISTITEM: &str = "app.bsky.graph.listitem";
const MAX_OPS: usize = 16;
const MAX_NODES: usize = 32;
const MAX_BLOCK_LEN: usize = 16 * 1024;

/// Escrow's deposit tuple, mirrored so `deposits_for` decodes: (sender, amount, refund epoch, policy,
/// metadata, epoch it was made).
type Deposit = (RistrettoPublicKeyBytes, Amount, u64, ComponentAddress, Bytes, u64);

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

/// The funder key (hex) a campaign id `<funder key hex>:<name>` names.
fn campaign_funder(campaign: &str) -> &str {
    let (funder, name) = campaign.split_once(':').expect("a campaign id is <funder key hex>:<name>");
    assert!(funder.len() == 64 && funder.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()), "a campaign id is <funder key hex>:<name>");
    assert!(!name.is_empty(), "a campaign id is <funder key hex>:<name>");
    funder
}

fn is_slot(d: &Deposit, me: &ComponentAddress, funder: &str) -> bool {
    d.3 == *me && key_hex(&d.0) == funder
}

/// Slot metadata: the snapshot time and the list uri, plus the org DID the uri names.
struct Terms {
    snapshot: u64,
    list: String,
    org: String,
}

fn terms_of(meta: &Bytes) -> Terms {
    let m = meta.as_slice();
    assert!(m.len() > 8, "slot metadata must be snapshot ++ list uri");
    let snapshot = u64::from_be_bytes(m[..8].try_into().unwrap());
    let list = String::from_utf8(m[8..].to_vec()).expect("list uri not utf-8");
    let rest = list.strip_prefix("at://").expect("list uri must be at://<org did>/app.bsky.graph.list/<rkey>");
    let (org, path) = rest.split_once('/').expect("list uri must be at://<org did>/app.bsky.graph.list/<rkey>");
    let rkey = path.strip_prefix("app.bsky.graph.list/").expect("list uri must name an app.bsky.graph.list");
    assert!(org.starts_with("did:plc:") && !rkey.is_empty() && !rkey.contains('/'), "list uri must be at://<did:plc>/app.bsky.graph.list/<rkey>");
    let org = String::from(org);
    Terms { snapshot, list, org }
}

fn claim_code(component: &str, campaign: &str, did: &str, claimant: &RistrettoPublicKeyBytes) -> String {
    let mut data = CODE_DOMAIN.to_vec();
    data.extend_from_slice(component.as_bytes());
    data.push(b':');
    data.extend_from_slice(campaign.as_bytes());
    data.push(b':');
    data.extend_from_slice(did.as_bytes());
    data.push(b':');
    data.extend_from_slice(&claimant.into_array());
    let digest = sha256(&data);
    let mut s = String::from("tari-drop:");
    for b in &digest[..16] {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn slices(items: &[Bytes], max: usize) -> Vec<&[u8]> {
    assert!(!items.is_empty() && items.len() <= max, "bad block count");
    assert!(items.iter().all(|b| b.len() <= MAX_BLOCK_LEN), "block too large");
    items.iter().map(|b| b.as_slice()).collect()
}

#[template]
mod list_drop {
    use std::collections::{BTreeMap, BTreeSet};

    use super::*;

    pub struct ListDrop {
        escrow: ComponentAddress,
        badge_vault: Vault,
        /// campaign id -> the DIDs that have already claimed it.
        claimed: BTreeMap<String, BTreeSet<String>>,
        /// The LinkRegistry whose `chain_floor` both chains must reach.
        link_registry: ComponentAddress,
    }

    impl ListDrop {
        pub fn new(escrow: ComponentAddress, badge_resource: ResourceAddress, link_registry: ComponentAddress) -> Component<Self> {
            Component::new(Self { escrow, badge_vault: Vault::new_empty(badge_resource), claimed: BTreeMap::new(), link_registry })
                .with_access_rules(AccessRules::allow_all())
                .create()
        }

        pub fn receive_badge(&mut self, badge: Bucket) {
            self.badge_vault.deposit(badge);
        }

        /// The text a member must post so their `campaign` payout binds to the wallet key `claimant`.
        pub fn expected_post_text(&self, campaign: String, did: String, claimant: RistrettoPublicKeyBytes) -> String {
            claim_code(&CallerContext::current_component_address().to_string(), &campaign, &did, &claimant)
        }

        /// How many unclaimed slots remain in `campaign`.
        pub fn slots_left(&self, campaign: String) -> u32 {
            let me = CallerContext::current_component_address();
            let funder = campaign_funder(&campaign).to_string();
            let deps: Vec<Deposit> = ComponentManager::get(self.escrow).call("deposits_for", args![campaign]);
            deps.iter().filter(|d| is_slot(d, &me, &funder)).count() as u32
        }

        pub fn has_claimed(&self, campaign: String, did: String) -> bool {
            self.claimed.get(&campaign).is_some_and(|s| s.contains(&did))
        }

        /// Claims one slot for member `did`, paid to `claimant` (who signs). `org_ops` is the org's PLC
        /// chain; `l_*` prove the listitem in the org's repo; `c_*` prove the claim-code post in `did`'s.
        #[allow(clippy::too_many_arguments)]
        pub fn claim(
            &mut self,
            campaign: String,
            did: String,
            claimant: RistrettoPublicKeyBytes,
            ops: Vec<Bytes>,
            org_ops: Vec<Bytes>,
            l_commit: Bytes,
            l_nodes: Vec<Bytes>,
            l_record: Bytes,
            l_rkey: String,
            c_commit: Bytes,
            c_nodes: Vec<Bytes>,
            c_record: Bytes,
            c_rkey: String,
        ) -> Bucket {
            require_signer(claimant);
            let done = self.claimed.entry(campaign.clone()).or_default();
            assert!(done.insert(did.clone()), "this account already claimed this drop");

            let me = CallerContext::current_component_address();
            let funder = campaign_funder(&campaign).to_string();
            let deps: Vec<Deposit> = ComponentManager::get(self.escrow).call("deposits_for", args![campaign.clone()]);
            let (idx, meta) = deps
                .iter()
                .enumerate()
                .find(|(_, d)| is_slot(d, &me, &funder))
                .map(|(i, d)| (i as u32, d.4.clone()))
                .expect("this drop is exhausted");
            let terms = terms_of(&meta);
            assert!(did != terms.org, "the org cannot claim its own drop");
            for b in [&l_commit, &l_record, &c_commit, &c_record] {
                assert!(b.len() <= MAX_BLOCK_LEN, "block too large");
            }
            let registry = ComponentManager::get(self.link_registry);

            // 1. the org vouches: a listitem in the org's repo, for this member, on this list, from a commit
            //    made at or after the snapshot
            let org_chain = atp_verify::verify_plc_chain(&terms.org, &slices(&org_ops, MAX_OPS)).expect("invalid org operation chain");
            let org_floor: u32 = registry.call("chain_floor", args![terms.org.clone()]);
            assert!(org_chain.len >= org_floor, "stale org operation chain: a longer one has been seen");
            atp_verify::verify_record(&terms.org, &org_chain.signing_key, l_commit.as_slice(), &slices(&l_nodes, MAX_NODES), l_record.as_slice(), LISTITEM, &l_rkey)
                .expect("invalid listitem proof");
            assert!(atp_verify::field_eq(l_record.as_slice(), &["subject"], &did), "that list item is for another account");
            assert!(atp_verify::field_eq(l_record.as_slice(), &["list"], &terms.list), "that list item is on another list");
            let rev = atp_verify::commit_rev_micros(l_commit.as_slice()).expect("bad org commit rev");
            assert!(rev >= terms.snapshot, "the list proof predates the drop's snapshot");

            // 2. the member binds the payout to their own wallet key (no front-running)
            let chain = atp_verify::verify_plc_chain(&did, &slices(&ops, MAX_OPS)).expect("invalid operation chain");
            let floor: u32 = registry.call("chain_floor", args![did.clone()]);
            assert!(chain.len >= floor, "stale operation chain: a longer one has been seen");
            atp_verify::verify_record(&did, &chain.signing_key, c_commit.as_slice(), &slices(&c_nodes, MAX_NODES), c_record.as_slice(), POST, &c_rkey)
                .expect("invalid claim-code proof");
            let text = atp_verify::record_text(c_record.as_slice()).expect("claim post has no text");
            assert!(text.contains(&claim_code(&me.to_string(), &campaign, &did, &claimant)), "the post does not contain the claim code");

            // 3. release one slot to the bound claimant
            let proof = self.badge_vault.create_proof();
            let paid: Bucket = ComponentManager::get(self.escrow).call("release", args![proof, campaign, idx]);
            proof.drop();
            paid
        }
    }
}
