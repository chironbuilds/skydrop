//   SPDX-License-Identifier: BSD-3-Clause
//! End-to-end test of SocialRecovery: Bluesky guardians move a vault to a new wallet after a delay the owner can veto.

use k256::ecdsa::{SigningKey, signature::Signer as _};
use sha2::{Digest, Sha256};
use tari_crypto::{keys::PublicKey as _, ristretto::{RistrettoPublicKey, RistrettoSecretKey}, tari_utilities::ByteArray};
use tari_engine_types::virtual_substate::{VirtualSubstate, VirtualSubstateId};
use tari_ootle_common_types::substate_type::SubstateType;
use tari_ootle_transaction::args;
use tari_template_lib::types::{Amount, ComponentAddress, NonFungibleAddress, ResourceAddress, bytes::Bytes, constants::TARI_TOKEN, crypto::RistrettoPublicKeyBytes};
use tari_template_test_tooling::TemplateTest;
/// Opens an account's ledger if it isn't open yet. The engine has no "does it exist" check, so this just tries.
fn ensure_open(test: &mut tari_template_test_tooling::TemplateTest, escrow: tari_template_lib::types::ComponentAddress, id: &str) {
    let tx = test.transaction().call_method(escrow, "open_account", args![id.to_string()]).build_and_seal(test.secret_key());
    let _ = test.execute_and_commit_on_success(tx, vec![]);
}

const CRATE_PATH: &str = env!("CARGO_MANIFEST_DIR");
const ESCROW: &str = "tests/templates/escrow";
const LINK: &str = "tests/templates/link-registry";
const REC: &str = "tests/templates/social-recovery";

// ---- DAG-CBOR builder ------------------------------------------------------------------------------
enum V { U(u64), T(String), B(Vec<u8>), A(Vec<V>), M(Vec<(&'static str, V)>), Link([u8; 32]), Null }
fn head(major: u8, n: u64, out: &mut Vec<u8>) {
    let m = major << 5;
    match n {
        0..=23 => out.push(m | n as u8),
        24..=0xff => out.extend_from_slice(&[m | 24, n as u8]),
        0x100..=0xffff => { out.push(m | 25); out.extend_from_slice(&(n as u16).to_be_bytes()); }
        _ => { out.push(m | 26); out.extend_from_slice(&(n as u32).to_be_bytes()); }
    }
}
fn enc(v: &V, out: &mut Vec<u8>) {
    match v {
        V::U(n) => head(0, *n, out),
        V::T(s) => { head(3, s.len() as u64, out); out.extend_from_slice(s.as_bytes()); }
        V::B(b) => { head(2, b.len() as u64, out); out.extend_from_slice(b); }
        V::A(items) => { head(4, items.len() as u64, out); items.iter().for_each(|i| enc(i, out)); }
        V::M(entries) => {
            let mut sorted: Vec<_> = entries.iter().collect();
            sorted.sort_by(|a, b| (a.0.len(), a.0.as_bytes()).cmp(&(b.0.len(), b.0.as_bytes())));
            head(5, sorted.len() as u64, out);
            for (k, val) in sorted { enc(&V::T((*k).to_string()), out); enc(val, out); }
        }
        V::Link(d) => { head(6, 42, out); head(2, 37, out); out.extend_from_slice(&[0x00, 0x01, 0x71, 0x12, 0x20]); out.extend_from_slice(d); }
        V::Null => out.push(0xf6),
    }
}
fn cbor(v: &V) -> Vec<u8> { let mut o = Vec::new(); enc(v, &mut o); o }
fn sha(data: &[u8]) -> [u8; 32] { Sha256::digest(data).into() }
const B32: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
fn base32(data: &[u8]) -> String {
    let (mut out, mut acc, mut bits) = (String::new(), 0u32, 0);
    for &b in data { acc = (acc << 8) | b as u32; bits += 8; while bits >= 5 { bits -= 5; out.push(B32[((acc >> bits) & 31) as usize] as char); } }
    if bits > 0 { out.push(B32[((acc << (5 - bits)) & 31) as usize] as char); }
    out
}
fn base64url(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let (mut out, mut acc, mut bits) = (String::new(), 0u32, 0);
    for &b in data { acc = (acc << 8) | b as u32; bits += 8; while bits >= 6 { bits -= 6; out.push(T[((acc >> bits) & 63) as usize] as char); } }
    if bits > 0 { out.push(T[((acc << (6 - bits)) & 63) as usize] as char); }
    out
}
fn base58(data: &[u8]) -> String {
    const T: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut digits: Vec<u8> = Vec::new();
    for &byte in data {
        let mut carry = byte as u32;
        for d in digits.iter_mut() { carry += (*d as u32) << 8; *d = (carry % 58) as u8; carry /= 58; }
        while carry > 0 { digits.push((carry % 58) as u8); carry /= 58; }
    }
    let mut s: String = data.iter().take_while(|b| **b == 0).map(|_| '1').collect();
    s.extend(digits.iter().rev().map(|d| T[*d as usize] as char));
    s
}
fn did_key(k: &SigningKey) -> String {
    let mut raw = vec![0xe7, 0x01];
    raw.extend_from_slice(k.verifying_key().to_encoded_point(true).as_bytes());
    format!("did:key:z{}", base58(&raw))
}
fn sign(k: &SigningKey, msg: &[u8]) -> Vec<u8> { let s: k256::ecdsa::Signature = k.sign(msg); s.to_bytes().to_vec() }
const T0: u64 = 1_700_000_000_000_000;
fn tid(micros: u64) -> String {
    const A: &[u8] = b"234567abcdefghijklmnopqrstuvwxyz";
    let v = micros << 10;
    (0..13).rev().map(|i| A[((v >> (5 * i)) & 31) as usize] as char).collect()
}
fn plc_op(prev: Option<&[u8]>, rotation: &SigningKey, repo: &SigningKey, signer: &SigningKey) -> Vec<u8> {
    let body = |sig: Option<Vec<u8>>| {
        let mut m = vec![
            ("type", V::T("plc_operation".into())),
            ("prev", match prev { Some(p) => V::T(format!("b{}", base32(&[&[0x01, 0x71, 0x12, 0x20][..], &sha(p)].concat()))), None => V::Null }),
            ("services", V::M(vec![])),
            ("alsoKnownAs", V::A(vec![V::T("at://alice.test".into())])),
            ("rotationKeys", V::A(vec![V::T(did_key(rotation))])),
            ("verificationMethods", V::M(vec![("atproto", V::T(did_key(repo)))])),
        ];
        if let Some(s) = sig { m.push(("sig", V::T(base64url(&s)))); }
        cbor(&V::M(m))
    };
    let sig = sign(signer, &body(None));
    body(Some(sig))
}
struct Post { commit: Vec<u8>, nodes: Vec<Vec<u8>>, record: Vec<u8>, rkey: String }
struct Account { did: String, ops: Vec<Vec<u8>>, repo_key: SigningKey }
impl Account {
    fn new() -> Self {
        let rotation_key = SigningKey::random(&mut rand_core::OsRng);
        let repo_key = SigningKey::random(&mut rand_core::OsRng);
        let genesis = plc_op(None, &rotation_key, &repo_key, &rotation_key);
        let did = format!("did:plc:{}", &base32(&sha(&genesis))[..24]);
        Self { did, ops: vec![genesis], repo_key }
    }
    /// Build a proof that `record` sits at `collection/rkey` in this repo.
    fn record_at(&self, collection: &str, record: Vec<u8>, rkey: &str) -> Post {
        let other = cbor(&V::M(vec![("text", V::T("unrelated".into()))]));
        let key = format!("{collection}/{rkey}");
        let other_key = format!("{collection}/3zzzzzzzzzzzz");
        assert!(key < other_key);
        let p = key.bytes().zip(other_key.bytes()).take_while(|(a, b)| a == b).count();
        let node = cbor(&V::M(vec![
            ("l", V::Null),
            ("e", V::A(vec![
                V::M(vec![("k", V::B(key.into_bytes())), ("p", V::U(0)), ("t", V::Null), ("v", V::Link(sha(&record)))]),
                V::M(vec![("k", V::B(other_key.as_bytes()[p..].to_vec())), ("p", V::U(p as u64)), ("t", V::Null), ("v", V::Link(sha(&other)))]),
            ])),
        ]));
        let commit = |sig: Option<Vec<u8>>| {
            let mut m = vec![
                ("did", V::T(self.did.clone())), ("rev", V::T(tid(T0))), ("data", V::Link(sha(&node))),
                ("prev", V::Null), ("version", V::U(3)),
            ];
            if let Some(s) = sig { m.push(("sig", V::B(s))); }
            cbor(&V::M(m))
        };
        let sig = sign(&self.repo_key, &commit(None));
        Post { commit: commit(Some(sig)), nodes: vec![node], record, rkey: rkey.to_string() }
    }
    fn post(&self, text: &str, rkey: &str) -> Post {
        let record = cbor(&V::M(vec![
            ("$type", V::T("app.bsky.feed.post".into())), ("text", V::T(text.into())), ("createdAt", V::T("2026-10-10T00:00:00.000Z".into())),
        ]));
        self.record_at("app.bsky.feed.post", record, rkey)
    }
    fn repost(&self, target: &str, rkey: &str) -> Post {
        let record = cbor(&V::M(vec![
            ("$type", V::T("app.bsky.feed.repost".into())),
            ("subject", V::M(vec![("uri", V::T(target.into()))])),
            ("createdAt", V::T("2026-10-10T00:00:00.000Z".into())),
        ]));
        self.record_at("app.bsky.feed.repost", record, rkey)
    }
}
fn hex(k: &RistrettoPublicKeyBytes) -> String { k.into_array().iter().map(|b| format!("{b:02x}")).collect() }
fn bytes_list(items: &[Vec<u8>]) -> Vec<Bytes> { items.iter().map(|b| Bytes::from_vec(b.clone())).collect() }

// ---- harness ---------------------------------------------------------------------------------------
struct U { account: ComponentAddress, badge: NonFungibleAddress, key: RistrettoSecretKey, id: RistrettoPublicKeyBytes }
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
    rec: ComponentAddress,
}

fn setup() -> Env {
    let mut test = TemplateTest::new(CRATE_PATH, [ESCROW, REC, LINK]);
    set_epoch(&mut test, 1);
    let escrow_t = test.get_template_address("Escrow");
    let rec_t = test.get_template_address("SocialRecovery");
    let link_t = test.get_template_address("LinkRegistry");
    let admin = user(&mut test);
    let tx = test.transaction().call_function(escrow_t, "new", args![TARI_TOKEN, Amount::from(1_000u64), admin.id, 20_000u32]).build_and_seal(&admin.key);
    test.execute_expect_success(tx, vec![admin.badge.clone()]);
    let escrow = test.get_previous_output_address(SubstateType::Component).as_component_address().unwrap();
    let badge_res: ResourceAddress = test.call_method(escrow, "policy_badge_resource", args![], vec![]);
    let tx = test.transaction().call_function(link_t, "new", args![0u64]).build_and_seal(&admin.key);
    test.execute_expect_success(tx, vec![admin.badge.clone()]);
    let reg = test.get_previous_output_address(SubstateType::Component).as_component_address().unwrap();
    let tx = test.transaction().call_function(rec_t, "new", args![escrow, badge_res, reg]).build_and_seal(&admin.key);
    test.execute_expect_success(tx, vec![admin.badge.clone()]);
    let rec = test.get_previous_output_address(SubstateType::Component).as_component_address().unwrap();
    let tx = test
        .transaction()
        .call_method(escrow, "approve_policy", args![rec])
        .put_last_instruction_output_on_workspace("b")
        .call_method(rec, "receive_badge", args![Workspace("b")])
        .build_and_seal(&admin.key);
    test.execute_expect_success(tx, vec![admin.badge.clone()]);
    Env { test, escrow, rec }
}

const VAULT: &str = "vault-alice";

/// Vault rules: threshold ++ delay (8 BE) ++ guardian DIDs.
fn rules(threshold: u8, delay: u64, guardians: &[&Account]) -> Bytes {
    let mut m = vec![threshold];
    m.extend_from_slice(&delay.to_be_bytes());
    m.extend_from_slice(guardians.iter().map(|g| g.did.as_str()).collect::<Vec<_>>().join("\n").as_bytes());
    Bytes::from_vec(m)
}

fn approve(env: &mut Env, who: &U, g: &Account, new_owner: ComponentAddress, rkey: &str, expect_ok: bool) {
    let code: String = env.test.call_method(env.rec, "expected_post_text", args![VAULT.to_string(), 0u32, new_owner], vec![]);
    let post = g.post(&format!("Helping a friend recover their wallet {code}"), rkey);
    let tx = env
        .test
        .transaction()
        .call_method(env.rec, "approve", args![
            VAULT.to_string(), 0u32, g.did.clone(), new_owner, bytes_list(&g.ops),
            Bytes::from_vec(post.commit), bytes_list(&post.nodes), Bytes::from_vec(post.record), post.rkey
        ])
        .build_and_seal(&who.key);
    if expect_ok {
        env.test.execute_expect_success(tx, vec![who.badge.clone()]);
    } else {
        env.test.execute_expect_failure(tx, vec![who.badge.clone()]);
    }
}

fn execute(env: &mut Env, who: &U, new_owner: ComponentAddress, expect_ok: bool) {
    let tx = env.test.transaction().call_method(env.rec, "execute", args![VAULT.to_string(), 0u32, new_owner]).build_and_seal(&who.key);
    if expect_ok {
        env.test.execute_expect_success(tx, vec![who.badge.clone()]);
    } else {
        env.test.execute_expect_failure(tx, vec![who.badge.clone()]);
    }
}

fn recovery(env: &mut Env) -> Option<(String, u64)> {
    env.test.call_method(env.rec, "recovery_for", args![VAULT.to_string(), 0u32], vec![])
}

#[test]
fn guardians_recover_a_vault_after_the_delay_and_the_owner_can_veto() {
    let mut env = setup();
    let (g1, g2, g3) = (Account::new(), Account::new(), Account::new());
    let owner = user(&mut env.test);
    ensure_open(&mut env.test, env.escrow, &VAULT.to_string());
    let tx = env
        .test
        .transaction()
        .call_method(owner.account, "withdraw", args![TARI_TOKEN, Amount::from(10_000u64)])
        .put_last_instruction_output_on_workspace("funds")
        .call_method(env.escrow, "deposit", args![VAULT.to_string(), owner.id, 5_000u64, env.rec, rules(2, 3, &[&g1, &g2, &g3]), Workspace("funds")])
        .build_and_seal(&owner.key);
    env.test.execute_expect_success(tx, vec![owner.badge.clone()]);

    let relayer = user(&mut env.test);
    let fresh = user(&mut env.test); // the owner's new wallet
    let outsider = Account::new();

    // A non-guardian's post counts for nothing; one guardian alone starts nothing.
    approve(&mut env, &relayer, &outsider, fresh.account, "3jaaaaaaaaaaa", false);
    approve(&mut env, &relayer, &g1, fresh.account, "3jaaaaaaaaaaa", true);
    assert_eq!(recovery(&mut env), None);
    // The second guardian makes the threshold: the recovery starts, executable 3 epochs later.
    approve(&mut env, &relayer, &g2, fresh.account, "3jaaaaaaaaaaa", true);
    assert_eq!(recovery(&mut env), Some((fresh.account.to_string(), 4)));
    execute(&mut env, &relayer, fresh.account, false);

    // The owner still has their key (say the guardians colluded): they veto it.
    let tx = env.test.transaction().call_method(env.rec, "cancel", args![VAULT.to_string(), 0u32]).build_and_seal(&owner.key);
    env.test.execute_expect_success(tx, vec![owner.badge.clone()]);
    assert_eq!(recovery(&mut env), None);
    // A guardian's old post can't be replayed into a new recovery.
    approve(&mut env, &relayer, &g1, fresh.account, "3jaaaaaaaaaaa", false);

    // The owner really lost their key: guardians approve again with new posts, wait out the delay, recover.
    approve(&mut env, &relayer, &g1, fresh.account, "3jbbbbbbbbbbb", true);
    approve(&mut env, &relayer, &g3, fresh.account, "3jbbbbbbbbbbb", true);
    set_epoch(&mut env.test, 3);
    execute(&mut env, &relayer, fresh.account, false);
    set_epoch(&mut env.test, 4);
    // Only the account the guardians chose can receive it.
    execute(&mut env, &relayer, relayer.account, false);
    let before = env.test.call_method::<Amount>(fresh.account, "balance", args![TARI_TOKEN], vec![]);
    execute(&mut env, &relayer, fresh.account, true);
    assert_eq!(env.test.call_method::<Amount>(fresh.account, "balance", args![TARI_TOKEN], vec![]), before + Amount::from(10_000u64));
    assert_eq!(env.test.call_method::<Amount>(env.escrow, "total_escrowed", args![], vec![]), Amount::zero());
}

#[test]
fn approvals_for_different_accounts_do_not_add_up() {
    let mut env = setup();
    let (g1, g2) = (Account::new(), Account::new());
    let owner = user(&mut env.test);
    ensure_open(&mut env.test, env.escrow, &VAULT.to_string());
    let tx = env
        .test
        .transaction()
        .call_method(owner.account, "withdraw", args![TARI_TOKEN, Amount::from(5_000u64)])
        .put_last_instruction_output_on_workspace("funds")
        .call_method(env.escrow, "deposit", args![VAULT.to_string(), owner.id, 5_000u64, env.rec, rules(2, 0, &[&g1, &g2]), Workspace("funds")])
        .build_and_seal(&owner.key);
    env.test.execute_expect_success(tx, vec![owner.badge.clone()]);
    let relayer = user(&mut env.test);
    let a = user(&mut env.test);
    let b = user(&mut env.test);
    approve(&mut env, &relayer, &g1, a.account, "3jaaaaaaaaaaa", true);
    approve(&mut env, &relayer, &g2, b.account, "3jaaaaaaaaaaa", true);
    assert_eq!(recovery(&mut env), None);
}
