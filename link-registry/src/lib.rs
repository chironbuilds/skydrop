//   SPDX-License-Identifier: BSD-3-Clause

//! LinkRegistry: binds a Bluesky `did:plc` to an Ootle account with one signed post, so policies can pay a
//! bound account's funds straight to its wallet. It is a shared, read-only-for-others registry — it holds
//! no funds. Policies (ClaimPolicy, TipPolicy) call `active_binding` to find where a bound account's
//! payouts should go, and every policy that accepts a repo proof calls `chain_pin`.
//!
//! The post's signature is the authority, so anyone may submit a binding. A first binding applies at once
//! (when the registry's delay is zero); a replacement waits `bind_delay` epochs, during which anyone may
//! `challenge_bind` it with a longer/different identity chain, and a post can be used once (rkey must
//! increase), so an old post cannot move the binding back.
//!
//! **Each DID's data lives in its own record NFT, not in this component.** A substate is capped at 1 MiB and identities
//! can be made for free, so shared maps could be filled for the cost of the fees, which would raise the cost of every
//! claim that reads the registry and then stop new key rotations being recorded. So:
//!
//! * A DID's record is created by `open_account`, which anyone may call and the caller pays for. Reading a record that
//!   doesn't exist fails the transaction, because the engine can't ask whether an NFT exists. A client whose claim
//!   involves a new DID sends `open_account` in the same transaction.
//! * This can't be used to dodge a floor. There is no way to read "no record" and carry on: a floor is either read from
//!   the record, or the transaction fails. An account never seen has a floor of 0 either way.
//! * Records are held in a vault that's replaced after `record_vault_size` DIDs, so that doesn't grow without limit.
//!
//! **A chain has to carry on from the one seen, not just be as long.** Whoever holds a rotated-away rotation key, such as
//! a stolen key or an old host's, can sign a fork of any length, so length proves nothing. Each record pins the newest
//! chain seen, by its length and last operation, and a later chain must contain that operation.
//!
//! So the first chain seen wins, and that needs a way back: an account may have really undone an attacker's operation.
//! `resolve_fork` lets the chain signed with the higher-priority rotation key at the split replace the pinned one, which
//! is PLC's own rule. PLC also limits that to 72 hours, which can't be checked here. A fork made before any chain has been
//! seen, or by a key of higher priority than the real signer's, is still accepted: someone has to observe accounts.

use atp_verify::sha256;
use tari_template_lib::{prelude::*, types::crypto::RistrettoPublicKeyBytes};

const BIND_DOMAIN: &[u8] = b"tari-bsky-bind:v1:";
const COLLECTION: &str = "app.bsky.feed.post";
const MAX_OPS: usize = 16;
const MAX_NODES: usize = 32;
const MAX_BLOCK_LEN: usize = 16 * 1024;
const MAX_DID: usize = 256;
/// The most ids a record vault may hold before it's replaced. Each id takes about 40 bytes of a 1 MiB substate.
const MAX_RECORD_VAULT_SIZE: u32 = 20_000;

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

fn record_id(did: &str) -> NonFungibleId {
    NonFungibleId::from_u256(sha256(did.as_bytes()))
}

/// (bound account, epoch it takes effect, the account it replaces, owner key of the new binding, owner key of the one
/// it replaces). The registry's own address is the "nothing" sentinel.
type Binding = (ComponentAddress, u64, ComponentAddress, RistrettoPublicKeyBytes, RistrettoPublicKeyBytes);
/// The newest chain seen for a DID: its length and last operation. Length 0 and an empty tip mean none yet.
type Pin = (u32, Bytes);
/// One DID's mutable data: its binding; the tip and length of the chain the binding relied on, so a longer or different
/// chain can cancel it; the rkey of the last bind post used; the newest chain seen.
type Record = (Option<Binding>, Option<(Bytes, u32)>, Option<String>, Pin);

fn pin_of(chain: &atp_verify::ChainInfo) -> Pin {
    (chain.len, Bytes::from_vec(chain.tip.to_vec()))
}

#[template]
mod link_registry {
    use super::*;

    pub struct LinkRegistry {
        /// Epochs a replacement binding waits before taking effect.
        bind_delay: u64,
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

    impl LinkRegistry {
        pub fn new(bind_delay: u64, record_vault_size: u32) -> Component<Self> {
            assert!(record_vault_size >= 1 && record_vault_size <= MAX_RECORD_VAULT_SIZE, "record vault size out of range");
            let badge_id = NonFungibleId::from_u32(0);
            let record_badge = ResourceBuilder::non_fungible().with_owner_rule(OwnerRule::None).initial_supply([badge_id.clone()]);
            let badge_address = NonFungibleAddress::new(record_badge.resource_address(), badge_id);
            let records = ResourceBuilder::non_fungible()
                .with_owner_rule(OwnerRule::None)
                .with_token_symbol("SKYLINK")
                .mintable(rule!(non_fungible(badge_address.clone())), rule!(deny_all))
                .update_non_fungible_data(rule!(non_fungible(badge_address)), rule!(deny_all))
                .withdrawable(rule!(deny_all), rule!(deny_all))
                .build();
            Component::new(Self {
                bind_delay,
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
            let empty: Record = (None, None, None, (0, Bytes::from_vec(Vec::new())));
            let record = self.record_badge.authorize_with(|| manager.mint_non_fungible(record_id(&did), &did, &empty));
            self.record_vault.deposit(record);
            self.record_vault_count += 1;
            self.accounts += 1;
        }

        /// The exact text an owner must post to bind `did` to `address`.
        pub fn expected_bind_text(&self, did: String, address: ComponentAddress, owner: RistrettoPublicKeyBytes) -> String {
            bind_code(&CallerContext::current_component_address().to_string(), &did, &address, &owner)
        }

        /// The account `did` is bound to, if a binding is in effect. Fails if `did` has no record.
        pub fn binding_for(&self, did: String) -> Option<ComponentAddress> {
            self.active_binding_full(&did).map(|b| b.0)
        }

        /// The bound account and its owner key, if a binding is in effect (for policies to route payouts).
        pub fn active_binding(&self, did: String) -> Option<(ComponentAddress, RistrettoPublicKeyBytes)> {
            self.active_binding_full(&did)
        }

        /// The length of the newest operation chain seen for `did`. Fails if `did` has no record.
        pub fn chain_floor(&self, did: String) -> u32 {
            self.read(&did).3.0
        }

        /// The newest operation chain seen for `did`. Every policy that accepts a repo proof refuses a chain that doesn't
        /// carry on from it (`ChainInfo::extends`): once a chain has been observed here (by any bind, challenge, or
        /// `observe_chain`), a rotated-away, possibly stolen, key proves nothing anywhere, however long a fork it signs.
        /// Fails if `did` has no record, so a claim for a new DID sends `open_account` first.
        pub fn chain_pin(&self, did: String) -> (u32, Bytes) {
            self.read(&did).3
        }

        pub fn account_count(&self) -> u64 {
            self.accounts
        }

        pub fn record_resource(&self) -> ResourceAddress {
            self.records
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
            let (_, _, last_bind, known) = self.read(&did);
            if let Some(last) = &last_bind {
                assert!(rkey.as_str() > last.as_str(), "this post, or a later one, was already used to bind");
            }
            assert!(!ops.is_empty(), "empty operation chain");
            assert!(commit.len() <= MAX_BLOCK_LEN && record.len() <= MAX_BLOCK_LEN, "block too large");
            let ops_s = slices(&ops, MAX_OPS);
            let nodes = slices(&mst_nodes, MAX_NODES);
            let chain = atp_verify::verify_plc_chain(&did, &ops_s).expect("invalid operation chain");
            assert!(chain.extends(known.0, known.1.as_slice()), "stale operation chain: a longer or different one has been seen");
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
            let entry: Binding = match self.active_binding_full(&did) {
                Some((c, co)) if c == address && co == owner => (address, now, address, owner, owner),
                Some((c, co)) => (address, now + self.bind_delay, c, owner, co),
                None => (address, now + self.bind_delay, me, owner, owner),
            };
            let updated: Record = (Some(entry), Some((Bytes::from_vec(chain.tip.to_vec()), chain.len)), Some(rkey), pin_of(&chain));
            self.write(&did, &updated);
        }

        /// Cancels a binding that has not taken effect yet, with a valid chain at least as long as and
        /// different from the one it relied on (e.g. a key rotation the binder left out). Anyone may call.
        pub fn challenge_bind(&mut self, did: String, ops: Vec<Bytes>) {
            let (binding, proof, last_bind, known) = self.read(&did);
            let (_, since, old, _, old_owner) = binding.expect("no binding");
            assert!(Consensus::current_epoch() < since, "the binding is already in effect");
            let (tip, len) = proof.expect("no binding");
            let ops_s = slices(&ops, MAX_OPS);
            let chain = atp_verify::verify_plc_chain(&did, &ops_s).expect("invalid operation chain");
            assert!(chain.len >= len, "that chain is shorter than the one the binding relied on");
            assert!(chain.tip.as_slice() != tip.as_slice(), "that is the chain the binding already relies on");
            let me = CallerContext::current_component_address();
            let restored: Option<Binding> = if old == me { None } else { Some((old, 0, old, old_owner, old_owner)) };
            // A chain that carries on from the pin moves it. A fork still cancels the binding but moves nothing.
            let pin = if chain.extends(known.0, known.1.as_slice()) { pin_of(&chain) } else { known };
            let updated: Record = (restored, None, last_bind, pin);
            self.write(&did, &updated);
        }

        /// Records the newest chain seen for `did`, so stale proofs and forks are refused from then on. Anyone may call.
        pub fn observe_chain(&mut self, did: String, ops: Vec<Bytes>) {
            let ops_s = slices(&ops, MAX_OPS);
            let chain = atp_verify::verify_plc_chain(&did, &ops_s).expect("invalid operation chain");
            let (binding, proof, last_bind, known) = self.read(&did);
            assert!(chain.extends(known.0, known.1.as_slice()), "stale operation chain: a longer or different one has been seen");
            let updated: Record = (binding, proof, last_bind, pin_of(&chain));
            self.write(&did, &updated);
        }

        /// Replaces the pinned chain with `new_ops` if it beats `seen_ops` where they split, by being signed there with a
        /// higher-priority rotation key. `seen_ops` must carry on from the pin. Anyone may call: the keys decide. The link
        /// goes too, because it was made under the chain that lost, and so does the record of bind posts used, so a
        /// losing key can't block later links with a high record key. The account then links again.
        pub fn resolve_fork(&mut self, did: String, seen_ops: Vec<Bytes>, new_ops: Vec<Bytes>) {
            let seen = atp_verify::verify_plc_chain(&did, &slices(&seen_ops, MAX_OPS)).expect("invalid operation chain");
            let new = atp_verify::verify_plc_chain(&did, &slices(&new_ops, MAX_OPS)).expect("invalid operation chain");
            let (_, _, _, known) = self.read(&did);
            assert!(known.0 > 0 && seen.extends(known.0, known.1.as_slice()), "that isn't the chain already seen");
            assert!(new.overrides(&seen), "that chain doesn't outrank the one already seen");
            let updated: Record = (None, None, None, pin_of(&new));
            self.write(&did, &updated);
        }

        fn read(&self, did: &str) -> Record {
            ResourceManager::get(self.records).get_non_fungible(&record_id(did)).get_mutable_data()
        }

        fn write(&self, did: &str, record: &Record) {
            let manager = ResourceManager::get(self.records);
            let id = record_id(did);
            self.record_badge.authorize_with(|| manager.update_non_fungible_data(id, record));
        }

        fn active_binding_full(&self, did: &str) -> Option<(ComponentAddress, RistrettoPublicKeyBytes)> {
            let (address, since, old, owner, old_owner) = self.read(did).0?;
            let me = CallerContext::current_component_address();
            if Consensus::current_epoch() >= since {
                Some((address, owner))
            } else if old == me {
                None
            } else {
                Some((old, old_owner))
            }
        }
    }
}
