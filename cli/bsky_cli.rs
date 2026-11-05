//   SPDX-License-Identifier: BSD-3-Clause

//! BskyClaim CLI for Esmeralda: escrow tTARI for a Bluesky account and let its owner claim it.
//!
//!   bsky_cli addr | balance
//!   bsky_cli publish <bskyclaim.wasm>
//!   bsky_cli new <template> [min_deposit_µT] [window_epochs] [bot_did]
//!   bsky_cli deposit <component> <did> <amount_µT> <refund_in_epochs> [sender_wallet] [window_epochs] [challenge_phrase]
//!   bsky_cli code <component> <did> [claimant_wallet]        the text the claimant must post
//!   bsky_cli claim <component> <did> <proof.json> [claimant_wallet] [--submit]
//!   bsky_cli challenge <component> <did> <proof.json> [--submit]
//!   bsky_cli finalize <component> <did> [claimant_wallet]
//!   bsky_cli pending <component> <did>
//!
//! State lives in ~/.ringfence (wallet.json is the funded testnet wallet).

use std::{fs, path::PathBuf, str::FromStr};

use ootle_rs::{
    Network,
    ToAccountAddress,
    TransactionRequest,
    builtin_templates::{
        UnsignedTransactionBuilder,
        account::IAccount,
        component::{IComponent, TransactionBuildable},
    },
    default_indexer_url,
    key_provider::PrivateKeyProvider,
    keys::OotleSecretKey,
    provider::{IndexerProvider, ProviderBuilder, WalletProvider},
    template_types::{Amount, ComponentAddress, ResourceAddress, constants::TARI_TOKEN},
    wallet::OotleWallet,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tari_crypto::{
    keys::PublicKey as _,
    ristretto::{RistrettoPublicKey, RistrettoSecretKey},
    tari_utilities::{ByteArray, hex::Hex},
};
use tari_ootle_common_types::engine_types::published_template::PublishedTemplateAddress;
use tari_ootle_transaction::{Epoch, UnsignedTransaction, args};
use tari_template_lib_types::{bytes::Bytes, crypto::RistrettoPublicKeyBytes};

const NETWORK: Network = Network::Esmeralda;
const FEE_MARGIN_PCT: u64 = 50;

#[derive(Serialize, Deserialize)]
struct WalletFile {
    account_secret: String,
    view_secret: String,
}

fn state_dir() -> PathBuf {
    let dir = PathBuf::from(std::env::var("HOME").unwrap()).join(".ringfence");
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn load_named(name: &str) -> OotleSecretKey {
    let path = state_dir().join(format!("{name}.json"));
    if let Ok(s) = fs::read_to_string(&path) {
        let w: WalletFile = serde_json::from_str(&s).unwrap();
        return OotleSecretKey::new(
            NETWORK,
            RistrettoSecretKey::from_hex(&w.account_secret).unwrap(),
            RistrettoSecretKey::from_hex(&w.view_secret).unwrap(),
        );
    }
    let key = OotleSecretKey::random(NETWORK);
    let w = WalletFile { account_secret: key.account_secret().to_hex(), view_secret: key.view_only_secret().to_hex() };
    fs::write(&path, serde_json::to_string_pretty(&w).unwrap()).unwrap();
    println!("Created new wallet {name} at {}", path.display());
    key
}

fn identity_bytes(key: &OotleSecretKey) -> RistrettoPublicKeyBytes {
    let pk = RistrettoPublicKey::from_secret_key(key.account_secret());
    RistrettoPublicKeyBytes::from_bytes(pk.as_bytes()).unwrap()
}

async fn connect_as(name: &str) -> IndexerProvider<OotleWallet> {
    let wallet = OotleWallet::from(PrivateKeyProvider::new(load_named(name)));
    ProviderBuilder::new().wallet(wallet).connect(default_indexer_url(NETWORK)).await.expect("connect to indexer")
}

async fn max_epoch(p: &IndexerProvider<OotleWallet>) -> Epoch {
    Epoch(p.get_epoch().await.unwrap().as_u64() + 10)
}

fn hex_decode(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

async fn sign_dry_run_submit(p: &mut IndexerProvider<OotleWallet>, tx: UnsignedTransaction, submit: bool) {
    let dry = p.sign_and_send_dry_run(tx.clone()).await.expect("dry run");
    println!(
        "dry run: outcome={} fee={} µT wasm_pts={} native_pts={}",
        dry.finalize.result,
        dry.finalize.fee_receipt.total_fees_charged(),
        dry.wasm_execution_points,
        dry.native_execution_points
    );
    if !submit {
        return;
    }
    if dry.finalize.result.any_reject().is_some() {
        println!("refusing to submit: the dry run was rejected");
        return;
    }
    let tx = TransactionRequest::default().with_transaction(tx).build(p.wallet()).await.unwrap();
    let pending = p.send_transaction(tx).await.expect("submit");
    println!("submitted {}", pending.tx_id());
    let outcome = pending.watch().await.expect("watch");
    println!("outcome: {outcome:?}");
    let receipt = pending.get_receipt().await.expect("receipt");
    println!("fees paid: {} µT", receipt.fee_receipt.total_fees_paid());
    for up in receipt.diff_summary.upped.iter() {
        println!("  up: {}", up.substate_id);
    }
}

/// Submits a transaction and returns the first created (component, resource) addresses from its receipt,
/// so a deploy can chain one instantiation's output into the next without reading method return values
/// (the live indexer omits `execution_results`).
async fn submit_new(p: &mut IndexerProvider<OotleWallet>, tx: UnsignedTransaction) -> (Option<ComponentAddress>, Option<ResourceAddress>) {
    let dry = p.sign_and_send_dry_run(tx.clone()).await.expect("dry run");
    if let Some(r) = dry.finalize.result.any_reject() {
        panic!("dry run rejected: {r:?}");
    }
    let req = TransactionRequest::default().with_transaction(tx).build(p.wallet()).await.unwrap();
    let pending = p.send_transaction(req).await.expect("submit");
    pending.watch().await.expect("watch");
    let receipt = pending.get_receipt().await.expect("receipt");
    let (mut comp, mut res) = (None, None);
    for up in receipt.diff_summary.upped.iter() {
        if comp.is_none() {
            comp = up.substate_id.as_component_address();
        }
        if res.is_none() {
            res = up.substate_id.as_resource_address();
        }
    }
    println!("  submitted {} -> component={comp:?} resource={res:?}", pending.tx_id());
    (comp, res)
}

async fn fee_for(p: &IndexerProvider<OotleWallet>, tx: UnsignedTransaction) -> u64 {
    let dry = p.sign_and_send_dry_run(tx).await.expect("dry run");
    let receipt = &dry.finalize.fee_receipt;
    let fee = receipt.total_fees_charged().max(receipt.total_fees_paid());
    (2 * fee + fee * FEE_MARGIN_PCT / 100).max(20_000)
}

struct Proof {
    ops: Vec<Bytes>,
    commit: Bytes,
    nodes: Vec<Bytes>,
    record: Bytes,
    rkey: String,
}

fn load_proof(path: &str) -> Proof {
    let v: Value = serde_json::from_str(&fs::read_to_string(path).expect("read proof")).unwrap();
    let list = |k: &str| -> Vec<Bytes> {
        v[k].as_array().unwrap().iter().map(|x| Bytes::from_vec(hex_decode(x.as_str().unwrap()))).collect()
    };
    Proof {
        ops: list("plcOps"),
        commit: Bytes::from_vec(hex_decode(v["commit"].as_str().unwrap())),
        nodes: list("mstNodes"),
        record: Bytes::from_vec(hex_decode(v["record"].as_str().unwrap())),
        rkey: v["rkey"].as_str().unwrap().to_string(),
    }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let submit = args.iter().any(|a| a == "--submit");
    let args: Vec<String> = args.into_iter().filter(|a| a != "--submit").collect();
    let cmd = args.first().map(String::as_str).unwrap_or("addr");
    let arg = |i: usize, default: &str| args.get(i).cloned().unwrap_or_else(|| default.to_string());
    match cmd {
        "addr" => {
            let key = load_named("wallet");
            println!("address: {}\naccount: {}", key.to_address(), key.to_address().to_account_address());
        },
        "balance" => {
            let p = connect_as("wallet").await;
            let account = load_named(&arg(1, "wallet")).to_address().to_account_address();
            match p.get_account_balances(account).await {
                Ok(b) => b.iter().for_each(|(r, a)| println!("{r}: {a}")),
                Err(e) => println!("no balance yet ({e})"),
            }
        },
        "publish" => {
            let wasm = fs::read(&args[1]).expect("read wasm");
            println!("template binary: {} bytes", wasm.len());
            let mut p = connect_as("wallet").await;
            let me = max_epoch(&p).await;
            let probe = IAccount::new(&p, me).pay_fee(8_000_000u64).publish_template(wasm.clone()).prepare().await.unwrap();
            let fee = fee_for(&p, probe).await;
            // a budget above the balance can't be funded; the actual charge is usually well under it
            let fee = fee.min(arg(2, "99999999999").parse().unwrap());
            println!("publish fee budget {fee} µT");
            let tx = IAccount::new(&p, me).pay_fee(fee).publish_template(wasm).prepare().await.unwrap();
            sign_dry_run_submit(&mut p, tx, submit).await;
            if !submit {
                println!("(dry run only; add --submit to publish)");
            }
        },
        // fund <otl_esm_… address> <amount_µT>: public transfer from the main wallet (testnet funding).
        "fund" => {
            let to = tari_ootle_address::OotleAddress::from_str(&args[1]).expect("recipient address");
            let amount: u64 = args[2].parse().unwrap();
            let mut p = connect_as(&arg(3, "wallet")).await;
            let me = max_epoch(&p).await;
            let tx = IAccount::new(&p, me)
                .pay_fee(40_000u64)
                .public_transfer(&to, TARI_TOKEN, amount)
                .prepare()
                .await
                .unwrap();
            sign_dry_run_submit(&mut p, tx, submit).await;
        },
        "new" => {
            let template = PublishedTemplateAddress::from_str(&args[1]).expect("template address");
            let min: u64 = arg(2, "1000").parse().unwrap();
            let window: u64 = arg(3, "2").parse().unwrap();
            let bot_did = arg(4, "did:plc:lsdjnz7b7du3e3rkawynfsqd");
            // epochs a new link waits before it takes effect (an epoch is about half an hour)
            let bind_delay: u64 = arg(5, "0").parse().unwrap();
            let mut p = connect_as("wallet").await;
            let me = max_epoch(&p).await;
            let call = |fee: u64| {
                IComponent::new(&p, me)
                    .call_function(template.as_template_address(), "new", args![
                        TARI_TOKEN,
                        Amount::new(u128::from(min)),
                        window,
                        bot_did.clone(),
                        bind_delay
                    ])
                    .pay_fee(fee)
                    .prepare()
            };
            let fee = fee_for(&p, call(5_000_000).await.unwrap()).await;
            let tx = call(fee).await.unwrap();
            sign_dry_run_submit(&mut p, tx, submit).await;
        },
        // deploy-stack <escrow_t> <claim_t> <tip_t> <eb_t> <link_t> <verifier_t> [min_deposit] [bot_did] [bind_delay] [service_pay_t|-] [social_recovery_t|-] [list_drop_t]
        "deploy-stack" => {
            let tmpl = |i: usize| PublishedTemplateAddress::from_str(&args[i]).expect("template address");
            let (escrow_t, claim_t, tip_t, eb_t, link_t, verifier_t) = (tmpl(1), tmpl(2), tmpl(3), tmpl(4), tmpl(5), tmpl(6));
            let min: u64 = arg(7, "1000").parse().unwrap();
            let bot_did = arg(8, "did:plc:lsdjnz7b7du3e3rkawynfsqd");
            let bind_delay: u64 = arg(9, "0").parse().unwrap();
            let admin = identity_bytes(&load_named("wallet"));
            let mut p = connect_as("wallet").await;

            println!("verifier.new");
            let me = max_epoch(&p).await;
            let tx = IComponent::new(&p, me).call_function(verifier_t.as_template_address(), "new", args![]).pay_fee(8_000_000u64).prepare().await.unwrap();
            let (verifier_c, _) = submit_new(&mut p, tx).await;

            println!("escrow.new");
            let me = max_epoch(&p).await;
            let tx = IComponent::new(&p, me).call_function(escrow_t.as_template_address(), "new", args![TARI_TOKEN, Amount::new(u128::from(min)), admin]).pay_fee(8_000_000u64).prepare().await.unwrap();
            let (escrow_c, badge_res) = submit_new(&mut p, tx).await;
            let escrow_c = escrow_c.expect("escrow component");
            let badge_res = badge_res.expect("policy badge resource");

            // The registry comes first: every policy takes it in its constructor (no setter, so no window in
            // which someone else could point a policy at a registry of their own).
            println!("link_registry.new");
            let me = max_epoch(&p).await;
            let tx = IComponent::new(&p, me).call_function(link_t.as_template_address(), "new", args![bind_delay]).pay_fee(8_000_000u64).prepare().await.unwrap();
            let (link_c, _) = submit_new(&mut p, tx).await;
            let link_c = link_c.expect("link component");

            println!("claim.new");
            let me = max_epoch(&p).await;
            let tx = IComponent::new(&p, me).call_function(claim_t.as_template_address(), "new", args![escrow_c, badge_res, link_c]).pay_fee(8_000_000u64).prepare().await.unwrap();
            let (claim_c, _) = submit_new(&mut p, tx).await;
            let claim_c = claim_c.expect("claim component");

            println!("tip.new");
            let me = max_epoch(&p).await;
            let tx = IComponent::new(&p, me).call_function(tip_t.as_template_address(), "new", args![escrow_c, claim_c, TARI_TOKEN, badge_res, bot_did.clone(), link_c]).pay_fee(8_000_000u64).prepare().await.unwrap();
            let (tip_c, _) = submit_new(&mut p, tx).await;
            let tip_c = tip_c.expect("tip component");

            println!("engagement_bounty.new");
            let me = max_epoch(&p).await;
            let tx = IComponent::new(&p, me).call_function(eb_t.as_template_address(), "new", args![escrow_c, badge_res, link_c]).pay_fee(8_000_000u64).prepare().await.unwrap();
            let (eb_c, _) = submit_new(&mut p, tx).await;
            let eb_c = eb_c.expect("engagement-bounty component");

            // Optional extra policies after bind_delay: [service_pay_t] [social_recovery_t] [list_drop_t];
            // pass "-" to skip one.
            let mut extra: Vec<(&str, ComponentAddress)> = vec![];
            for (i, name) in [(10, "service_pay"), (11, "social_recovery"), (12, "list_drop")] {
                let Some(t) = args.get(i).filter(|t| t.as_str() != "-") else { continue };
                println!("{name}.new");
                let t = PublishedTemplateAddress::from_str(t).expect("policy template address");
                let ctor = if name == "service_pay" { args![escrow_c, badge_res, TARI_TOKEN, link_c] } else { args![escrow_c, badge_res, link_c] };
                let me = max_epoch(&p).await;
                let tx = IComponent::new(&p, me).call_function(t.as_template_address(), "new", ctor).pay_fee(8_000_000u64).prepare().await.unwrap();
                extra.push((name, submit_new(&mut p, tx).await.0.expect("policy component")));
            }

            for (name, pol) in [("claim", claim_c), ("tip", tip_c), ("engagement_bounty", eb_c)].into_iter().chain(extra.iter().copied()) {
                println!("approve_policy + receive_badge: {name}");
                let me = max_epoch(&p).await;
                let tx = IComponent::new(&p, me)
                    .call_method(escrow_c, "approve_policy", args![pol])
                    .put_last_instruction_output_on_workspace("badge")
                    .call_method(pol, "receive_badge", args![Workspace("badge")])
                    .pay_fee(8_000_000u64)
                    .prepare()
                    .await
                    .unwrap();
                submit_new(&mut p, tx).await;
            }

            println!("\n=== DEPLOYED (Esmeralda) ===");
            println!("verifier  {verifier_c:?}");
            println!("escrow    {escrow_c}");
            println!("claim     {claim_c}");
            println!("tip       {tip_c}");
            println!("bounty    {eb_c}");
            println!("link      {link_c}");
            for (name, c) in &extra {
                println!("{name} {c}");
            }
            println!("badge_res {badge_res}");
        },
        "deposit" => {
            let component = ComponentAddress::from_str(&args[1]).unwrap();
            let did = args[2].clone();
            let amount: u64 = args[3].parse().unwrap();
            let refund_in: u64 = args[4].parse().unwrap();
            let window: u64 = arg(6, "2").parse().unwrap();
            let challenge = arg(7, "");
            let hold: u64 = arg(8, "0").parse().unwrap();
            let sender = load_named(&arg(5, "wallet"));
            let sender_id = identity_bytes(&sender);
            let account = sender.to_address().to_account_address();
            let mut p = connect_as(&arg(5, "wallet")).await;
            let me = max_epoch(&p).await;
            let refund_epoch = p.get_epoch().await.unwrap().as_u64() + refund_in;
            let call = |fee: u64| {
                IComponent::new(&p, me)
                    .want_vault_for(account, TARI_TOKEN, true)
                    .then(|b| {
                        b.call_method(account, "withdraw", args![TARI_TOKEN, Amount::new(u128::from(amount))])
                            .put_last_instruction_output_on_workspace("funds")
                    })
                    .call_method(component, "deposit", args![did.clone(), sender_id, refund_epoch, window, challenge.clone(), hold, Bytes::from_vec(Vec::new()), Workspace("funds")])
                    .pay_fee(fee)
                    .prepare()
            };
            let fee = fee_for(&p, call(5_000_000).await.unwrap()).await;
            let tx = call(fee).await.unwrap();
            sign_dry_run_submit(&mut p, tx, submit).await;
        },
        // fundfees <component> <amount_µT>: top up the vault that pays claimants' network fees.
        "fundfees" => {
            let component = ComponentAddress::from_str(&args[1]).unwrap();
            let amount: u64 = args[2].parse().unwrap();
            let account = load_named("wallet").to_address().to_account_address();
            let mut p = connect_as("wallet").await;
            let me = max_epoch(&p).await;
            let call = |fee: u64| {
                IComponent::new(&p, me)
                    .want_vault_for(account, TARI_TOKEN, true)
                    .then(|b| {
                        b.call_method(account, "withdraw", args![TARI_TOKEN, Amount::new(u128::from(amount))])
                            .put_last_instruction_output_on_workspace("funds")
                    })
                    .call_method(component, "fund", args![Workspace("funds")])
                    .pay_fee(fee)
                    .prepare()
            };
            let fee = fee_for(&p, call(5_000_000).await.unwrap()).await;
            let tx = call(fee).await.unwrap();
            sign_dry_run_submit(&mut p, tx, submit).await;
        },
        "code" => {
            let component = ComponentAddress::from_str(&args[1]).unwrap();
            let claimant = identity_bytes(&load_named(&arg(3, "wallet")));
            let p = connect_as("wallet").await;
            let me = max_epoch(&p).await;
            let tx = IComponent::new(&p, me)
                .call_method(component, "expected_post_text", args![args[2].clone(), claimant])
                .pay_fee(20_000u64)
                .prepare()
                .await
                .unwrap();
            let dry = p.sign_and_send_dry_run(tx).await.expect("dry run");
            let text: String = dry.finalize.execution_results.last().expect("result").decode().expect("string");
            println!("{text}");
        },
        "claim" | "challenge" => {
            let component = ComponentAddress::from_str(&args[1]).unwrap();
            let did = args[2].clone();
            let proof = load_proof(&args[3]);
            let name = if cmd == "claim" { arg(4, "wallet") } else { "wallet".to_string() };
            let claimant = identity_bytes(&load_named(&name));
            let mut p = connect_as(&name).await;
            let me = max_epoch(&p).await;
            let call = |fee: u64| {
                let b = IComponent::new(&p, me);
                if cmd == "claim" {
                    b.call_method(component, "start_claim", args![
                        did.clone(),
                        claimant,
                        proof.ops.clone(),
                        proof.commit.clone(),
                        proof.nodes.clone(),
                        proof.record.clone(),
                        proof.rkey.clone()
                    ])
                } else {
                    b.call_method(component, "challenge", args![did.clone(), proof.ops.clone()])
                }
                .pay_fee(fee)
                .prepare()
            };
            let fee = fee_for(&p, call(8_000_000).await.unwrap()).await;
            let tx = call(fee).await.unwrap();
            sign_dry_run_submit(&mut p, tx, submit).await;
        },
        "finalize" => {
            let component = ComponentAddress::from_str(&args[1]).unwrap();
            let did = args[2].clone();
            let name = arg(3, "wallet");
            let account = load_named(&name).to_address().to_account_address();
            let mut p = connect_as(&name).await;
            let me = max_epoch(&p).await;
            let call = |fee: u64| {
                IComponent::new(&p, me)
                    .want_vault_for(account, TARI_TOKEN, true)
                    .then(|b| {
                        b.call_method(component, "finalize_claim", args![did.clone()])
                            .put_last_instruction_output_on_workspace("paid")
                    })
                    .call_method(account, "deposit", args![Workspace("paid")])
                    .pay_fee(fee)
                    .prepare()
            };
            let fee = fee_for(&p, call(5_000_000).await.unwrap()).await;
            let tx = call(fee).await.unwrap();
            sign_dry_run_submit(&mut p, tx, submit).await;
        },
        "pending" => {
            let component = ComponentAddress::from_str(&args[1]).unwrap();
            let p = connect_as("wallet").await;
            let me = max_epoch(&p).await;
            for m in ["pending_for", "deposits_for"] {
                let tx = IComponent::new(&p, me)
                    .call_method(component, m, args![args[2].clone()])
                    .pay_fee(20_000u64)
                    .prepare()
                    .await
                    .unwrap();
                let dry = p.sign_and_send_dry_run(tx).await.expect("dry run");
                let r = dry.finalize.execution_results.last().expect("result");
                println!("{m}: {:?}", r.indexed.value());
            }
            println!("current epoch: {}", p.get_epoch().await.unwrap().as_u64());
        },
        other => eprintln!("unknown command {other}"),
    }
    let _ = (ResourceAddress::from_str as fn(&str) -> _,);
}
