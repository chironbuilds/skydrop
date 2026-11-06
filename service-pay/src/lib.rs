//   SPDX-License-Identifier: BSD-3-Clause

//! ServicePay: pay-per-call for any atproto service, metered by the caller's own **service-auth tokens**.
//!
//! atproto already has a way for an account to prove "this request is mine" to another service: the account's
//! PDS signs a short-lived JWT (`com.atproto.server.getServiceAuth`) with the account's repo key, addressed
//! (`aud`) to the service's DID and optionally scoped to one method (`lxm`). This policy turns each such token
//! into one paid call, with no new keys, accounts or API secrets:
//!
//! * The user escrows a **credit line** for their own DID, pinned to this policy. Its metadata names who may be
//!   paid and how much per call: `price (8-byte BE µT) ++ provider DID ++ "\n" ++ payout account ++ ["\n" ++ lxm]`.
//! * With each API request the user's client sends a service-auth token. The provider (or anyone) redeems it
//!   with `redeem`: the token must verify against the user's current repo key (proven from their PLC chain, at
//!   least as long as the registry's floor), be issued by that DID, addressed to the credit line's provider,
//!   and carry its method if one is set. Each token pays once.
//! * One call's price goes to the **payout account the user fixed in the deposit** — not one the redeemer
//!   names — so a leaked token can only ever pay the provider it was meant for. The rest goes back into escrow
//!   as the same credit line; a remainder too small for another call (or a credit line past its refund epoch)
//!   is kept here as change the user takes back with `take_change`.
//! * The user can stop at any time: escrow's `refund` returns the unspent credit after its refund epoch.
//!
//! WASM has no clock, so a token's `exp` is not enforced here; single use plus the provider binding are what
//! bound a token's value to one call to that provider.

use atp_verify::sha256;
use tari_template_lib::{prelude::*, types::crypto::RistrettoPublicKeyBytes};

/// Escrow's deposit tuple: (sender, amount, refund epoch, policy, metadata, epoch it was made).
type EscDep = (RistrettoPublicKeyBytes, Amount, u64, ComponentAddress, Bytes, u64);

const MAX_OPS: usize = 16;
const MAX_BLOCK_LEN: usize = 16 * 1024;
const MAX_TOKEN_LEN: usize = 4096;

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

/// A credit line's terms, parsed from its deposit metadata.
struct Terms {
    price: u64,
    provider: String,
    payout: String,
    lxm: String,
}

fn terms_of(metadata: &Bytes) -> Terms {
    let b = metadata.as_slice();
    assert!(b.len() > 8, "not a ServicePay credit line");
    let mut p = [0u8; 8];
    p.copy_from_slice(&b[..8]);
    let price = u64::from_be_bytes(p);
    assert!(price > 0, "a credit line's price must be positive");
    let rest = core::str::from_utf8(&b[8..]).expect("credit line terms are not UTF-8");
    let mut parts = rest.split('\n');
    let provider = parts.next().unwrap_or_default().to_string();
    let payout = parts.next().unwrap_or_default().to_string();
    let lxm = parts.next().unwrap_or_default().to_string();
    assert!(parts.next().is_none(), "malformed credit line terms");
    assert!(provider.starts_with("did:") && payout.starts_with("component_"), "malformed credit line terms");
    Terms { price, provider, payout, lxm }
}

#[template]
mod service_pay {
    use std::collections::{BTreeMap, BTreeSet};

    use super::*;

    pub struct ServicePay {
        escrow: ComponentAddress,
        badge_vault: Vault,
        /// Whose `chain_pin` a user's operation chain must reach (a rotated-away key issues no valid token).
        link_registry: ComponentAddress,
        /// did -> sha256 (hex) of every token already redeemed for it.
        spent: BTreeMap<String, BTreeSet<String>>,
        /// Remainders too small to escrow again, held for their sender.
        change_vault: Vault,
        /// sender key (hex) -> change waiting for them.
        change: BTreeMap<String, Amount>,
    }

    impl ServicePay {
        pub fn new(escrow: ComponentAddress, badge_resource: ResourceAddress, resource: ResourceAddress, link_registry: ComponentAddress) -> Component<Self> {
            Component::new(Self {
                escrow,
                badge_vault: Vault::new_empty(badge_resource),
                link_registry,
                spent: BTreeMap::new(),
                change_vault: Vault::new_empty(resource),
                change: BTreeMap::new(),
            })
            .with_owner_rule(OwnerRule::None)
            .with_access_rules(AccessRules::allow_all())
            .create()
        }

        pub fn receive_badge(&mut self, badge: Bucket) {
            self.badge_vault.deposit(badge);
        }

        /// Pays one call from `did`'s credit line at `index` for `token`, a service-auth JWT the account issued.
        /// Anyone may submit it (normally the provider): the payout account is fixed by the credit line.
        pub fn redeem(&mut self, did: String, index: u32, ops: Vec<Bytes>, token: String, payout: ComponentAddress) {
            let me = CallerContext::current_component_address();
            let deps: Vec<EscDep> = ComponentManager::get(self.escrow).call("deposits_for", args![did.clone()]);
            let dep = deps.get(index as usize).cloned().expect("no such credit line");
            assert!(dep.3 == me, "that deposit is not a ServicePay credit line");
            let terms = terms_of(&dep.4);
            assert!(payout.to_string() == terms.payout, "that is not this credit line's payout account");
            assert!(dep.1 >= Amount::from(terms.price), "this credit line is used up");

            assert!(!ops.is_empty() && ops.len() <= MAX_OPS, "bad operation chain length");
            assert!(ops.iter().all(|o| o.len() <= MAX_BLOCK_LEN), "block too large");
            assert!(token.len() <= MAX_TOKEN_LEN, "token too large");
            let ops_s: Vec<&[u8]> = ops.iter().map(|b| b.as_slice()).collect();
            let chain = atp_verify::verify_plc_chain(&did, &ops_s).expect("invalid operation chain");
            let (floor, floor_tip): (u32, Bytes) = ComponentManager::get(self.link_registry).call("chain_pin", args![did.clone()]);
            assert!(chain.extends(floor, floor_tip.as_slice()), "stale operation chain: a longer or different one has been seen");

            let claims = atp_verify::jwt::verify_service_auth(&token, &chain.signing_key).expect("invalid service-auth token");
            assert!(claims.iss == did, "the token was not issued by this account");
            assert!(claims.aud == terms.provider, "the token is not addressed to this credit line's provider");
            if !terms.lxm.is_empty() {
                assert!(claims.lxm.as_deref() == Some(terms.lxm.as_str()), "the token is for a different method");
            }
            let digest = hex(&sha256(token.as_bytes()));
            assert!(self.spent.entry(did.clone()).or_default().insert(digest), "this token was already redeemed");

            // Release the whole credit line, pay one call, and escrow the rest again under the same terms.
            let proof = self.badge_vault.create_proof();
            let mut funds: Bucket = ComponentManager::get(self.escrow).call("release", args![proof, did.clone(), index]);
            proof.drop();
            let fee = funds.take(Amount::from(terms.price));
            ComponentManager::get(payout).invoke("deposit", args![fee]);
            let left = funds.amount();
            if left.is_zero() {
                funds.drop_empty();
            } else if left >= Amount::from(terms.price) && dep.2 > Consensus::current_epoch() {
                let proof = self.badge_vault.create_proof();
                ComponentManager::get(self.escrow).invoke("policy_deposit", args![proof, did, dep.0, dep.2, me, dep.4, funds]);
                proof.drop();
            } else {
                let key = hex(&dep.0.into_array());
                let had = self.change.get(&key).copied().unwrap_or(Amount::zero());
                self.change.insert(key, had + left);
                self.change_vault.deposit(funds);
            }
        }

        /// Takes back the change kept for `sender` (who signs).
        pub fn take_change(&mut self, sender: RistrettoPublicKeyBytes) -> Bucket {
            require_signer(sender);
            let amount = self.change.remove(&hex(&sender.into_array())).expect("no change is waiting for you");
            self.change_vault.withdraw(amount)
        }

        pub fn change_for(&self, sender: RistrettoPublicKeyBytes) -> Amount {
            self.change.get(&hex(&sender.into_array())).copied().unwrap_or(Amount::zero())
        }

        pub fn is_redeemed(&self, did: String, token: String) -> bool {
            self.spent.get(&did).is_some_and(|s| s.contains(&hex(&sha256(token.as_bytes()))))
        }
    }
}
