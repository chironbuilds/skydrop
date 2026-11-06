//   SPDX-License-Identifier: BSD-3-Clause
//! End-to-end test of ServicePay: pay-per-call metered by the caller’s own atproto service-auth tokens.

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
const SVC: &str = "tests/templates/service-pay";
const PROVIDER: &str = "did:web:api.example.com";

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

/// A compact ES256K service-auth JWT signed by the account's repo key.
fn token(acct: &Account, aud: &str, lxm: Option<&str>, nonce: u32) -> String {
    let header = base64url(br#"{"typ":"JWT","alg":"ES256K"}"#);
    let lxm = lxm.map(|m| format!(r#","lxm":"{m}""#)).unwrap_or_default();
    let payload = base64url(format!(r#"{{"iss":"{}","aud":"{aud}","exp":1900000000,"jti":"n{nonce}"{lxm}}}"#, acct.did).as_bytes());
    let input = format!("{header}.{payload}");
    format!("{input}.{}", base64url(&sign(&acct.repo_key, input.as_bytes())))
}

struct Env {
    reg: ComponentAddress,
    test: TemplateTest,
    escrow: ComponentAddress,
    svc: ComponentAddress,
}

fn setup() -> Env {
    let mut test = TemplateTest::new(CRATE_PATH, [ESCROW, SVC, LINK]);
    set_epoch(&mut test, 1);
    let escrow_t = test.get_template_address("Escrow");
    let svc_t = test.get_template_address("ServicePay");
    let link_t = test.get_template_address("LinkRegistry");
    let admin = user(&mut test);
    let tx = test.transaction().call_function(escrow_t, "new", args![TARI_TOKEN, Amount::from(1_000u64), admin.id, 20_000u32]).build_and_seal(&admin.key);
    test.execute_expect_success(tx, vec![admin.badge.clone()]);
    let escrow = test.get_previous_output_address(SubstateType::Component).as_component_address().unwrap();
    let badge_res: ResourceAddress = test.call_method(escrow, "policy_badge_resource", args![], vec![]);
    let tx = test.transaction().call_function(link_t, "new", args![0u64, 20_000u32]).build_and_seal(&admin.key);
    test.execute_expect_success(tx, vec![admin.badge.clone()]);
    let reg = test.get_previous_output_address(SubstateType::Component).as_component_address().unwrap();
    let tx = test.transaction().call_function(svc_t, "new", args![escrow, badge_res, TARI_TOKEN, reg]).build_and_seal(&admin.key);
    test.execute_expect_success(tx, vec![admin.badge.clone()]);
    let svc = test.get_previous_output_address(SubstateType::Component).as_component_address().unwrap();
    let tx = test
        .transaction()
        .call_method(escrow, "approve_policy", args![svc])
        .put_last_instruction_output_on_workspace("b")
        .call_method(svc, "receive_badge", args![Workspace("b")])
        .build_and_seal(&admin.key);
    test.execute_expect_success(tx, vec![admin.badge.clone()]);
    Env { reg, test, escrow, svc }
}

/// Credit-line metadata: price ++ provider DID ++ "\n" ++ payout account [++ "\n" ++ method].
fn terms(price: u64, payout: ComponentAddress, lxm: Option<&str>) -> Bytes {
    let mut m = price.to_be_bytes().to_vec();
    m.extend_from_slice(format!("{PROVIDER}\n{payout}").as_bytes());
    if let Some(l) = lxm {
        m.extend_from_slice(format!("\n{l}").as_bytes());
    }
    Bytes::from_vec(m)
}

fn open_credit(env: &mut Env, payer: &U, acct: &Account, amount: u64, meta: Bytes) {
    ensure_open(&mut env.test, env.escrow, &acct.did.clone());
    let tx = env
        .test
        .transaction()
        .call_method(payer.account, "withdraw", args![TARI_TOKEN, Amount::from(amount)])
        .put_last_instruction_output_on_workspace("funds")
        .call_method(env.escrow, "deposit", args![acct.did.clone(), payer.id, 100u64, env.svc, meta, Workspace("funds")])
        .build_and_seal(&payer.key);
    env.test.execute_expect_success(tx, vec![payer.badge.clone()]);
}

fn redeem(env: &mut Env, who: &U, acct: &Account, tok: &str, payout: ComponentAddress, expect_ok: bool) {
    let tx = env
        .test
        .transaction()
        .call_method(env.svc, "redeem", args![acct.did.clone(), 0u32, bytes_list(&acct.ops), tok.to_string(), payout])
        .build_and_seal(&who.key);
    if expect_ok {
        env.test.execute_expect_success(tx, vec![who.badge.clone()]);
    } else {
        env.test.execute_expect_failure(tx, vec![who.badge.clone()]);
    }
}

fn balance(env: &mut Env, a: ComponentAddress) -> Amount {
    env.test.call_method(a, "balance", args![TARI_TOKEN], vec![])
}

fn escrowed(env: &mut Env) -> Amount {
    env.test.call_method(env.escrow, "total_escrowed", args![], vec![])
}

#[test]
fn each_service_auth_token_pays_one_call_to_the_fixed_payout() {
    let mut env = setup();
    let acct = Account::new();
    ensure_open(&mut env.test, env.reg, &acct.did);
    let payer = user(&mut env.test);
    let provider = user(&mut env.test);
    let relayer = user(&mut env.test);
    open_credit(&mut env, &payer, &acct, 3_500, terms(1_000, provider.account, None));
    let start = balance(&mut env, provider.account);

    // Anyone (here a relayer) submits the first token: one call is paid, the rest is escrowed again.
    let t1 = token(&acct, PROVIDER, None, 1);
    redeem(&mut env, &relayer, &acct, &t1, provider.account, true);
    assert_eq!(balance(&mut env, provider.account), start + Amount::from(1_000u64));
    assert_eq!(escrowed(&mut env), Amount::from(2_500u64));
    // A token pays once.
    redeem(&mut env, &relayer, &acct, &t1, provider.account, false);
    // Its signature spelled another way is the same token. A signature ends in 4 spare bits, which must be zero.
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let last = ALPHABET.iter().position(|c| *c == *t1.as_bytes().last().unwrap()).unwrap();
    assert_eq!(last % 16, 0);
    let respelled = format!("{}{}", &t1[..t1.len() - 1], ALPHABET[last + 1] as char);
    redeem(&mut env, &relayer, &acct, &respelled, provider.account, false);
    assert_eq!(balance(&mut env, provider.account), start + Amount::from(1_000u64));
    // A payout other than the one the user fixed is refused, even with a fresh valid token.
    redeem(&mut env, &relayer, &acct, &token(&acct, PROVIDER, None, 2), relayer.account, false);
    // A token addressed to another service is refused.
    redeem(&mut env, &relayer, &acct, &token(&acct, "did:web:other.example", None, 3), provider.account, false);
    // A token signed with a key that isn't the account's is refused.
    let impostor = Account { did: acct.did.clone(), ops: acct.ops.clone(), repo_key: Account::new().repo_key };
    redeem(&mut env, &relayer, &acct, &token(&impostor, PROVIDER, None, 4), provider.account, false);

    // Two more calls. The 500 left can't pay another, so it's kept as change for the user.
    redeem(&mut env, &relayer, &acct, &token(&acct, PROVIDER, None, 5), provider.account, true);
    redeem(&mut env, &relayer, &acct, &token(&acct, PROVIDER, None, 6), provider.account, true);
    assert_eq!(balance(&mut env, provider.account), start + Amount::from(3_000u64));
    assert_eq!(escrowed(&mut env), Amount::zero());
    assert_eq!(env.test.call_method::<Amount>(env.svc, "change_for", args![payer.id], vec![]), Amount::from(500u64));
    let before = balance(&mut env, payer.account);
    let tx = env
        .test
        .transaction()
        .call_method(env.svc, "take_change", args![payer.id])
        .put_last_instruction_output_on_workspace("c")
        .call_method(payer.account, "deposit", args![Workspace("c")])
        .build_and_seal(&payer.key);
    env.test.execute_expect_success(tx, vec![payer.badge.clone()]);
    assert_eq!(balance(&mut env, payer.account), before + Amount::from(500u64));
}

#[test]
fn a_method_scoped_credit_line_only_pays_tokens_for_that_method() {
    let mut env = setup();
    let acct = Account::new();
    ensure_open(&mut env.test, env.reg, &acct.did);
    let payer = user(&mut env.test);
    let provider = user(&mut env.test);
    open_credit(&mut env, &payer, &acct, 2_000, terms(1_000, provider.account, Some("com.example.translate")));
    redeem(&mut env, &provider, &acct, &token(&acct, PROVIDER, None, 1), provider.account, false);
    redeem(&mut env, &provider, &acct, &token(&acct, PROVIDER, Some("com.example.other"), 2), provider.account, false);
    redeem(&mut env, &provider, &acct, &token(&acct, PROVIDER, Some("com.example.translate"), 3), provider.account, true);
}
