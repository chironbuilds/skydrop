//   SPDX-License-Identifier: BSD-3-Clause

//! SocialRecovery: a vault your friends on Bluesky can recover for you.
//!
//! The owner escrows funds under a vault id of their choosing, pinned to this policy. The deposit's metadata
//! names the **guardians** and the rules: `threshold (1 byte) ++ delay (8-byte BE epochs) ++ guardian DIDs
//! ("\n"-separated)`. The deposit's sender key is the owner; its refund epoch is the owner's own exit
//! (escrow's `refund`, which needs no guardian).
//!
//! If the owner loses their key:
//! * Each guardian posts, from their own Bluesky account, the recovery code for "move this vault to account
//!   X" (`expected_post_text`) and anyone submits the proof with `approve`. The post's signature is the
//!   authority; nothing else from the guardian is needed.
//! * Once `threshold` distinct guardians have approved the **same** new account, a recovery starts and becomes
//!   executable after `delay` epochs.
//! * During the delay the owner — if they still have their key, i.e. the guardians are colluding — can
//!   `cancel` it. After it, anyone can `execute`, paying the vault straight into the new account.
//!
//! A guardian's proof must use their current identity chain (at least the registry's floor), so a guardian's
//! rotated-away key approves nothing. Each guardian's approval posts must have increasing record keys per
//! vault, so a copied old post cannot be replayed into a later recovery.

use atp_verify::sha256;
use tari_template_lib::{prelude::*, types::crypto::RistrettoPublicKeyBytes};

/// Escrow's deposit tuple: (sender, amount, refund epoch, policy, metadata, epoch it was made).
type EscDep = (RistrettoPublicKeyBytes, Amount, u64, ComponentAddress, Bytes, u64);

const CODE_DOMAIN: &[u8] = b"tari-bsky-recover:v1:";
const POST: &str = "app.bsky.feed.post";
const MAX_OPS: usize = 16;
const MAX_NODES: usize = 32;
const MAX_BLOCK_LEN: usize = 16 * 1024;
const MAX_GUARDIANS: usize = 7;

fn require_signer(key: RistrettoPublicKeyBytes) {
    CallerContext::assert_badge_in_scope(&NonFungibleAddress::from_public_key(key));
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::new();
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

struct Rules {
    threshold: usize,
    delay: u64,
    guardians: Vec<String>,
}

/// The vault's recovery rules. Panics on malformed or impossible rules (then only the owner's refund works).
fn rules_of(metadata: &Bytes) -> Rules {
    let b = metadata.as_slice();
    assert!(b.len() > 9, "not a SocialRecovery vault");
    let threshold = b[0] as usize;
    let mut d = [0u8; 8];
    d.copy_from_slice(&b[1..9]);
    let delay = u64::from_be_bytes(d);
    let list = core::str::from_utf8(&b[9..]).expect("guardian list is not UTF-8");
    let mut guardians: Vec<String> = list.split('\n').map(|s| s.to_string()).collect();
    guardians.sort();
    guardians.dedup();
    assert!(guardians.iter().all(|g| g.starts_with("did:")), "guardians must be DIDs");
    assert!(guardians.len() <= MAX_GUARDIANS, "too many guardians");
    assert!(threshold >= 1 && threshold <= guardians.len(), "the threshold must be between 1 and the number of guardians");
    Rules { threshold, delay, guardians }
}

/// A vault's stable identity: its escrow index shifts as other deposits come and go, this does not.
fn vault_key(vault_id: &str, dep: &EscDep) -> String {
    let mut data = vault_id.as_bytes().to_vec();
    data.push(b':');
    data.extend_from_slice(&dep.0.into_array());
    data.extend_from_slice(&dep.5.to_be_bytes());
    data.extend_from_slice(dep.1.to_string().as_bytes());
    hex(&sha256(&data))
}

fn recovery_code(component: &str, vault: &str, new_owner: &str) -> String {
    let mut data = CODE_DOMAIN.to_vec();
    data.extend_from_slice(component.as_bytes());
    data.push(b':');
    data.extend_from_slice(vault.as_bytes());
    data.push(b':');
    data.extend_from_slice(new_owner.as_bytes());
    let digest = sha256(&data);
    format!("tari-recover:{}", hex(&digest[..16]))
}

#[template]
mod social_recovery {
    use std::collections::{BTreeMap, BTreeSet};

    use super::*;

    pub struct SocialRecovery {
        escrow: ComponentAddress,
        badge_vault: Vault,
        link_registry: ComponentAddress,
        /// vault key -> proposed new account -> guardians who approved it.
        approvals: BTreeMap<String, BTreeMap<String, BTreeSet<String>>>,
        /// vault key -> (new account, epoch the recovery becomes executable).
        recovering: BTreeMap<String, (String, u64)>,
        /// "vault key|guardian" -> rkey of the guardian's last approval post for that vault.
        last_rkey: BTreeMap<String, String>,
    }

    impl SocialRecovery {
        pub fn new(escrow: ComponentAddress, badge_resource: ResourceAddress, link_registry: ComponentAddress) -> Component<Self> {
            Component::new(Self {
                escrow,
                badge_vault: Vault::new_empty(badge_resource),
                link_registry,
                approvals: BTreeMap::new(),
                recovering: BTreeMap::new(),
                last_rkey: BTreeMap::new(),
            })
            .with_access_rules(AccessRules::allow_all())
            .create()
        }

        pub fn receive_badge(&mut self, badge: Bucket) {
            self.badge_vault.deposit(badge);
        }

        /// The text a guardian posts to approve moving the vault at `index` to `new_owner`.
        pub fn expected_post_text(&self, vault_id: String, index: u32, new_owner: ComponentAddress) -> String {
            let (key, _, _) = self.vault(&vault_id, index);
            recovery_code(&CallerContext::current_component_address().to_string(), &key, &new_owner.to_string())
        }

        /// The recovery in progress for the vault at `index`, if any: (new account, epoch it can execute).
        pub fn recovery_for(&self, vault_id: String, index: u32) -> Option<(String, u64)> {
            let (key, _, _) = self.vault(&vault_id, index);
            self.recovering.get(&key).cloned()
        }

        /// Records `guardian`'s approval of moving the vault to `new_owner`, proven by a post in the guardian's
        /// repo carrying the recovery code. Anyone may submit it. Starts the recovery once enough agree.
        #[allow(clippy::too_many_arguments)]
        pub fn approve(
            &mut self,
            vault_id: String,
            index: u32,
            guardian: String,
            new_owner: ComponentAddress,
            ops: Vec<Bytes>,
            commit: Bytes,
            mst_nodes: Vec<Bytes>,
            record: Bytes,
            rkey: String,
        ) {
            let (key, _dep, rules) = self.vault(&vault_id, index);
            assert!(rules.guardians.contains(&guardian), "not a guardian of this vault");
            assert!(!ops.is_empty() && ops.len() <= MAX_OPS && mst_nodes.len() <= MAX_NODES, "bad proof size");
            assert!(ops.iter().chain(mst_nodes.iter()).all(|b| b.len() <= MAX_BLOCK_LEN), "block too large");
            assert!(commit.len() <= MAX_BLOCK_LEN && record.len() <= MAX_BLOCK_LEN, "block too large");

            let ops_s: Vec<&[u8]> = ops.iter().map(|b| b.as_slice()).collect();
            let chain = atp_verify::verify_plc_chain(&guardian, &ops_s).expect("invalid operation chain");
            let floor: u32 = ComponentManager::get(self.link_registry).call("chain_floor", args![guardian.clone()]);
            assert!(chain.len >= floor, "stale operation chain: a longer one has been seen");
            let nodes: Vec<&[u8]> = mst_nodes.iter().map(|b| b.as_slice()).collect();
            atp_verify::verify_record(&guardian, &chain.signing_key, commit.as_slice(), &nodes, record.as_slice(), POST, &rkey)
                .expect("invalid repo proof");
            let text = atp_verify::record_text(record.as_slice()).expect("record has no text");
            let owner_s = new_owner.to_string();
            let code = recovery_code(&CallerContext::current_component_address().to_string(), &key, &owner_s);
            assert!(text.contains(&code), "the post does not contain the recovery code");

            let seen = format!("{key}|{guardian}");
            if let Some(last) = self.last_rkey.get(&seen) {
                assert!(rkey.as_str() > last.as_str(), "a newer post than this guardian's last approval is needed");
            }
            self.last_rkey.insert(seen, rkey);

            let set = self.approvals.entry(key.clone()).or_default().entry(owner_s.clone()).or_default();
            set.insert(guardian);
            if set.len() >= rules.threshold && !self.recovering.contains_key(&key) {
                let at = Consensus::current_epoch().saturating_add(rules.delay);
                self.recovering.insert(key, (owner_s, at));
            }
        }

        /// The owner (the deposit's sender, who signs) cancels a recovery in progress and clears its approvals.
        pub fn cancel(&mut self, vault_id: String, index: u32) {
            let (key, dep, _) = self.vault(&vault_id, index);
            require_signer(dep.0);
            assert!(self.recovering.remove(&key).is_some() || self.approvals.contains_key(&key), "nothing to cancel");
            self.approvals.remove(&key);
        }

        /// Moves the vault into the recovered account once the delay has passed. Anyone may call it.
        pub fn execute(&mut self, vault_id: String, index: u32, new_owner: ComponentAddress) {
            let (key, _, _) = self.vault(&vault_id, index);
            let (owner_s, at) = self.recovering.get(&key).cloned().expect("no recovery in progress");
            assert!(new_owner.to_string() == owner_s, "that is not the account the guardians chose");
            assert!(Consensus::current_epoch() >= at, "the recovery delay has not passed");
            let proof = self.badge_vault.create_proof();
            ComponentManager::get(self.escrow).invoke("release_to", args![proof, vault_id, index, new_owner]);
            proof.drop();
            self.recovering.remove(&key);
            self.approvals.remove(&key);
        }

        /// The vault at `index` under `vault_id`: its stable key, deposit and rules.
        fn vault(&self, vault_id: &str, index: u32) -> (String, EscDep, Rules) {
            let me = CallerContext::current_component_address();
            let deps: Vec<EscDep> = ComponentManager::get(self.escrow).call("deposits_for", args![vault_id.to_string()]);
            let dep = deps.get(index as usize).cloned().expect("no such vault");
            assert!(dep.3 == me, "that deposit is not a SocialRecovery vault");
            let rules = rules_of(&dep.4);
            (vault_key(vault_id, &dep), dep, rules)
        }
    }
}
