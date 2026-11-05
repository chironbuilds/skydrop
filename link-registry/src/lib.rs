//   SPDX-License-Identifier: BSD-3-Clause

//! LinkRegistry: binds a Bluesky `did:plc` to an Ootle account with one signed post, so policies can pay a
//! bound account's funds straight to its wallet. It is a shared, read-only-for-others registry — it holds
//! no funds. Policies (ClaimPolicy, TipPolicy) call `active_binding` to find where a bound account's
//! payouts should go.
//!
//! The post's signature is the authority, so anyone may submit a binding. A first binding applies at once
//! (when the registry's delay is zero); a replacement waits `bind_delay` epochs, during which anyone may
//! `challenge_bind` it with a longer/different identity chain, and a post can be used once (rkey must
//! increase), so an old post cannot move the binding back.

use atp_verify::sha256;
use tari_template_lib::{prelude::*, types::crypto::RistrettoPublicKeyBytes};

const BIND_DOMAIN: &[u8] = b"tari-bsky-bind:v1:";
const COLLECTION: &str = "app.bsky.feed.post";
const MAX_OPS: usize = 16;
const MAX_NODES: usize = 32;
const MAX_BLOCK_LEN: usize = 16 * 1024;

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

fn slices(items: &[Bytes], max: usize) -> Vec<&[u8]> {
    assert!(items.len() <= max, "too many blocks");
    assert!(items.iter().all(|b| b.len() <= MAX_BLOCK_LEN), "block too large");
    items.iter().map(|b| b.as_slice()).collect()
}

#[template]
mod link_registry {
    use std::collections::BTreeMap;

    use super::*;

    pub struct LinkRegistry {
        /// did -> (bound account, epoch it takes effect, the account it replaces, owner key of the new
        /// binding, owner key of the one it replaces). The registry's own address is the "nothing" sentinel.
        bindings: BTreeMap<String, (ComponentAddress, u64, ComponentAddress, RistrettoPublicKeyBytes, RistrettoPublicKeyBytes)>,
        /// did -> (tip of the chain a binding relied on, its length), so a longer/different chain can cancel it.
        bind_proof: BTreeMap<String, (Bytes, u32)>,
        /// did -> rkey of the last bind post used; a later one must be larger.
        last_bind: BTreeMap<String, String>,
        /// did -> longest valid chain seen.
        known_len: BTreeMap<String, u32>,
        /// Epochs a replacement binding waits before taking effect.
        bind_delay: u64,
    }

    impl LinkRegistry {
        pub fn new(bind_delay: u64) -> Component<Self> {
            Component::new(Self {
                bindings: BTreeMap::new(),
                bind_proof: BTreeMap::new(),
                last_bind: BTreeMap::new(),
                known_len: BTreeMap::new(),
                bind_delay,
            })
            .with_access_rules(AccessRules::allow_all())
            .create()
        }

        /// The exact text an owner must post to bind `did` to `address`.
        pub fn expected_bind_text(&self, did: String, address: ComponentAddress, owner: RistrettoPublicKeyBytes) -> String {
            bind_code(&CallerContext::current_component_address().to_string(), &did, &address, &owner)
        }

        /// The account `did` is bound to, if a binding is in effect.
        pub fn binding_for(&self, did: String) -> Option<ComponentAddress> {
            self.active_binding_full(&did).map(|b| b.0)
        }

        /// The bound account and its owner key, if a binding is in effect (for policies to route payouts).
        pub fn active_binding(&self, did: String) -> Option<(ComponentAddress, RistrettoPublicKeyBytes)> {
            self.active_binding_full(&did)
        }

        /// The longest valid operation chain seen for `did` (0 if none). Every policy that accepts a repo
        /// proof refuses one made with a shorter chain: once a key rotation has been observed here (by any
        /// bind, challenge, or `observe_chain`), a rotated-away — possibly stolen — key proves nothing anywhere.
        pub fn chain_floor(&self, did: String) -> u32 {
            self.known_len.get(&did).copied().unwrap_or(0)
        }

        /// Binds `did` to the Ootle account `address`. The authority is a post in `did`'s repo containing the
        /// bind code; anyone may submit it. A first binding applies after `bind_delay`; a replacement keeps
        /// the old one working until it takes effect.
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
            assert!(!ops.is_empty(), "empty operation chain");
            assert!(commit.len() <= MAX_BLOCK_LEN && record.len() <= MAX_BLOCK_LEN, "block too large");
            let ops_s = slices(&ops, MAX_OPS);
            let nodes = slices(&mst_nodes, MAX_NODES);
            let chain = atp_verify::verify_plc_chain(&did, &ops_s).expect("invalid operation chain");
            if let Some(&k) = self.known_len.get(&did) {
                assert!(chain.len >= k, "stale operation chain: a longer one has been seen");
            }
            atp_verify::verify_record(&did, &chain.signing_key, commit.as_slice(), &nodes, record.as_slice(), COLLECTION, &rkey)
                .expect("invalid repo proof");
            let text = atp_verify::record_text(record.as_slice()).expect("record has no text");
            let me = CallerContext::current_component_address();
            let code = bind_code(&me.to_string(), &did, &address, &owner);
            assert!(text.contains(&code), "the post does not contain the bind code");
            // Payouts are sent by calling the address, so it must be an ordinary account template, not a
            // component written to fail or take the call over.
            assert!(
                ComponentManager::get(address).get_template_address() == TemplateAddress::from_array([0; 32]),
                "only a standard Tari account can be linked"
            );

            let now = Consensus::current_epoch();
            let entry = match self.active_binding_full(&did) {
                Some((c, co)) if c == address && co == owner => (address, now, address, owner, owner),
                Some((c, co)) => (address, now + self.bind_delay, c, owner, co),
                None => (address, now + self.bind_delay, me, owner, owner),
            };
            self.known_len.insert(did.clone(), chain.len);
            self.last_bind.insert(did.clone(), rkey);
            self.bind_proof.insert(did.clone(), (Bytes::from_vec(chain.tip.to_vec()), chain.len));
            self.bindings.insert(did, entry);
        }

        /// Cancels a binding that has not taken effect yet, with a valid chain at least as long as and
        /// different from the one it relied on (e.g. a key rotation the binder left out). Anyone may call.
        pub fn challenge_bind(&mut self, did: String, ops: Vec<Bytes>) {
            let (_, since, old, _, old_owner) = self.bindings.get(&did).cloned().expect("no binding");
            assert!(Consensus::current_epoch() < since, "the binding is already in effect");
            let (tip, len) = self.bind_proof.get(&did).cloned().expect("no binding");
            let ops_s = slices(&ops, MAX_OPS);
            let chain = atp_verify::verify_plc_chain(&did, &ops_s).expect("invalid operation chain");
            assert!(chain.len >= len, "that chain is shorter than the one the binding relied on");
            assert!(chain.tip.as_slice() != tip.as_slice(), "that is the chain the binding already relies on");
            self.known_len.entry(did.clone()).and_modify(|l| *l = (*l).max(chain.len)).or_insert(chain.len);
            let me = CallerContext::current_component_address();
            if old == me {
                self.bindings.remove(&did);
            } else {
                self.bindings.insert(did.clone(), (old, 0, old, old_owner, old_owner));
            }
            self.bind_proof.remove(&did);
        }

        /// Records the longest chain seen for `did`, so stale proofs are refused from then on. Anyone may call.
        pub fn observe_chain(&mut self, did: String, ops: Vec<Bytes>) {
            let ops_s = slices(&ops, MAX_OPS);
            let chain = atp_verify::verify_plc_chain(&did, &ops_s).expect("invalid operation chain");
            self.known_len.entry(did).and_modify(|l| *l = (*l).max(chain.len)).or_insert(chain.len);
        }

        fn active_binding_full(&self, did: &str) -> Option<(ComponentAddress, RistrettoPublicKeyBytes)> {
            let (address, since, old, owner, old_owner) = self.bindings.get(did)?;
            let me = CallerContext::current_component_address();
            if Consensus::current_epoch() >= *since {
                Some((*address, *owner))
            } else if *old == me {
                None
            } else {
                Some((*old, *old_owner))
            }
        }
    }
}
