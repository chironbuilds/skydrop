//   SPDX-License-Identifier: BSD-3-Clause
//! End-to-end test of TipPolicy: fund a budget, relay a signed `@bot tip @r 5` post, and confirm it
//! becomes a ClaimPolicy-governed deposit for the recipient while the budget is debited.

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
const CLAIM: &str = "tests/templates/claim-policy";
const TIP: &str = "tests/templates/tip-policy";
const LINK: &str = "tests/templates/link-registry";
const BOT: &str = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const MENTION: &str = "app.bsky.richtext.facet#mention";

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
    /// A tip post "@bot tip @r 5" with mention facets for bot (byteStart 0) and recipient (byteStart 9).
    fn tip_post(&self, bot: &str, recipient: &str, rkey: &str) -> Post {
        let facet = |start: u64, end: u64, did: &str| {
            V::M(vec![
                ("index", V::M(vec![("byteStart", V::U(start)), ("byteEnd", V::U(end))])),
                ("features", V::A(vec![V::M(vec![("$type", V::T(MENTION.into())), ("did", V::T(did.into()))])])),
            ])
        };
        let record = cbor(&V::M(vec![
            ("$type", V::T("app.bsky.feed.post".into())),
            ("text", V::T("@bot tip @r 5".into())),
            ("facets", V::A(vec![facet(0, 4, bot), facet(9, 11, recipient)])),
            ("createdAt", V::T("2026-10-10T00:00:00.000Z".into())),
        ]));
        self.record_at("app.bsky.feed.post", record, rkey)
    }
}
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
type Dep = (RistrettoPublicKeyBytes, Amount, u64, ComponentAddress, Bytes, u64);

#[test]
fn tip_by_post_becomes_a_claim_deposit_for_the_recipient() {
    let mut test = TemplateTest::new(CRATE_PATH, [ESCROW, CLAIM, TIP, LINK]);
    set_epoch(&mut test, 1);
    let escrow_t = test.get_template_address("Escrow");
    let claim_t = test.get_template_address("ClaimPolicy");
    let tip_t = test.get_template_address("TipPolicy");
    let link_t = test.get_template_address("LinkRegistry");
    let admin = user(&mut test);

    let tx = test.transaction().call_function(escrow_t, "new", args![TARI_TOKEN, Amount::from(1_000u64), admin.id, 20_000u32]).build_and_seal(&admin.key);
    test.execute_expect_success(tx, vec![admin.badge.clone()]);
    let escrow = test.get_previous_output_address(SubstateType::Component).as_component_address().unwrap();
    let badge_res: ResourceAddress = test.call_method(escrow, "policy_badge_resource", args![], vec![]);

    let tx = test.transaction().call_function(link_t, "new", args![0u64, 20_000u32]).build_and_seal(&admin.key);
    test.execute_expect_success(tx, vec![admin.badge.clone()]);
    let reg = test.get_previous_output_address(SubstateType::Component).as_component_address().unwrap();

    let tx = test.transaction().call_function(claim_t, "new", args![escrow, badge_res, reg, 20_000u32]).build_and_seal(&admin.key);
    test.execute_expect_success(tx, vec![admin.badge.clone()]);
    let claim = test.get_previous_output_address(SubstateType::Component).as_component_address().unwrap();

    let tx = test.transaction().call_function(tip_t, "new", args![escrow, claim, TARI_TOKEN, badge_res, BOT.to_string(), reg]).build_and_seal(&admin.key);
    test.execute_expect_success(tx, vec![admin.badge.clone()]);
    let tip = test.get_previous_output_address(SubstateType::Component).as_component_address().unwrap();

    // approve both policies and route their badges
    for pol in [claim, tip] {
        let tx = test.transaction()
            .call_method(escrow, "approve_policy", args![pol])
            .put_last_instruction_output_on_workspace("b")
            .call_method(pol, "receive_badge", args![Workspace("b")])
            .build_and_seal(&admin.key);
        test.execute_expect_success(tx, vec![admin.badge.clone()]);
    }

    // The tipper (a Bluesky account) and the budget owner (an Ootle wallet) are the same person here.
    let tipper = Account::new();
    ensure_open(&mut test, reg, &tipper.did);
    ensure_open(&mut test, claim, &tipper.did);
    let owner = user(&mut test);
    let recipient = Account::new(); // just need a valid did:plc for the recipient
    ensure_open(&mut test, reg, &recipient.did);
    ensure_open(&mut test, claim, &recipient.did);

    // Owner funds a budget: 10 tTARI, window 0, refundable after 100, max 6 tTARI per tip.
    let tx = test.transaction()
        .call_method(owner.account, "withdraw", args![TARI_TOKEN, Amount::from(10_000_000u64)])
        .put_last_instruction_output_on_workspace("funds")
        .call_method(tip, "open_budget", args![tipper.did.clone(), owner.id, 0u64, 100u64, Amount::from(6_000_000u64), Workspace("funds")])
        .build_and_seal(&owner.key);
    test.execute_expect_success(tx, vec![owner.badge.clone()]);

    // Relay the signed tip post. Anyone may submit it; here the owner does.
    let post = tipper.tip_post(BOT, &recipient.did, "3jaaaaaaaaaaa");
    ensure_open(&mut test, escrow, &recipient.did);
    let tx = test.transaction()
        .call_method(tip, "tip", args![
            tipper.did.clone(), owner.id, bytes_list(&tipper.ops),
            Bytes::from_vec(post.commit), bytes_list(&post.nodes), Bytes::from_vec(post.record), post.rkey
        ])
        .build_and_seal(&owner.key);
    test.execute_expect_success(tx, vec![owner.badge.clone()]);

    // A 5 tTARI deposit now sits in escrow for the recipient, governed by the claim policy.
    let deps: Vec<Dep> = test.call_method(escrow, "deposits_for", args![recipient.did.clone()], vec![]);
    assert_eq!(deps.len(), 1);
    assert_eq!(deps[0].1, Amount::from(5_000_000u64));
    assert_eq!(deps[0].3, claim);
    assert_eq!(test.call_method::<Amount>(escrow, "total_escrowed", args![], vec![]), Amount::from(5_000_000u64));

    // The budget is debited by exactly the tip.
    let b: Option<(Amount, u64, u64, Amount)> = test.call_method(tip, "budget_for", args![tipper.did.clone(), owner.id], vec![]);
    assert_eq!(b.unwrap().0, Amount::from(5_000_000u64));
}
