//   SPDX-License-Identifier: BSD-3-Clause

//! Escrow: the permanent custody core of the generic Skydrop architecture. It holds funds keyed by an
//! opaque `account_id` (a Bluesky `did:plc`, but escrow never interprets it) and is deliberately tiny and
//! feature-blind, so its code never needs to change — which is the whole point: funds are never orphaned
//! by a feature upgrade.
//!
//! * `deposit` escrows funds and pins them to the **policy** that may release them, plus opaque
//!   `metadata` the policy interprets (challenge window, phrase, hold, …). Escrow does not read it.
//! * `release` pays a deposit out, authenticated by a **policy badge**: the engine cannot tell escrow who
//!   called it, so each approved policy holds a unique NFT badge and presents a `Proof` of it. Escrow
//!   reads the badge's id, maps it to the approved policy address, and confirms it matches the deposit's
//!   pinned policy — so a policy can only ever release its own deposits.
//! * `refund` returns a deposit to its original sender after its refund epoch, with **no badge** — the
//!   safety valve, so a buggy or revoked policy can never permanently strand funds.
//! * `approve_policy` (governance only) mints a badge for a new policy. A new feature is a new policy +
//!   one badge; escrow is never redeployed and existing deposits never move.
//!
//! **Each account's deposits live in its own ledger NFT, not in this component.** A substate is capped at 1 MiB,
//! so a single shared map could be filled with dust by anyone, blocking every new deposit for everyone. The ledger
//! id is sha256(account_id), and its mutable data holds that account's deposits and fees owed. So:
//!
//! * This component's state doesn't grow with accounts or deposits, and one account's traffic can't fill another's.
//! * An account's ledger must exist before a deposit: `open_account` creates it, and anyone may call it. The engine
//!   has no way to ask whether an NFT exists, so opening twice simply fails; a client checks first, and sends
//!   `open_account` and `deposit` in one transaction for a new account.
//! * Ledgers have to be held in some vault, and a vault lists its ids in one substate, so the vault that holds them
//!   is replaced after `ledger_vault_size` accounts. Full vaults are never touched again.
//! * A deposit a policy returns stays in the ledger, pinned to escrow itself so no policy can move it and refundable
//!   at once. A separate map of returned funds would be another shared structure anyone could grow.

use sha2::{Digest, Sha256};
use tari_template_lib::{prelude::*, types::constants::TARI_TOKEN};

/// (sender, amount, refund epoch, governing policy, opaque policy metadata, epoch it was made). The
/// creation epoch is recorded by escrow itself, so a policy (or an off-chain service) can trust it — unlike
/// anything in the depositor-written metadata. A returned deposit's policy is escrow's own address.
type EscDep = (RistrettoPublicKeyBytes, Amount, u64, ComponentAddress, Bytes, u64);
/// A ledger's mutable data: the account's deposits, and the fees the fee vault has advanced for it.
type Ledger = (Vec<EscDep>, Amount);

/// Longest opaque metadata a policy may attach to a deposit.
const MAX_METADATA: usize = 256;
/// Deposits an account may hold under ONE policy. Counted per policy, not per account: anyone may deposit
/// for any account, so a shared cap would let a stranger fill an account's slots under a policy that can
/// never release them and block every other policy's deposits for it. Each policy cleans its own lane.
const MAX_DEPOSITS_PER_POLICY: usize = 64;
/// Deposits an account may hold in total, across all policies. With metadata at its limit this stays well under the
/// 1 MiB substate cap.
const MAX_DEPOSITS_PER_ACCOUNT: usize = 512;
/// Furthest in the future a refund epoch may be, so no deposit (junk included) is locked indefinitely.
const MAX_REFUND_DELAY: u64 = 20_000;
/// Ceiling on the fee one sponsored call may draw from the fee vault (µT).
const MAX_SPONSORED_FEE: u64 = 100_000;
/// Longest account id. Ids are stored in each ledger, and hashed for its NFT id.
const MAX_ACCOUNT_ID: usize = 256;
/// The most ids a ledger vault may hold before it's replaced. Each id takes about 40 bytes of a 1 MiB substate.
const MAX_LEDGER_VAULT_SIZE: u32 = 20_000;

fn require_signer(key: RistrettoPublicKeyBytes) {
    CallerContext::assert_badge_in_scope(&NonFungibleAddress::from_public_key(key));
}

/// The NFT id of `account_id`'s ledger.
fn ledger_id(account_id: &str) -> NonFungibleId {
    NonFungibleId::from_u256(Sha256::digest(account_id.as_bytes()).into())
}

#[template]
mod escrow {
    use std::collections::BTreeMap;

    use super::*;

    pub struct Escrow {
        vault: Vault,
        /// Empty vault of the policy-badge resource, kept only to reach its resource manager for minting.
        badge_vault: Vault,
        policy_badge: ResourceAddress,
        min_deposit: Amount,
        /// Governance key: the only signer that can approve policies.
        admin: RistrettoPublicKeyBytes,
        /// Badge id -> approved policy component. The badge an approved policy holds carries its id.
        policies: BTreeMap<u64, ComponentAddress>,
        next_badge: u64,
        /// TARI that pays the network fee of sponsored policy calls. Kept apart from `vault`: deposits are
        /// never spent on fees. Anyone may `fund` it.
        fee_vault: Vault,
        /// One NFT per account, holding its deposits.
        ledgers: ResourceAddress,
        /// Holds the single badge allowed to mint and update ledgers.
        ledger_badge: Vault,
        /// Holds the ledgers of recent accounts; replaced when full.
        ledger_vault: Vault,
        ledger_vault_count: u32,
        ledger_vault_size: u32,
        /// Vaults that are full. Nothing reads them: a ledger is reached by its own address.
        full_vaults: Vec<Vault>,
        accounts: u64,
    }

    impl Escrow {
        /// Deploys the permanent custody core for `resource`, with `admin` as governance. `ledger_vault_size` is how
        /// many accounts' ledgers one vault holds before it's replaced.
        pub fn new(resource: ResourceAddress, min_deposit: Amount, admin: RistrettoPublicKeyBytes, ledger_vault_size: u32) -> Component<Self> {
            assert!(min_deposit.is_positive(), "minimum deposit must be positive");
            assert!(ledger_vault_size >= 1 && ledger_vault_size <= MAX_LEDGER_VAULT_SIZE, "ledger vault size out of range");
            // A fresh NFT resource owned by this component; by default only this component can mint it.
            let policy_badge = ResourceBuilder::non_fungible().with_token_symbol("SKYPOL").build();
            let badge_id = NonFungibleId::from_u32(0);
            let ledger_badge = ResourceBuilder::non_fungible().with_owner_rule(OwnerRule::None).initial_supply([badge_id.clone()]);
            let badge_address = NonFungibleAddress::new(ledger_badge.resource_address(), badge_id);
            let ledgers = ResourceBuilder::non_fungible()
                .with_owner_rule(OwnerRule::None)
                .with_token_symbol("SKYLED")
                .mintable(rule!(non_fungible(badge_address.clone())), rule!(deny_all))
                .update_non_fungible_data(rule!(non_fungible(badge_address)), rule!(deny_all))
                .withdrawable(rule!(deny_all), rule!(deny_all))
                .build();
            Component::new(Self {
                vault: Vault::new_empty(resource),
                badge_vault: Vault::new_empty(policy_badge),
                policy_badge,
                min_deposit,
                admin,
                policies: BTreeMap::new(),
                next_badge: 0,
                fee_vault: Vault::new_empty(TARI_TOKEN),
                ledgers,
                ledger_badge: Vault::from_bucket(ledger_badge),
                ledger_vault: Vault::new_empty(ledgers),
                ledger_vault_count: 0,
                ledger_vault_size,
                full_vaults: Vec::new(),
                accounts: 0,
            })
            .with_access_rules(AccessRules::allow_all())
            .create()
        }

        /// Creates `account_id`'s ledger. Anyone may call it, and the caller pays for the storage. Fails if the ledger
        /// already exists. This is what makes a deposit's state belong to its account.
        pub fn open_account(&mut self, account_id: String) {
            assert!(!account_id.is_empty() && account_id.len() <= MAX_ACCOUNT_ID, "account id must be 1-256 bytes");
            if self.ledger_vault_count >= self.ledger_vault_size {
                let full = core::mem::replace(&mut self.ledger_vault, Vault::new_empty(self.ledgers));
                self.full_vaults.push(full);
                self.ledger_vault_count = 0;
            }
            let manager = ResourceManager::get(self.ledgers);
            let empty: Ledger = (Vec::new(), Amount::zero());
            let ledger = self.ledger_badge.authorize_with(|| manager.mint_non_fungible(ledger_id(&account_id), &account_id, &empty));
            self.ledger_vault.deposit(ledger);
            self.ledger_vault_count += 1;
            self.accounts += 1;
        }

        /// Governance approves a policy and gets its badge, to hand to that policy component. Only the admin
        /// may call. The badge's non-fungible id identifies the policy on every later `release`.
        pub fn approve_policy(&mut self, policy: ComponentAddress) -> Bucket {
            require_signer(self.admin);
            assert!(!self.policies.values().any(|p| *p == policy), "policy already approved");
            let id = self.next_badge;
            self.next_badge += 1;
            self.policies.insert(id, policy);
            self.badge_vault.get_resource_manager().mint_non_fungible(NonFungibleId::from_u64(id), &(), &())
        }

        /// Escrows `funds` for `account_id`, governed by `policy`, carrying opaque `metadata`. `sender` (who
        /// signs) can `refund` after `refund_epoch`. The policy must be approved; even so, nothing but that
        /// policy's badge — or a refund — can move these funds. The account must have been opened.
        pub fn deposit(
            &mut self,
            account_id: String,
            sender: RistrettoPublicKeyBytes,
            refund_epoch: u64,
            policy: ComponentAddress,
            metadata: Bytes,
            funds: Bucket,
        ) {
            require_signer(sender);
            self.push_deposit(account_id, sender, refund_epoch, policy, metadata, funds);
        }

        /// Escrows `funds` on behalf of a policy, with no sender signature — authorized by a `Proof` of any
        /// policy badge. This lets a policy create deposits from funds it controls (e.g. a relayed tip drawn
        /// from a budget, where the post's signature is the authority, not an on-chain signer). The deposit
        /// is still pinned to whichever `policy` will govern the claim, and `sender` is recorded for refunds.
        pub fn policy_deposit(
            &mut self,
            badge: Proof,
            account_id: String,
            sender: RistrettoPublicKeyBytes,
            refund_epoch: u64,
            policy: ComponentAddress,
            metadata: Bytes,
            funds: Bucket,
        ) {
            self.badge_policy(&badge);
            self.push_deposit(account_id, sender, refund_epoch, policy, metadata, funds);
        }

        fn push_deposit(&mut self, account_id: String, sender: RistrettoPublicKeyBytes, refund_epoch: u64, policy: ComponentAddress, metadata: Bytes, funds: Bucket) {
            assert_eq!(funds.resource_address(), self.vault.resource_address(), "wrong resource");
            assert!(metadata.len() <= MAX_METADATA, "metadata too large");
            let now = Consensus::current_epoch();
            assert!(refund_epoch > now, "refund epoch must be in the future");
            assert!(refund_epoch <= now.saturating_add(MAX_REFUND_DELAY), "refund epoch too far in the future");
            assert!(self.policies.values().any(|p| *p == policy), "policy not approved");
            let amount = funds.amount();
            assert!(amount >= self.min_deposit, "deposit below the minimum");
            let (mut list, owed) = self.read(&account_id);
            assert!(list.len() < MAX_DEPOSITS_PER_ACCOUNT, "too many deposits for this account");
            assert!(list.iter().filter(|d| d.3 == policy).count() < MAX_DEPOSITS_PER_POLICY, "too many deposits for this account");
            list.push((sender, amount, refund_epoch, policy, metadata, now));
            self.write(&account_id, &(list, owed));
            self.vault.deposit(funds);
        }

        /// Pays out the deposit at `index` for `account_id`. Authenticated by a `Proof` of the policy badge:
        /// escrow reads the badge id, maps it to an approved policy, and requires it to match the deposit's
        /// pinned policy. Returns the funds as a bucket for the policy to route (e.g. to the claimant).
        pub fn release(&mut self, badge: Proof, account_id: String, index: u32) -> Bucket {
            let policy = self.badge_policy(&badge);
            let net = self.remove_for_policy(&account_id, index, policy);
            self.vault.withdraw(net)
        }

        /// Like `release`, but pays the deposit straight into the account `to` (e.g. a DID's linked wallet)
        /// instead of returning a bucket. The governing policy passes a `to` it has itself validated.
        pub fn release_to(&mut self, badge: Proof, account_id: String, index: u32, to: ComponentAddress) {
            let policy = self.badge_policy(&badge);
            let net = self.remove_for_policy(&account_id, index, policy);
            let funds = self.vault.withdraw(net);
            ComponentManager::get(to).invoke("deposit", args![funds]);
        }

        /// Returns the deposit at `index` to its original sender once its refund epoch has passed. Needs no
        /// badge: the safety valve, independent of any policy.
        pub fn refund(&mut self, account_id: String, index: u32) -> Bucket {
            let (mut list, mut owed) = self.read(&account_id);
            let dep = list.get(index as usize).cloned().expect("no such deposit");
            require_signer(dep.0);
            assert!(Consensus::current_epoch() >= dep.2, "not refundable yet");
            list.remove(index as usize);
            // A returned deposit already repaid what the account owed when it was returned.
            let me = CallerContext::current_component_address();
            let took = if dep.3 == me { Amount::zero() } else { self.reimburse(&mut owed, dep.1) };
            self.write(&account_id, &(list, owed));
            self.vault.withdraw(dep.1 - took)
        }

        /// Adds TARI to the fee vault. Anyone may contribute.
        pub fn fund(&mut self, bucket: Bucket) {
            assert_eq!(bucket.resource_address(), TARI_TOKEN, "fee funding must be TARI");
            self.fee_vault.deposit(bucket);
        }

        pub fn fee_balance(&self) -> Amount {
            self.fee_vault.balance()
        }

        /// Pays `fee` from the fee vault for the current (sponsored) transaction, charged to `account_id`'s
        /// escrow. Badge-gated: a policy calls it from the fee phase, only after its own checks pass, so an
        /// invalid call costs the vault nothing. The account's escrow must cover everything it has drawn, so
        /// draining the vault costs more than the attacker's own deposit. Returned deposits don't count: that
        /// money is on its way back to its sender.
        pub fn pay_fee_sponsored(&mut self, badge: Proof, account_id: String, fee: Amount) {
            self.badge_policy(&badge);
            assert!(fee.is_positive() && fee <= Amount::from(MAX_SPONSORED_FEE), "sponsored fee out of range");
            let (list, owed) = self.read(&account_id);
            let me = CallerContext::current_component_address();
            let total = list.iter().filter(|d| d.3 != me).fold(Amount::zero(), |a, e| a + e.1);
            assert!(total >= owed + fee, "this account's escrow is too small to cover more sponsored fees");
            self.write(&account_id, &(list, owed + fee));
            self.fee_vault.pay_fee(fee);
        }

        /// Hands the deposit at `index` back to its sender, authorized by a `Proof` of the governing policy's badge
        /// (e.g. a linked account's owner declining a gift). The sender collects it with `refund` right away; from
        /// here on no policy can move it.
        pub fn return_to_sender(&mut self, badge: Proof, account_id: String, index: u32) {
            let policy = self.badge_policy(&badge);
            let (mut list, mut owed) = self.read(&account_id);
            let dep = list.get(index as usize).cloned().expect("no such deposit");
            assert!(dep.3 == policy, "that deposit is governed by another policy");
            let took = self.reimburse(&mut owed, dep.1);
            let back = dep.1 - took;
            if back.is_positive() {
                let me = CallerContext::current_component_address();
                list[index as usize] = (dep.0, back, Consensus::current_epoch(), me, Bytes::from_vec(vec![]), dep.5);
            } else {
                list.remove(index as usize);
            }
            self.write(&account_id, &(list, owed));
        }

        /// Everything a policy has returned to `sender` in `account_id`'s ledger, waiting to be refunded.
        pub fn returned_for(&self, account_id: String, sender: RistrettoPublicKeyBytes) -> Amount {
            let me = CallerContext::current_component_address();
            let (list, _) = self.read(&account_id);
            list.iter().filter(|d| d.3 == me && d.0 == sender).fold(Amount::zero(), |a, d| a + d.1)
        }

        /// Every deposit for an opened account. Fails for an account with no ledger.
        pub fn deposits_for(&self, account_id: String) -> Vec<EscDep> {
            self.read(&account_id).0
        }

        pub fn total_escrowed(&self) -> Amount {
            self.vault.balance()
        }

        pub fn account_count(&self) -> u64 {
            self.accounts
        }

        pub fn ledger_resource(&self) -> ResourceAddress {
            self.ledgers
        }

        pub fn is_policy_approved(&self, policy: ComponentAddress) -> bool {
            self.policies.values().any(|p| *p == policy)
        }

        pub fn policy_badge_resource(&self) -> ResourceAddress {
            self.policy_badge
        }

        fn read(&self, account_id: &str) -> Ledger {
            ResourceManager::get(self.ledgers).get_non_fungible(&ledger_id(account_id)).get_mutable_data()
        }

        fn write(&self, account_id: &str, ledger: &Ledger) {
            let manager = ResourceManager::get(self.ledgers);
            let id = ledger_id(account_id);
            self.ledger_badge.authorize_with(|| manager.update_non_fungible_data(id, ledger));
        }

        /// The approved policy a shown badge proof belongs to.
        fn badge_policy(&self, badge: &Proof) -> ComponentAddress {
            badge.assert_resource(self.policy_badge);
            let ids = badge.get_non_fungibles();
            assert!(ids.len() == 1, "present exactly one policy badge");
            let pid = ids.into_iter().next().unwrap().as_u64().expect("policy badge id must be a u64");
            *self.policies.get(&pid).expect("unknown or revoked policy badge")
        }

        /// Removes a deposit for its governing policy and repays the fee vault from it. Returns what's left to pay.
        fn remove_for_policy(&mut self, account_id: &str, index: u32, policy: ComponentAddress) -> Amount {
            let (mut list, mut owed) = self.read(account_id);
            let dep = list.get(index as usize).cloned().expect("no such deposit");
            assert!(dep.3 == policy, "that deposit is governed by another policy");
            list.remove(index as usize);
            let took = self.reimburse(&mut owed, dep.1);
            self.write(account_id, &(list, owed));
            dep.1 - took
        }

        /// Moves what an account owes the fee vault out of `available` into it; returns how much moved.
        fn reimburse(&mut self, owed: &mut Amount, available: Amount) -> Amount {
            if self.vault.resource_address() != TARI_TOKEN || !owed.is_positive() || !available.is_positive() {
                return Amount::zero();
            }
            let take = if *owed < available { *owed } else { available };
            *owed = *owed - take;
            self.fee_vault.deposit(self.vault.withdraw(take));
            take
        }
    }
}
