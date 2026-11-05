//   SPDX-License-Identifier: BSD-3-Clause
//! The Escrow's own rules, checked against approved policies that misbehave. Each test here exists because removing
//! the rule it covers once went unnoticed by every other suite (see scripts/wsl-mutate-escrow.sh).

use tari_crypto::{keys::PublicKey as _, ristretto::{RistrettoPublicKey, RistrettoSecretKey}, tari_utilities::ByteArray};
use tari_engine_types::virtual_substate::{VirtualSubstate, VirtualSubstateId};
use tari_ootle_common_types::substate_type::SubstateType;
use tari_ootle_transaction::args;
use tari_template_lib::types::{Amount, ComponentAddress, NonFungibleAddress, ResourceAddress, bytes::Bytes, constants::TARI_TOKEN, crypto::RistrettoPublicKeyBytes};
use tari_template_test_tooling::TemplateTest;

const CRATE_PATH: &str = env!("CARGO_MANIFEST_DIR");
const ACCT: &str = "did:plc:abcdefghijklmnopqrstuvwx";
type Dep = (RistrettoPublicKeyBytes, Amount, u64, ComponentAddress, Bytes, u64);

struct U { account: ComponentAddress, badge: NonFungibleAddress, key: RistrettoSecretKey, id: RistrettoPublicKeyBytes }

fn user(test: &mut TemplateTest) -> U {
    let (account, badge, key) = test.create_funded_account();
    let id = RistrettoPublicKeyBytes::from_bytes(RistrettoPublicKey::from_secret_key(&key).as_bytes()).unwrap();
    U { account, badge, key, id }
}

struct Env { test: TemplateTest, escrow: ComponentAddress, a: ComponentAddress, b: ComponentAddress, sender: U }

fn setup() -> Env {
    let mut test = TemplateTest::new(CRATE_PATH, ["tests/templates/escrow", "tests/templates/escrow-probe"]);
    test.set_virtual_substate(VirtualSubstateId::CurrentEpoch, VirtualSubstate::CurrentEpoch(1));
    let escrow_t = test.get_template_address("Escrow");
    let probe_t = test.get_template_address("EscrowProbe");
    let admin = user(&mut test);
    let tx = test.transaction().call_function(escrow_t, "new", args![TARI_TOKEN, Amount::from(1_000u64), admin.id, 20_000u32]).build_and_seal(&admin.key);
    test.execute_expect_success(tx, vec![admin.badge.clone()]);
    let escrow = test.get_previous_output_address(SubstateType::Component).as_component_address().unwrap();
    let badge_res: ResourceAddress = test.call_method(escrow, "policy_badge_resource", args![], vec![]);
    let mut probes = vec![];
    for _ in 0..2 {
        let tx = test.transaction().call_function(probe_t, "new", args![escrow, badge_res]).build_and_seal(&admin.key);
        test.execute_expect_success(tx, vec![admin.badge.clone()]);
        let probe = test.get_previous_output_address(SubstateType::Component).as_component_address().unwrap();
        let tx = test.transaction()
            .call_method(escrow, "approve_policy", args![probe])
            .put_last_instruction_output_on_workspace("b")
            .call_method(probe, "receive_badge", args![Workspace("b")])
            .build_and_seal(&admin.key);
        test.execute_expect_success(tx, vec![admin.badge.clone()]);
        probes.push(probe);
    }
    let sender = user(&mut test);
    let tx = test.transaction().call_method(escrow, "open_account", args![ACCT.to_string()]).build_and_seal(&sender.key);
    test.execute_expect_success(tx, vec![sender.badge.clone()]);
    Env { test, escrow, a: probes[0], b: probes[1], sender }
}

fn deposit(env: &mut Env, amount: u64, refund: u64, policy: ComponentAddress) -> tari_ootle_transaction::Transaction {
    env.test.transaction()
        .call_method(env.sender.account, "withdraw", args![TARI_TOKEN, Amount::from(amount)])
        .put_last_instruction_output_on_workspace("funds")
        .call_method(env.escrow, "deposit", args![ACCT.to_string(), env.sender.id, refund, policy, Bytes::from_vec(vec![]), Workspace("funds")])
        .build_and_seal(&env.sender.key)
}

fn deposit_ok(env: &mut Env, amount: u64, refund: u64, policy: ComponentAddress) {
    let tx = deposit(env, amount, refund, policy);
    let badge = env.sender.badge.clone();
    env.test.execute_expect_success(tx, vec![badge]);
}

fn fail_with(env: &mut Env, tx: tari_ootle_transaction::Transaction, badge: NonFungibleAddress, why: &str) {
    let reason = format!("{:?}", env.test.execute_expect_failure(tx, vec![badge]));
    assert!(reason.contains(why), "expected failure {why:?}, got: {reason}");
}

fn deposits(env: &mut Env) -> Vec<Dep> {
    env.test.call_method(env.escrow, "deposits_for", args![ACCT.to_string()], vec![])
}

fn refund_tx(env: &Env, index: u32) -> tari_ootle_transaction::Transaction {
    env.test.transaction()
        .call_method(env.escrow, "refund", args![ACCT.to_string(), index])
        .put_last_instruction_output_on_workspace("back")
        .call_method(env.sender.account, "deposit", args![Workspace("back")])
        .build_and_seal(&env.sender.key)
}

fn balance(env: &mut Env) -> Amount {
    env.test.call_method(env.sender.account, "balance", args![TARI_TOKEN], vec![])
}

fn fund_fee_vault(env: &mut Env, amount: u64) {
    let tx = env.test.transaction()
        .call_method(env.sender.account, "withdraw", args![TARI_TOKEN, Amount::from(amount)])
        .put_last_instruction_output_on_workspace("f")
        .call_method(env.escrow, "fund", args![Workspace("f")])
        .build_and_seal(&env.sender.key);
    let badge = env.sender.badge.clone();
    env.test.execute_expect_success(tx, vec![badge]);
}

fn draw_fee(env: &mut Env, policy: ComponentAddress, fee: u64) -> tari_ootle_transaction::Transaction {
    env.test.transaction()
        .with_fee_instructions_builder(|b| b.call_method(policy, "draw_fee", args![ACCT.to_string(), Amount::from(fee)]))
        .build_and_seal(&env.sender.key)
}

#[test]
fn a_policy_cannot_touch_a_deposit_pinned_to_another() {
    let mut env = setup();
    let (a, b) = (env.a, env.b);
    deposit_ok(&mut env, 5_000, 100, b);
    let other = user(&mut env.test);

    // policy A tries everything against policy B's deposit
    let tx = env.test.transaction().call_method(a, "release", args![ACCT.to_string(), 0u32]).put_last_instruction_output_on_workspace("x").call_method(other.account, "deposit", args![Workspace("x")]).build_and_seal(&other.key);
    fail_with(&mut env, tx, other.badge.clone(), "governed by another policy");
    let tx = env.test.transaction().call_method(a, "release_to", args![ACCT.to_string(), 0u32, other.account]).build_and_seal(&other.key);
    fail_with(&mut env, tx, other.badge.clone(), "governed by another policy");
    let tx = env.test.transaction().call_method(a, "give_back", args![ACCT.to_string(), 0u32]).build_and_seal(&other.key);
    fail_with(&mut env, tx, other.badge.clone(), "governed by another policy");
    assert_eq!(deposits(&mut env).len(), 1);

    // the policy it's pinned to can
    let before = env.test.call_method::<Amount>(other.account, "balance", args![TARI_TOKEN], vec![]);
    let tx = env.test.transaction().call_method(b, "release_to", args![ACCT.to_string(), 0u32, other.account]).build_and_seal(&other.key);
    env.test.execute_expect_success(tx, vec![other.badge.clone()]);
    assert_eq!(env.test.call_method::<Amount>(other.account, "balance", args![TARI_TOKEN], vec![]), before + Amount::from(5_000u64));
    assert_eq!(env.test.call_method::<Amount>(env.escrow, "total_escrowed", args![], vec![]), Amount::zero());
}

#[test]
fn a_returned_deposit_is_out_of_every_policys_reach() {
    let mut env = setup();
    let a = env.a;
    deposit_ok(&mut env, 5_000, 100, a);
    let other = user(&mut env.test);
    let tx = env.test.transaction().call_method(a, "give_back", args![ACCT.to_string(), 0u32]).build_and_seal(&other.key);
    env.test.execute_expect_success(tx, vec![other.badge.clone()]);
    let tx = env.test.transaction().call_method(a, "release_to", args![ACCT.to_string(), 0u32, other.account]).build_and_seal(&other.key);
    fail_with(&mut env, tx, other.badge.clone(), "governed by another policy");
    // nobody but its sender gets it
    let tx = env.test.transaction().call_method(env.escrow, "refund", args![ACCT.to_string(), 0u32]).put_last_instruction_output_on_workspace("x").call_method(other.account, "deposit", args![Workspace("x")]).build_and_seal(&other.key);
    env.test.execute_expect_failure(tx, vec![other.badge.clone()]);
    let before = balance(&mut env);
    let tx = refund_tx(&env, 0);
    let badge = env.sender.badge.clone();
    env.test.execute_expect_success(tx, vec![badge]);
    assert_eq!(balance(&mut env), before + Amount::from(5_000u64));
}

#[test]
fn a_refund_waits_for_its_epoch_and_small_deposits_are_refused() {
    let mut env = setup();
    let a = env.a;
    let sb = env.sender.badge.clone();
    let tx = deposit(&mut env, 999, 100, a);
    fail_with(&mut env, tx, sb.clone(), "below the minimum");
    deposit_ok(&mut env, 1_000, 100, a);
    let tx = refund_tx(&env, 0);
    fail_with(&mut env, tx, sb.clone(), "not refundable yet");
    env.test.set_virtual_substate(VirtualSubstateId::CurrentEpoch, VirtualSubstate::CurrentEpoch(100));
    let tx = refund_tx(&env, 0);
    env.test.execute_expect_success(tx, vec![sb]);
}

#[test]
fn returned_money_does_not_back_fees_or_pay_them() {
    let mut env = setup();
    let (a, b) = (env.a, env.b);
    let sb = env.sender.badge.clone();
    fund_fee_vault(&mut env, 2_000_000);

    // only returned money in the ledger: it can't back a fee, because it's on its way back to its sender
    deposit_ok(&mut env, 500_000, 100, a);
    let tx = env.test.transaction().call_method(a, "give_back", args![ACCT.to_string(), 0u32]).build_and_seal(&env.sender.key);
    env.test.execute_expect_success(tx, vec![sb.clone()]);
    env.test.enable_fees();
    let tx = draw_fee(&mut env, b, 60_000);
    let refused = env.test.execute_expect_failure(tx, vec![sb.clone()]);
    env.test.disable_fees();
    assert!(format!("{refused:?}").contains("too small"), "expected a refusal for lack of backing, got {refused:?}");

    // a live deposit backs the fee, so the account now owes it
    deposit_ok(&mut env, 500_000, 100, b);
    env.test.enable_fees();
    let tx = draw_fee(&mut env, b, 60_000);
    env.test.execute_expect_success(tx, vec![sb.clone()]);
    env.test.disable_fees();

    // the returned deposit's sender still gets all of it: someone else's fee doesn't come out of returned money
    let before = balance(&mut env);
    let list = deposits(&mut env);
    let at = list.iter().position(|d| d.3 == env.escrow).expect("the returned deposit") as u32;
    let tx = refund_tx(&env, at);
    env.test.execute_expect_success(tx, vec![sb.clone()]);
    assert_eq!(balance(&mut env), before + Amount::from(500_000u64));

    // the fee is repaid when the live deposit pays out
    let vault_before = env.test.call_method::<Amount>(env.escrow, "fee_balance", args![], vec![]);
    let other = user(&mut env.test);
    let tx = env.test.transaction().call_method(b, "release_to", args![ACCT.to_string(), 0u32, other.account]).build_and_seal(&other.key);
    let got_before = env.test.call_method::<Amount>(other.account, "balance", args![TARI_TOKEN], vec![]);
    env.test.execute_expect_success(tx, vec![other.badge.clone()]);
    assert_eq!(env.test.call_method::<Amount>(other.account, "balance", args![TARI_TOKEN], vec![]), got_before + Amount::from(440_000u64));
    assert_eq!(env.test.call_method::<Amount>(env.escrow, "fee_balance", args![], vec![]), vault_before + Amount::from(60_000u64));
    assert_eq!(env.test.call_method::<Amount>(env.escrow, "total_escrowed", args![], vec![]), Amount::zero());
}

#[test]
fn returning_a_deposit_repays_what_the_account_owes_once() {
    let mut env = setup();
    let a = env.a;
    let sb = env.sender.badge.clone();
    fund_fee_vault(&mut env, 2_000_000);
    deposit_ok(&mut env, 500_000, 100, a);
    env.test.enable_fees();
    let tx = draw_fee(&mut env, a, 60_000);
    env.test.execute_expect_success(tx, vec![sb.clone()]);
    env.test.disable_fees();
    let tx = env.test.transaction().call_method(a, "give_back", args![ACCT.to_string(), 0u32]).build_and_seal(&env.sender.key);
    env.test.execute_expect_success(tx, vec![sb.clone()]);
    assert_eq!(env.test.call_method::<Amount>(env.escrow, "returned_for", args![ACCT.to_string(), env.sender.id], vec![]), Amount::from(440_000u64));
    let before = balance(&mut env);
    let tx = refund_tx(&env, 0);
    env.test.execute_expect_success(tx, vec![sb]);
    assert_eq!(balance(&mut env), before + Amount::from(440_000u64));
    assert_eq!(env.test.call_method::<Amount>(env.escrow, "total_escrowed", args![], vec![]), Amount::zero());
}
