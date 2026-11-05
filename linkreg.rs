//   SPDX-License-Identifier: BSD-3-Clause
//! LinkRegistry: bind a did:plc to a standard Ootle account via one signed post, and read it back.

use k256::ecdsa::{SigningKey, signature::Signer as _};
use sha2::{Digest, Sha256};
use tari_crypto::{keys::PublicKey as _, ristretto::{RistrettoPublicKey, RistrettoSecretKey}, tari_utilities::ByteArray};
use tari_engine_types::virtual_substate::{VirtualSubstate, VirtualSubstateId};
use tari_ootle_common_types::substate_type::SubstateType;
use tari_ootle_transaction::args;
use tari_template_lib::types::{ComponentAddress, NonFungibleAddress, bytes::Bytes, crypto::RistrettoPublicKeyBytes};
use tari_template_test_tooling::TemplateTest;

const CRATE_PATH: &str = env!("CARGO_MANIFEST_DIR");
const LINK: &str = "tests/templates/link-registry";

// ---- DAG-CBOR builder (post with arbitrary text) ---------------------------------------------------
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
    fn post(&self, text: &str, rkey: &str) -> Post {
        let record = cbor(&V::M(vec![
            ("$type", V::T("app.bsky.feed.post".into())), ("text", V::T(text.into())), ("createdAt", V::T("2026-10-10T00:00:00.000Z".into())),
        ]));
        let other = cbor(&V::M(vec![("text", V::T("unrelated".into()))]));
        let key = format!("app.bsky.feed.post/{rkey}");
        let other_key = "app.bsky.feed.post/3zzzzzzzzzzzz".to_string();
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
}
fn bytes_list(items: &[Vec<u8>]) -> Vec<Bytes> { items.iter().map(|b| Bytes::from_vec(b.clone())).collect() }

struct U { account: ComponentAddress, badge: NonFungibleAddress, key: RistrettoSecretKey, id: RistrettoPublicKeyBytes }
fn user(test: &mut TemplateTest) -> U {
    let (account, badge, key) = test.create_funded_account();
    let id = RistrettoPublicKeyBytes::from_bytes(RistrettoPublicKey::from_secret_key(&key).as_bytes()).unwrap();
    U { account, badge, key, id }
}

#[test]
fn bind_links_a_did_to_an_account_and_rejects_replay() {
    let mut test = TemplateTest::new(CRATE_PATH, [LINK]);
    test.set_virtual_substate(VirtualSubstateId::CurrentEpoch, VirtualSubstate::CurrentEpoch(1));
    let link_t = test.get_template_address("LinkRegistry");
    let admin = user(&mut test);
    // bind_delay 0 -> a first binding is effective immediately.
    let tx = test.transaction().call_function(link_t, "new", args![0u64]).build_and_seal(&admin.key);
    test.execute_expect_success(tx, vec![admin.badge.clone()]);
    let reg = test.get_previous_output_address(SubstateType::Component).as_component_address().unwrap();

    let acct = Account::new();
    let wallet = user(&mut test); // a standard account to link to
    let code: String = test.call_method(reg, "expected_bind_text", args![acct.did.clone(), wallet.account, wallet.id], vec![]);
    let post = acct.post(&code, "3jaaaaaaaaaaa");

    assert_eq!(test.call_method::<Option<ComponentAddress>>(reg, "binding_for", args![acct.did.clone()], vec![]), None);

    let tx = test.transaction()
        .call_method(reg, "bind", args![acct.did.clone(), wallet.account, wallet.id, bytes_list(&acct.ops), Bytes::from_vec(post.commit), bytes_list(&post.nodes), Bytes::from_vec(post.record), post.rkey])
        .build_and_seal(&admin.key);
    test.execute_expect_success(tx, vec![admin.badge.clone()]);

    assert_eq!(test.call_method::<Option<ComponentAddress>>(reg, "binding_for", args![acct.did.clone()], vec![]), Some(wallet.account));
    assert_eq!(
        test.call_method::<Option<(ComponentAddress, RistrettoPublicKeyBytes)>>(reg, "active_binding", args![acct.did.clone()], vec![]),
        Some((wallet.account, wallet.id))
    );

    // The same post (or an older rkey) cannot be used to bind again.
    let replay = acct.post(&code, "3jaaaaaaaaaaa");
    let tx = test.transaction()
        .call_method(reg, "bind", args![acct.did.clone(), wallet.account, wallet.id, bytes_list(&acct.ops), Bytes::from_vec(replay.commit), bytes_list(&replay.nodes), Bytes::from_vec(replay.record), replay.rkey])
        .build_and_seal(&admin.key);
    test.execute_expect_failure(tx, vec![admin.badge.clone()]);
}
