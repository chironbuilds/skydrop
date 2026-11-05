//   SPDX-License-Identifier: BSD-3-Clause
//! Engine tests for the Escrow custody core: deposit, the unconditional refund safety valve, policy
//! approval (badge mint), and views. The badge-authenticated `release` path is exercised end to end in
//! the claim-policy tests, where a real policy component creates the badge proof from its own vault.

use tari_crypto::{keys::PublicKey as _, ristretto::RistrettoPublicKey, tari_utilities::ByteArray};
use tari_engine_types::virtual_substate::{VirtualSubstate, VirtualSubstateId};
use tari_ootle_common_types::substate_type::SubstateType;
use tari_ootle_transaction::args;
use tari_template_lib::types::{Amount, ComponentAddress, bytes::Bytes, constants::TARI_TOKEN, crypto::RistrettoPublicKeyBytes};
use tari_template_test_tooling::TemplateTest;

/// Opens an account's ledger if it isn't open yet. The engine has no "does it exist" check, so this just tries.
fn ensure_open(test: &mut tari_template_test_tooling::TemplateTest, escrow: tari_template_lib::types::ComponentAddress, id: &str) {
    let tx = test.transaction().call_method(escrow, "open_account", args![id.to_string()]).build_and_seal(test.secret_key());
    let _ = test.execute_and_commit_on_success(tx, vec![]);
}

const CRATE_PATH: &str = env!("CARGO_MANIFEST_DIR");
const ESCROW: &str = "tests/templates/escrow";
const ACCT: &str = "did:plc:abcdefghijklmnopqrstuvwx";

struct U {
    account: ComponentAddress,
    badge: tari_template_lib::types::NonFungibleAddress,
    key: tari_crypto::ristretto::RistrettoSecretKey,
    id: RistrettoPublicKeyBytes,
}

fn user(test: &mut TemplateTest) -> U {
    let (account, badge, key) = test.create_funded_account();
    let id = RistrettoPublicKeyBytes::from_bytes(RistrettoPublicKey::from_secret_key(&key).as_bytes()).unwrap();
    U { account, badge, key, id }
}

fn set_epoch(test: &mut TemplateTest, e: u64) {
    test.set_virtual_substate(VirtualSubstateId::CurrentEpoch, VirtualSubstate::CurrentEpoch(e));
}

struct Env {
    test: TemplateTest,
    escrow: ComponentAddress,
    admin: U,
}

fn setup() -> Env {
    let mut test = TemplateTest::new(CRATE_PATH, [ESCROW]);
    set_epoch(&mut test, 1);
    let template = test.get_template_address("Escrow");
    let admin = user(&mut test);
    let tx = test
        .transaction()
        .call_function(template, "new", args![TARI_TOKEN, Amount::from(1_000u64), admin.id, 20_000u32])
        .build_and_seal(&admin.key);
    test.execute_expect_success(tx, vec![admin.badge.clone()]);
    let escrow = test.get_previous_output_address(SubstateType::Component).as_component_address().unwrap();
    Env { test, escrow, admin }
}

fn approve(env: &mut Env, policy: ComponentAddress) {
    let (e, acct, badge, key) = (env.escrow, env.admin.account, env.admin.badge.clone(), &env.admin.key);
    let tx = env
        .test
        .transaction()
        .call_method(e, "approve_policy", args![policy])
        .put_last_instruction_output_on_workspace("b")
        .call_method(acct, "deposit", args![Workspace("b")])
        .build_and_seal(key);
    env.test.execute_expect_success(tx, vec![badge]);
}

fn escrowed(env: &mut Env) -> Amount {
    env.test.call_method(env.escrow, "total_escrowed", args![], vec![])
}

#[test]
fn deposit_and_refund_round_trips() {
    let mut env = setup();
    let policy = env.admin.account; // any component address stands in as an approved policy here
    approve(&mut env, policy);
    assert!(env.test.call_method::<bool>(env.escrow, "is_policy_approved", args![policy], vec![]));

    let sender = user(&mut env.test);
    let before = env.test.call_method::<Amount>(sender.account, "balance", args![TARI_TOKEN], vec![]);

    let (e, acct, id, key, badge) = (env.escrow, sender.account, sender.id, sender.key.clone(), sender.badge.clone());
    ensure_open(&mut env.test, e, &ACCT.to_string());
    let tx = env
        .test
        .transaction()
        .call_method(acct, "withdraw", args![TARI_TOKEN, Amount::from(5_000u64)])
        .put_last_instruction_output_on_workspace("funds")
        .call_method(e, "deposit", args![ACCT.to_string(), id, 5u64, policy, Bytes::from_vec(vec![]), Workspace("funds")])
        .build_and_seal(&key);
    env.test.execute_expect_success(tx, vec![badge.clone()]);
    assert_eq!(escrowed(&mut env), Amount::from(5_000u64));
    assert_eq!(env.test.call_method::<Vec<(RistrettoPublicKeyBytes, Amount, u64, ComponentAddress, Bytes, u64)>>(e, "deposits_for", args![ACCT.to_string()], vec![]).len(), 1);

    // Not refundable before the refund epoch.
    let early = env.test.transaction().call_method(e, "refund", args![ACCT.to_string(), 0u32]).build_and_seal(&key);
    env.test.execute_expect_failure(early, vec![badge.clone()]);

    // After the refund epoch the sender gets it back.
    set_epoch(&mut env.test, 5);
    let tx = env
        .test
        .transaction()
        .call_method(e, "refund", args![ACCT.to_string(), 0u32])
        .put_last_instruction_output_on_workspace("back")
        .call_method(acct, "deposit", args![Workspace("back")])
        .build_and_seal(&key);
    env.test.execute_expect_success(tx, vec![badge]);
    assert_eq!(escrowed(&mut env), Amount::zero());
    let after = env.test.call_method::<Amount>(sender.account, "balance", args![TARI_TOKEN], vec![]);
    assert_eq!(before, after);
}

#[test]
fn deposit_to_unapproved_policy_is_rejected() {
    let mut env = setup();
    let sender = user(&mut env.test);
    let fake_policy = sender.account;
    let (e, acct, id, key, badge) = (env.escrow, sender.account, sender.id, sender.key.clone(), sender.badge.clone());
    ensure_open(&mut env.test, e, &ACCT.to_string());
    let tx = env
        .test
        .transaction()
        .call_method(acct, "withdraw", args![TARI_TOKEN, Amount::from(5_000u64)])
        .put_last_instruction_output_on_workspace("funds")
        .call_method(e, "deposit", args![ACCT.to_string(), id, 5u64, fake_policy, Bytes::from_vec(vec![]), Workspace("funds")])
        .build_and_seal(&key);
    env.test.execute_expect_failure(tx, vec![badge]);
}

#[test]
fn only_admin_can_approve() {
    let mut env = setup();
    let stranger = user(&mut env.test);
    let (e, acct, key, badge) = (env.escrow, stranger.account, stranger.key.clone(), stranger.badge.clone());
    // A non-admin signer cannot approve a policy.
    let tx = env
        .test
        .transaction()
        .call_method(e, "approve_policy", args![acct])
        .put_last_instruction_output_on_workspace("b")
        .call_method(acct, "deposit", args![Workspace("b")])
        .build_and_seal(&key);
    env.test.execute_expect_failure(tx, vec![badge]);
}

/// Deposits 1 000 µT for ACCT under `policy`, expecting it to be accepted (`true`) or refused.
fn try_deposit(env: &mut Env, who: &U, refund: u64, policy: ComponentAddress, expect_ok: bool) -> bool {
    let (e, acct, id, key, badge) = (env.escrow, who.account, who.id, who.key.clone(), who.badge.clone());
    ensure_open(&mut env.test, e, &ACCT.to_string());
    let tx = env
        .test
        .transaction()
        .call_method(acct, "withdraw", args![TARI_TOKEN, Amount::from(1_000u64)])
        .put_last_instruction_output_on_workspace("funds")
        .call_method(e, "deposit", args![ACCT.to_string(), id, refund, policy, Bytes::from_vec(vec![]), Workspace("funds")])
        .build_and_seal(&key);
    if expect_ok {
        env.test.execute_expect_success(tx, vec![badge]);
    } else {
        env.test.execute_expect_failure(tx, vec![badge]);
    }
    true
}

#[test]
fn a_full_lane_under_one_policy_does_not_block_another_and_refunds_are_bounded() {
    let mut env = setup();
    let griefer = user(&mut env.test);
    let honest = user(&mut env.test);
    let (lane_a, lane_b) = (griefer.account, honest.account); // stand-in policy addresses
    approve(&mut env, lane_a);
    approve(&mut env, lane_b);
    // A refund epoch more than 20 000 epochs out is refused, so nothing is locked indefinitely.
    try_deposit(&mut env, &griefer, 1 + 20_001, lane_a, false);
    try_deposit(&mut env, &griefer, 1 + 20_000, lane_a, true);
    // The griefer fills the account's lane under policy A...
    for _ in 1..64 {
        try_deposit(&mut env, &griefer, 100, lane_a, true);
    }
    try_deposit(&mut env, &griefer, 100, lane_a, false);
    // ...which does not stop deposits for the same account under policy B.
    try_deposit(&mut env, &honest, 100, lane_b, true);
}

fn component_bytes(env: &Env) -> usize {
    tari_bor::encode(&env.test.read_only_state_store().get_component(env.escrow).unwrap()).unwrap().len()
}

fn deposit_to(env: &mut Env, who: &U, account: &str, policy: ComponentAddress) -> tari_ootle_transaction::Transaction {
    env.test.transaction()
        .call_method(who.account, "withdraw", args![TARI_TOKEN, Amount::from(1_000u64)])
        .put_last_instruction_output_on_workspace("funds")
        .call_method(env.escrow, "deposit", args![account.to_string(), who.id, 100u64, policy, Bytes::from_vec(vec![]), Workspace("funds")])
        .build_and_seal(&who.key)
}

/// The bug this design fixes: every deposit used to sit in one 1 MiB component, so anyone could fill it with dust and
/// block new deposits for everybody. Now neither new accounts nor new deposits grow the shared component.
#[test]
fn deposits_and_accounts_do_not_grow_the_shared_component() {
    let mut env = setup();
    let who = user(&mut env.test);
    let policy = who.account;
    approve(&mut env, policy);
    let e = env.escrow;
    ensure_open(&mut env.test, e, "did:plc:first");
    let start = component_bytes(&env);
    for i in 0..30 {
        let id = format!("did:plc:acct{i}");
        ensure_open(&mut env.test, e, &id);
        let tx = deposit_to(&mut env, &who, &id, policy);
        env.test.execute_expect_success(tx, vec![who.badge.clone()]);
    }
    for _ in 0..30 {
        let tx = deposit_to(&mut env, &who, "did:plc:first", policy);
        env.test.execute_expect_success(tx, vec![who.badge.clone()]);
    }
    let end = component_bytes(&env);
    println!("ESCROW component bytes after 30 accounts and 60 deposits: {start} -> {end}");
    // only counters can change length; nothing is stored per account or per deposit
    assert!(end <= start + 8, "component grew from {start} to {end}");
    assert_eq!(env.test.call_method::<u64>(e, "account_count", args![], vec![]), 31);
    assert_eq!(env.test.call_method::<Amount>(e, "total_escrowed", args![], vec![]), Amount::from(60_000u64));
}

#[test]
fn an_account_opens_once_and_needs_opening_before_a_deposit() {
    let mut env = setup();
    let who = user(&mut env.test);
    let policy = who.account;
    approve(&mut env, policy);
    let e = env.escrow;
    // no ledger yet: the deposit fails, and the funds stay with the sender
    let before = env.test.call_method::<Amount>(who.account, "balance", args![TARI_TOKEN], vec![]);
    let tx = deposit_to(&mut env, &who, "did:plc:new", policy);
    env.test.execute_expect_failure(tx, vec![who.badge.clone()]);
    assert_eq!(env.test.call_method::<Amount>(who.account, "balance", args![TARI_TOKEN], vec![]), before);
    // opening and depositing in one transaction, which is what a client sends for a new account
    let tx = env.test.transaction()
        .call_method(e, "open_account", args!["did:plc:new".to_string()])
        .call_method(who.account, "withdraw", args![TARI_TOKEN, Amount::from(1_000u64)])
        .put_last_instruction_output_on_workspace("funds")
        .call_method(e, "deposit", args!["did:plc:new".to_string(), who.id, 100u64, policy, Bytes::from_vec(vec![]), Workspace("funds")])
        .build_and_seal(&who.key);
    env.test.execute_expect_success(tx, vec![who.badge.clone()]);
    // opening again fails and can't wipe what's there
    let tx = env.test.transaction().call_method(e, "open_account", args!["did:plc:new".to_string()]).build_and_seal(&who.key);
    env.test.execute_expect_failure(tx, vec![who.badge.clone()]);
    type D = Vec<(RistrettoPublicKeyBytes, Amount, u64, ComponentAddress, Bytes, u64)>;
    assert_eq!(env.test.call_method::<D>(e, "deposits_for", args!["did:plc:new".to_string()], vec![]).len(), 1);
}

#[test]
fn a_full_ledger_vault_is_replaced_and_old_accounts_keep_working() {
    let mut test = TemplateTest::new(CRATE_PATH, [ESCROW]);
    set_epoch(&mut test, 1);
    let template = test.get_template_address("Escrow");
    let admin = user(&mut test);
    // room for two ledgers per vault, so rotation happens quickly
    let tx = test.transaction().call_function(template, "new", args![TARI_TOKEN, Amount::from(1_000u64), admin.id, 2u32]).build_and_seal(&admin.key);
    test.execute_expect_success(tx, vec![admin.badge.clone()]);
    let escrow = test.get_previous_output_address(SubstateType::Component).as_component_address().unwrap();
    let mut env = Env { test, escrow, admin };
    let who = user(&mut env.test);
    let policy = who.account;
    approve(&mut env, policy);
    let e = env.escrow;
    for i in 0..7 {
        ensure_open(&mut env.test, e, &format!("did:plc:v{i}"));
    }
    assert_eq!(env.test.call_method::<u64>(e, "account_count", args![], vec![]), 7);
    // every vault stays within its limit
    let vaults = env.test.read_only_state_store().get_vaults_for_component(e).unwrap();
    let ledger: tari_template_lib::types::ResourceAddress = env.test.call_method(e, "ledger_resource", args![], vec![]);
    let sizes: Vec<usize> = vaults.values().filter(|v| *v.resource_address() == ledger).map(|v| v.get_non_fungible_ids().len()).collect();
    println!("ledger vault sizes: {sizes:?}");
    assert!(sizes.len() >= 4 && sizes.iter().all(|n| *n <= 2), "vault sizes {sizes:?}");
    // an account whose ledger sits in a full vault still takes deposits
    let tx = deposit_to(&mut env, &who, "did:plc:v0", policy);
    env.test.execute_expect_success(tx, vec![who.badge.clone()]);
    // a vault size outside the limits is refused
    let t2 = env.test.get_template_address("Escrow");
    let tx = env.test.transaction().call_function(t2, "new", args![TARI_TOKEN, Amount::from(1_000u64), who.id, 0u32]).build_and_seal(&who.key);
    env.test.execute_expect_failure(tx, vec![who.badge.clone()]);
    let tx = env.test.transaction().call_function(t2, "new", args![TARI_TOKEN, Amount::from(1_000u64), who.id, 20_001u32]).build_and_seal(&who.key);
    env.test.execute_expect_failure(tx, vec![who.badge.clone()]);
}

#[test]
fn a_stranger_cannot_move_a_ledger_or_empty_it() {
    let mut env = setup();
    let who = user(&mut env.test);
    let policy = who.account;
    approve(&mut env, policy);
    let e = env.escrow;
    ensure_open(&mut env.test, e, "did:plc:mine");
    let tx = deposit_to(&mut env, &who, "did:plc:mine", policy);
    env.test.execute_expect_success(tx, vec![who.badge.clone()]);
    // only the sender can refund, and only once it's refundable
    set_epoch(&mut env.test, 200);
    let stranger = user(&mut env.test);
    let tx = env.test.transaction().call_method(e, "refund", args!["did:plc:mine".to_string(), 0u32]).put_last_instruction_output_on_workspace("x").call_method(stranger.account, "deposit", args![Workspace("x")]).build_and_seal(&stranger.key);
    env.test.execute_expect_failure(tx, vec![stranger.badge.clone()]);
    // the ledger NFT can't be minted or rewritten directly from outside
    let ledger: tari_template_lib::types::ResourceAddress = env.test.call_method(e, "ledger_resource", args![], vec![]);
    let tx = env.test.transaction().call_method(stranger.account, "withdraw", args![ledger, Amount::from(1u64)]).put_last_instruction_output_on_workspace("x").call_method(stranger.account, "deposit", args![Workspace("x")]).build_and_seal(&stranger.key);
    env.test.execute_expect_failure(tx, vec![stranger.badge.clone()]);
    let tx = env.test.transaction().call_method(who.account, "withdraw", args![TARI_TOKEN, Amount::from(1u64)]).put_last_instruction_output_on_workspace("x").call_method(who.account, "deposit", args![Workspace("x")]).build_and_seal(&who.key);
    env.test.execute_expect_success(tx, vec![who.badge.clone()]);
    let tx = env.test.transaction().call_method(e, "refund", args!["did:plc:mine".to_string(), 0u32]).put_last_instruction_output_on_workspace("x").call_method(who.account, "deposit", args![Workspace("x")]).build_and_seal(&who.key);
    env.test.execute_expect_success(tx, vec![who.badge.clone()]);
    assert_eq!(env.test.call_method::<Amount>(e, "total_escrowed", args![], vec![]), Amount::zero());
}
