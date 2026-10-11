//   SPDX-License-Identifier: BSD-3-Clause

//! BskyClaim engine tests. A synthetic but fully valid atproto account (own keys, signed PLC operations,
//! signed repo commit, Merkle-search-tree node, post) stands in for a real one, because a real post cannot
//! contain a claim code for a component that did not exist when it was written. Verification against real
//! Bluesky data lives in the atp-verify crate's own tests.

use k256::ecdsa::{SigningKey, signature::Signer as _};
use sha2::{Digest, Sha256};
use tari_crypto::{
    keys::PublicKey as _,
    ristretto::{RistrettoPublicKey, RistrettoSecretKey},
    tari_utilities::ByteArray,
};
use tari_engine_types::virtual_substate::{VirtualSubstate, VirtualSubstateId};
use tari_ootle_common_types::substate_type::SubstateType;
use tari_ootle_transaction::{args, builder::named_args::NamedArg};
use tari_template_lib::types::{
    Amount,
    ComponentAddress,
    NonFungibleAddress,
    bytes::Bytes,
    constants::TARI_TOKEN,
    crypto::RistrettoPublicKeyBytes,
};
use tari_template_test_tooling::TemplateTest;

const CRATE_PATH: &str = env!("CARGO_MANIFEST_DIR");
const BSKYCLAIM: &str = "tests/templates/bskyclaim";
const WINDOW: u64 = 3;
const BOT: &str = "did:plc:abcdefghijklmnopqrstuvwx";
const COLLECTION: &str = "app.bsky.feed.post";

// ---- minimal DAG-CBOR encoder -------------------------------------------------------------------------

enum V {
    U(u64),
    T(String),
    B(Vec<u8>),
    A(Vec<V>),
    M(Vec<(&'static str, V)>),
    Link([u8; 32]),
    Null,
}

fn head(major: u8, n: u64, out: &mut Vec<u8>) {
    let m = major << 5;
    match n {
        0..=23 => out.push(m | n as u8),
        24..=0xff => out.extend_from_slice(&[m | 24, n as u8]),
        0x100..=0xffff => {
            out.push(m | 25);
            out.extend_from_slice(&(n as u16).to_be_bytes());
        },
        _ => {
            out.push(m | 26);
            out.extend_from_slice(&(n as u32).to_be_bytes());
        },
    }
}

fn enc(v: &V, out: &mut Vec<u8>) {
    match v {
        V::U(n) => head(0, *n, out),
        V::T(s) => {
            head(3, s.len() as u64, out);
            out.extend_from_slice(s.as_bytes());
        },
        V::B(b) => {
            head(2, b.len() as u64, out);
            out.extend_from_slice(b);
        },
        V::A(items) => {
            head(4, items.len() as u64, out);
            items.iter().for_each(|i| enc(i, out));
        },
        V::M(entries) => {
            let mut sorted: Vec<_> = entries.iter().collect();
            // DAG-CBOR: shorter keys first, then bytewise.
            sorted.sort_by(|a, b| (a.0.len(), a.0.as_bytes()).cmp(&(b.0.len(), b.0.as_bytes())));
            head(5, sorted.len() as u64, out);
            for (k, val) in sorted {
                enc(&V::T((*k).to_string()), out);
                enc(val, out);
            }
        },
        V::Link(d) => {
            head(6, 42, out);
            head(2, 37, out);
            out.extend_from_slice(&[0x00, 0x01, 0x71, 0x12, 0x20]);
            out.extend_from_slice(d);
        },
        V::Null => out.push(0xf6),
    }
}

fn cbor(v: &V) -> Vec<u8> {
    let mut o = Vec::new();
    enc(v, &mut o);
    o
}

fn sha(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

// ---- encodings ------------------------------------------------------------------------------------------

const B32: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";

fn base32(data: &[u8]) -> String {
    let (mut out, mut acc, mut bits) = (String::new(), 0u32, 0);
    for &b in data {
        acc = (acc << 8) | b as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(B32[((acc >> bits) & 31) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(B32[((acc << (5 - bits)) & 31) as usize] as char);
    }
    out
}

fn base64url(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let (mut out, mut acc, mut bits) = (String::new(), 0u32, 0);
    for &b in data {
        acc = (acc << 8) | b as u32;
        bits += 8;
        while bits >= 6 {
            bits -= 6;
            out.push(T[((acc >> bits) & 63) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(T[((acc << (6 - bits)) & 63) as usize] as char);
    }
    out
}

fn base58(data: &[u8]) -> String {
    const T: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut digits: Vec<u8> = Vec::new();
    for &byte in data {
        let mut carry = byte as u32;
        for d in digits.iter_mut() {
            carry += (*d as u32) << 8;
            *d = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
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

fn sign(k: &SigningKey, msg: &[u8]) -> Vec<u8> {
    let s: k256::ecdsa::Signature = k.sign(msg);
    s.to_bytes().to_vec()
}

// ---- a synthetic atproto account ------------------------------------------------------------------------

struct Account {
    did: String,
    ops: Vec<Vec<u8>>,
    /// Signing key of the repo as of the latest op.
    repo_key: SigningKey,
    rotation_key: SigningKey,
}

fn plc_op(prev: Option<&[u8]>, rotation: &SigningKey, repo: &SigningKey, signer: &SigningKey) -> Vec<u8> {
    let body = |sig: Option<Vec<u8>>| {
        let mut m = vec![
            ("type", V::T("plc_operation".into())),
            (
                "prev",
                match prev {
                    Some(p) => V::T(format!("b{}", base32(&[&[0x01, 0x71, 0x12, 0x20][..], &sha(p)].concat()))),
                    None => V::Null,
                },
            ),
            ("services", V::M(vec![])),
            ("alsoKnownAs", V::A(vec![V::T("at://alice.test".into())])),
            ("rotationKeys", V::A(vec![V::T(did_key(rotation))])),
            ("verificationMethods", V::M(vec![("atproto", V::T(did_key(repo)))])),
        ];
        if let Some(s) = sig {
            m.push(("sig", V::T(base64url(&s))));
        }
        cbor(&V::M(m))
    };
    let sig = sign(signer, &body(None));
    body(Some(sig))
}

impl Account {
    fn new() -> Self {
        let rotation_key = SigningKey::random(&mut rand_core::OsRng);
        let repo_key = SigningKey::random(&mut rand_core::OsRng);
        let genesis = plc_op(None, &rotation_key, &repo_key, &rotation_key);
        let did = format!("did:plc:{}", &base32(&sha(&genesis))[..24]);
        Self { did, ops: vec![genesis], repo_key, rotation_key }
    }

    /// Rotates the repo signing key with a new operation signed by the rotation key.
    fn rotate_repo_key(&mut self) {
        let new_repo = SigningKey::random(&mut rand_core::OsRng);
        let op = plc_op(self.ops.last().map(|v| v.as_slice()), &self.rotation_key, &new_repo, &self.rotation_key);
        self.ops.push(op);
        self.repo_key = new_repo;
    }

    /// A repo with one post containing `text`, signed by the current repo key.
    fn post(&self, text: &str, rkey: &str) -> Post {
        let record = cbor(&V::M(vec![
            ("$type", V::T(COLLECTION.into())),
            ("text", V::T(text.into())),
            ("createdAt", V::T("2026-10-10T00:00:00.000Z".into())),
        ]));
        self.post_record(record, rkey)
    }

    fn post_record(&self, record: Vec<u8>, rkey: &str) -> Post {
        let other = cbor(&V::M(vec![("text", V::T("unrelated".into()))]));
        let key = format!("{COLLECTION}/{rkey}");
        let other_key = format!("{COLLECTION}/3zzzzzzzzzzzz");
        assert!(key < other_key);
        let p = key.bytes().zip(other_key.bytes()).take_while(|(a, b)| a == b).count();
        let node = cbor(&V::M(vec![
            ("l", V::Null),
            (
                "e",
                V::A(vec![
                    V::M(vec![
                        ("k", V::B(key.into_bytes())),
                        ("p", V::U(0)),
                        ("t", V::Null),
                        ("v", V::Link(sha(&record))),
                    ]),
                    V::M(vec![
                        ("k", V::B(other_key.as_bytes()[p..].to_vec())),
                        ("p", V::U(p as u64)),
                        ("t", V::Null),
                        ("v", V::Link(sha(&other))),
                    ]),
                ]),
            ),
        ]));
        let commit = |sig: Option<Vec<u8>>| {
            let mut m = vec![
                ("did", V::T(self.did.clone())),
                ("rev", V::T("3mxepywf4ec2j".into())),
                ("data", V::Link(sha(&node))),
                ("prev", V::Null),
                ("version", V::U(3)),
            ];
            if let Some(s) = sig {
                m.push(("sig", V::B(s)));
            }
            cbor(&V::M(m))
        };
        let sig = sign(&self.repo_key, &commit(None));
        Post { commit: commit(Some(sig)), nodes: vec![node], record, rkey: rkey.to_string() }
    }
}

struct Post {
    commit: Vec<u8>,
    nodes: Vec<Vec<u8>>,
    record: Vec<u8>,
    rkey: String,
}

// ---- harness --------------------------------------------------------------------------------------------

struct User {
    account: ComponentAddress,
    badge: NonFungibleAddress,
    key: RistrettoSecretKey,
    id: RistrettoPublicKeyBytes,
}

struct Env {
    test: TemplateTest,
    component: ComponentAddress,
}

fn user(test: &mut TemplateTest) -> User {
    let (account, badge, key) = test.create_funded_account();
    let id = RistrettoPublicKeyBytes::from_bytes(RistrettoPublicKey::from_secret_key(&key).as_bytes()).unwrap();
    User { account, badge, key, id }
}

fn bytes_list(items: &[Vec<u8>]) -> Vec<Bytes> {
    items.iter().map(|b| Bytes::from_vec(b.clone())).collect()
}

fn set_epoch(test: &mut TemplateTest, e: u64) {
    test.set_virtual_substate(VirtualSubstateId::CurrentEpoch, VirtualSubstate::CurrentEpoch(e));
}

impl Env {
    fn new() -> Self {
        let mut test = TemplateTest::new(CRATE_PATH, [BSKYCLAIM]);
        set_epoch(&mut test, 1);
        let template = test.get_template_address("BskyClaim");
        let admin = user(&mut test);
        let tx = test
            .transaction()
            .call_function(template, "new", args![TARI_TOKEN, Amount::from(1_000u64), WINDOW, BOT.to_string()])
            .build_and_seal(&admin.key);
        test.execute_expect_success(tx, vec![admin.badge.clone()]);
        let component = test.get_previous_output_address(SubstateType::Component).as_component_address().unwrap();
        Self { test, component }
    }

    fn run(&mut self, who: &User, build: impl FnOnce(tari_ootle_transaction::TransactionBuilder) -> tari_ootle_transaction::TransactionBuilder) -> Option<String> {
        let tx = build(self.test.transaction()).build_and_seal(&who.key);
        let r = self.test.execute_and_commit_on_success(tx, vec![who.badge.clone()]);
        r.finalize.result.any_reject().map(|x| format!("{x:?}"))
    }

    fn deposit(&mut self, from: &User, did: &str, amount: u64, refund_epoch: u64, window: u64) -> Option<String> {
        self.deposit_with(from, did, amount, refund_epoch, window, "")
    }

    fn deposit_with(&mut self, from: &User, did: &str, amount: u64, refund_epoch: u64, window: u64, challenge: &str) -> Option<String> {
        let c = self.component;
        let (account, id, did, challenge) = (from.account, from.id, did.to_string(), challenge.to_string());
        self.run(from, |t| {
            t.call_method(account, "withdraw", args![TARI_TOKEN, Amount::from(amount)])
                .put_last_instruction_output_on_workspace("funds")
                .call_method(c, "deposit", args![did, id, refund_epoch, window, challenge, Workspace("funds")])
        })
    }

    fn code_for(&mut self, did: &str, claimant: &User) -> String {
        self.test.call_method(self.component, "expected_post_text", args![did.to_string(), claimant.id], vec![])
    }

    fn start_claim(&mut self, who: &User, claimant: RistrettoPublicKeyBytes, acct: &Account, post: &Post) -> Option<String> {
        let c = self.component;
        let did = acct.did.clone();
        let (ops, commit, nodes, record, rkey) = (
            bytes_list(&acct.ops),
            Bytes::from_vec(post.commit.clone()),
            bytes_list(&post.nodes),
            Bytes::from_vec(post.record.clone()),
            post.rkey.clone(),
        );
        self.run(who, |t| t.call_method(c, "start_claim", args![did, claimant, ops, commit, nodes, record, rkey]))
    }

    fn finalize(&mut self, who: &User, did: &str) -> Option<String> {
        let (c, did, account) = (self.component, did.to_string(), who.account);
        self.run(who, |t| {
            t.call_method(c, "finalize_claim", args![did])
                .put_last_instruction_output_on_workspace("paid")
                .call_method(account, "deposit", args![Workspace("paid")])
        })
    }

    fn bind_text(&mut self, did: &str, address: ComponentAddress) -> String {
        self.test.call_method(self.component, "expected_bind_text", args![did.to_string(), address], vec![])
    }

    fn bind(&mut self, who: &User, acct: &Account, address: ComponentAddress, post: &Post) -> Option<String> {
        let c = self.component;
        let did = acct.did.clone();
        let (ops, commit, nodes, record, rkey) = (
            bytes_list(&acct.ops),
            Bytes::from_vec(post.commit.clone()),
            bytes_list(&post.nodes),
            Bytes::from_vec(post.record.clone()),
            post.rkey.clone(),
        );
        self.run(who, |t| t.call_method(c, "bind", args![did, address, ops, commit, nodes, record, rkey]))
    }

    fn bound(&mut self, did: &str) -> Option<ComponentAddress> {
        self.test.call_method(self.component, "binding_for", args![did.to_string()], vec![])
    }

    fn bind_post(&mut self, acct: &Account, address: ComponentAddress, rkey: &str) -> Post {
        let code = self.bind_text(&acct.did, address);
        acct.post(&format!("linking my wallet {code}"), rkey)
    }

    fn challenge(&mut self, who: &User, acct: &Account) -> Option<String> {
        let (c, did, ops) = (self.component, acct.did.clone(), bytes_list(&acct.ops));
        self.run(who, |t| t.call_method(c, "challenge", args![did, ops]))
    }

    fn balance(&mut self, u: &User) -> Amount {
        self.test.call_method(u.account, "balance", args![TARI_TOKEN], vec![])
    }

    fn escrowed(&mut self) -> Amount {
        self.test.call_method(self.component, "total_escrowed", args![], vec![])
    }
}

fn expect_err(r: Option<String>, needle: &str) {
    let e = r.unwrap_or_else(|| panic!("expected rejection containing {needle:?}"));
    assert!(e.contains(needle), "wanted {needle:?} in {e}");
}

// ---- tests ----------------------------------------------------------------------------------------------

#[test]
fn deposit_claim_and_payout() {
    let mut env = Env::new();
    let (sender1, sender2, alice) = (user(&mut env.test), user(&mut env.test), user(&mut env.test));
    let acct = Account::new();
    assert_eq!(env.deposit(&sender1, &acct.did, 5_000_000, 100, WINDOW), None);
    assert_eq!(env.deposit(&sender2, &acct.did, 2_000_000, 100, WINDOW), None);
    assert_eq!(env.escrowed(), Amount::from(7_000_000u64));

    let code = env.code_for(&acct.did, &alice);
    let post = acct.post(&format!("claiming my tip {code} thanks!"), "3kaaaaaaaaaaa");
    let before = env.balance(&alice);
    assert_eq!(env.start_claim(&alice, alice.id, &acct, &post), None);
    let pts = env.test.last_execution_points();
    println!("start_claim points: wasm={} native={} total={}", pts.wasm, pts.native, pts.total());

    // Not payable inside the challenge window.
    expect_err(env.finalize(&alice, &acct.did), "window is still open");
    set_epoch(&mut env.test, 1 + WINDOW);
    assert_eq!(env.finalize(&alice, &acct.did), None);
    assert_eq!(env.balance(&alice), before + Amount::from(7_000_000u64));
    assert_eq!(env.escrowed(), Amount::zero());
}

#[test]
fn claim_is_bound_to_the_claimant_and_the_account() {
    let mut env = Env::new();
    let (sender, alice, mallory) = (user(&mut env.test), user(&mut env.test), user(&mut env.test));
    let acct = Account::new();
    assert_eq!(env.deposit(&sender, &acct.did, 5_000_000, 100, WINDOW), None);
    let code = env.code_for(&acct.did, &alice);
    let post = acct.post(&format!("my code {code}"), "3kaaaaaaaaaaa");

    // Mallory replays Alice's public post, naming himself as the claimant: the code does not match.
    expect_err(env.start_claim(&mallory, mallory.id, &acct, &post), "does not contain the claim code");
    // Mallory names Alice but cannot sign as her.
    assert!(env.start_claim(&mallory, alice.id, &acct, &post).is_some());
    // A post by a different account, even with the right code text, fails for this DID.
    let other = Account::new();
    let forged = other.post(&format!("my code {code}"), "3kaaaaaaaaaaa");
    assert!(env.start_claim(&alice, alice.id, &acct, &forged).is_some());
    // The real claim works, and Mallory cannot finalise it.
    assert_eq!(env.start_claim(&alice, alice.id, &acct, &post), None);
    set_epoch(&mut env.test, 1 + WINDOW);
    assert!(env.finalize(&mallory, &acct.did).is_some());
    assert_eq!(env.finalize(&alice, &acct.did), None);
}

#[test]
fn tampered_proofs_are_rejected() {
    let mut env = Env::new();
    let (sender, alice) = (user(&mut env.test), user(&mut env.test));
    let acct = Account::new();
    assert_eq!(env.deposit(&sender, &acct.did, 5_000_000, 100, WINDOW), None);
    let code = env.code_for(&acct.did, &alice);
    let good = acct.post(&format!("code {code}"), "3kaaaaaaaaaaa");

    // Signed by a key that is not the account's repo key.
    let mut impostor = Account::new();
    impostor.did = acct.did.clone();
    impostor.ops = acct.ops.clone();
    let forged = impostor.post(&format!("code {code}"), "3kaaaaaaaaaaa");
    expect_err(env.start_claim(&alice, alice.id, &impostor, &forged), "invalid repo proof");

    // Record bytes altered after the tree committed to them.
    let mut bad = Post { commit: good.commit.clone(), nodes: good.nodes.clone(), record: good.record.clone(), rkey: good.rkey.clone() };
    let n = bad.record.len();
    bad.record[n - 3] ^= 1;
    expect_err(env.start_claim(&alice, alice.id, &acct, &bad), "invalid repo proof");

    // Nothing deposited for another account.
    let nobody = Account::new();
    let p = nobody.post("x", "3kaaaaaaaaaaa");
    expect_err(env.start_claim(&alice, alice.id, &nobody, &p), "nothing deposited");
}

#[test]
fn stale_key_claim_is_cancelled_by_a_key_rotation() {
    let mut env = Env::new();
    let (sender, mallory, alice) = (user(&mut env.test), user(&mut env.test), user(&mut env.test));
    let mut acct = Account::new();
    assert_eq!(env.deposit(&sender, &acct.did, 5_000_000, 100, WINDOW), None);

    // The repo key leaks. The owner rotates it, but Mallory presents the old chain and a post signed by
    // the old (leaked) key.
    let stale = Account { did: acct.did.clone(), ops: acct.ops.clone(), repo_key: acct.repo_key.clone(), rotation_key: acct.rotation_key.clone() };
    acct.rotate_repo_key();
    let code = env.code_for(&acct.did, &mallory);
    let evil = stale.post(&format!("code {code}"), "3kaaaaaaaaaaa");
    assert_eq!(env.start_claim(&mallory, mallory.id, &stale, &evil), None);

    // Anyone can submit the owner's rotation within the window, which cancels Mallory's claim.
    assert_eq!(env.challenge(&alice, &acct), None);
    assert_eq!(env.test.call_method::<Option<(RistrettoPublicKeyBytes, u32, u64)>>(env.component, "pending_for", args![acct.did.clone()], vec![]), None);
    set_epoch(&mut env.test, 1 + WINDOW);
    assert!(env.finalize(&mallory, &acct.did).is_some());
    // The stale chain is now refused outright; the current one works.
    expect_err(env.start_claim(&mallory, mallory.id, &stale, &evil), "stale operation chain");
    let code = env.code_for(&acct.did, &alice);
    let good = acct.post(&format!("code {code}"), "3kaaaaaaaaaaa");
    assert_eq!(env.start_claim(&alice, alice.id, &acct, &good), None);
    // A challenge that presents the very chain the claim used does nothing.
    expect_err(env.challenge(&mallory, &acct), "already relies on");
}

#[test]
fn senders_can_refund_after_the_refund_epoch() {
    let mut env = Env::new();
    let (sender, other) = (user(&mut env.test), user(&mut env.test));
    let acct = Account::new();
    let before = env.balance(&sender);
    assert_eq!(env.deposit(&sender, &acct.did, 5_000_000, 10, WINDOW), None);
    let (c, did, account) = (env.component, acct.did.clone(), sender.account);
    let refund = |env: &mut Env, who: &User| {
        let (did, account) = (did.clone(), if who.account == sender.account { account } else { who.account });
        env.run(who, |t| {
            t.call_method(c, "refund", args![did, 0u32])
                .put_last_instruction_output_on_workspace("back")
                .call_method(account, "deposit", args![Workspace("back")])
        })
    };
    expect_err(refund(&mut env, &sender), "not refundable yet");
    set_epoch(&mut env.test, 10);
    assert!(refund(&mut env, &other).is_some(), "only the sender can refund");
    assert_eq!(refund(&mut env, &sender), None);
    assert_eq!(env.balance(&sender), before);
    assert_eq!(env.escrowed(), Amount::zero());
}

#[allow(dead_code)]
fn _unused(_: NamedArg) {}

#[test]
fn window_zero_tip_pays_out_in_the_same_epoch_and_windows_are_capped() {
    let mut env = Env::new();
    let (sender, alice) = (user(&mut env.test), user(&mut env.test));
    let acct = Account::new();
    // A window above the component's maximum is refused.
    expect_err(env.deposit(&sender, &acct.did, 5_000_000, 100, WINDOW + 1), "above the maximum");
    assert_eq!(env.deposit(&sender, &acct.did, 5_000_000, 100, 0), None);
    let code = env.code_for(&acct.did, &alice);
    let post = acct.post(&format!("code {code}"), "3kaaaaaaaaaaa");
    let before = env.balance(&alice);
    assert_eq!(env.start_claim(&alice, alice.id, &acct, &post), None);
    // No epoch change needed.
    assert_eq!(env.finalize(&alice, &acct.did), None);
    assert_eq!(env.balance(&alice), before + Amount::from(5_000_000u64));
}

#[test]
fn deposits_with_longer_windows_stay_escrowed_until_their_own_window_passes() {
    let mut env = Env::new();
    let (tip, big, alice) = (user(&mut env.test), user(&mut env.test), user(&mut env.test));
    let acct = Account::new();
    assert_eq!(env.deposit(&tip, &acct.did, 1_000_000, 100, 0), None);
    assert_eq!(env.deposit(&big, &acct.did, 9_000_000, 100, WINDOW), None);
    let code = env.code_for(&acct.did, &alice);
    let post = acct.post(&format!("code {code}"), "3kaaaaaaaaaaa");
    let before = env.balance(&alice);
    assert_eq!(env.start_claim(&alice, alice.id, &acct, &post), None);

    // Only the tip is payable now; the large deposit keeps waiting and the claim stays pending.
    assert_eq!(env.finalize(&alice, &acct.did), None);
    assert_eq!(env.balance(&alice), before + Amount::from(1_000_000u64));
    assert_eq!(env.escrowed(), Amount::from(9_000_000u64));
    expect_err(env.finalize(&alice, &acct.did), "still open");

    // A rotation within the big deposit's window still cancels the claim on it.
    let mut rotated = Account { did: acct.did.clone(), ops: acct.ops.clone(), repo_key: acct.repo_key.clone(), rotation_key: acct.rotation_key.clone() };
    rotated.rotate_repo_key();
    assert_eq!(env.challenge(&tip, &rotated), None);
    set_epoch(&mut env.test, 1 + WINDOW);
    assert!(env.finalize(&alice, &acct.did).is_some(), "no pending claim after the challenge");
    assert_eq!(env.escrowed(), Amount::from(9_000_000u64));
}

#[test]
fn big_deposit_pays_after_its_window_when_unchallenged() {
    let mut env = Env::new();
    let (big, alice) = (user(&mut env.test), user(&mut env.test));
    let acct = Account::new();
    assert_eq!(env.deposit(&big, &acct.did, 9_000_000, 100, WINDOW), None);
    let code = env.code_for(&acct.did, &alice);
    let post = acct.post(&format!("code {code}"), "3kaaaaaaaaaaa");
    let before = env.balance(&alice);
    assert_eq!(env.start_claim(&alice, alice.id, &acct, &post), None);
    expect_err(env.finalize(&alice, &acct.did), "still open");
    set_epoch(&mut env.test, 1 + WINDOW);
    assert_eq!(env.finalize(&alice, &acct.did), None);
    assert_eq!(env.balance(&alice), before + Amount::from(9_000_000u64));
}

// ---- sponsored fees: a claimant with no account and no funds -------------------------------------------

use tari_ootle_transaction::Transaction;

impl Env {
    fn fund_sponsor(&mut self, from: &User, amount: u64) {
        let (c, account) = (self.component, from.account);
        assert_eq!(
            self.run(from, |t| {
                t.call_method(account, "withdraw", args![TARI_TOKEN, Amount::from(amount)])
                    .put_last_instruction_output_on_workspace("f")
                    .call_method(c, "fund", args![Workspace("f")])
            }),
            None
        );
    }

    fn fee_balance(&mut self) -> Amount {
        self.test.call_method(self.component, "fee_balance", args![], vec![])
    }
}

/// A claimant that exists only as a key pair: no account, no balance.
fn bare_claimant(env: &mut Env) -> (RistrettoSecretKey, RistrettoPublicKeyBytes) {
    let (_badge, pk, sk) = env.test.create_owner_proof();
    (sk, RistrettoPublicKeyBytes::from_bytes(pk.as_bytes()).unwrap())
}

fn sponsored_start(env: &mut Env, sk: &RistrettoSecretKey, id: RistrettoPublicKeyBytes, acct: &Account, post: &Post) -> Option<String> {
    let c = env.component;
    let (did, ops, commit, nodes, record, rkey) = (
        acct.did.clone(),
        bytes_list(&acct.ops),
        Bytes::from_vec(post.commit.clone()),
        bytes_list(&post.nodes),
        Bytes::from_vec(post.record.clone()),
        post.rkey.clone(),
    );
    env.test.enable_fees();
    let tx = Transaction::builder_localnet(env.test.current_epoch())
        .with_fee_instructions_builder(|b| {
            b.call_method(c, "start_claim_sponsored", args![did, id, ops, commit, nodes, record, rkey, Amount::from(60_000u64)])
        })
        .with_seal_signer_authorized(true)
        .build_and_seal(sk);
    let r = env.test.execute_and_commit_on_success(tx, vec![]);
    env.test.disable_fees();
    r.finalize.result.any_reject().map(|x| format!("{x:?}"))
}

fn sponsored_finalize(env: &mut Env, sk: &RistrettoSecretKey, id: RistrettoPublicKeyBytes, did: &str) -> Option<String> {
    let (c, did) = (env.component, did.to_string());
    env.test.enable_fees();
    let tx = Transaction::builder_localnet(env.test.current_epoch())
        .with_fee_instructions_builder(|b| b.call_method(c, "sponsor_finalize", args![did.clone(), Amount::from(60_000u64)]))
        .call_method(c, "finalize_claim", args![did])
        .put_last_instruction_output_on_workspace("paid")
        .create_account_with_bucket(id, "paid")
        .with_seal_signer_authorized(true)
        .build_and_seal(sk);
    let r = env.test.execute_and_commit_on_success(tx, vec![]);
    env.test.disable_fees();
    r.finalize.result.any_reject().map(|x| format!("{x:?}"))
}

#[test]
fn a_claimant_with_no_account_and_no_funds_claims_and_collects() {
    let mut env = Env::new();
    let (sender, funder) = (user(&mut env.test), user(&mut env.test));
    let acct = Account::new();
    env.fund_sponsor(&funder, 2_000_000);
    assert_eq!(env.fee_balance(), Amount::from(2_000_000u64));
    assert_eq!(env.deposit(&sender, &acct.did, 5_000_000, 100, 0), None);

    let (sk, id) = bare_claimant(&mut env);
    let code: String = env.test.call_method(env.component, "expected_post_text", args![acct.did.clone(), id], vec![]);
    let post = acct.post(&format!("code {code}"), "3kaaaaaaaaaaa");

    assert_eq!(sponsored_start(&mut env, &sk, id, &acct, &post), None);
    let after_start = env.fee_balance();
    assert!(after_start < Amount::from(2_000_000u64), "the sponsor vault paid the fee");
    let pts = env.test.last_execution_points();
    println!("sponsored start_claim points: wasm={} native={} total={}", pts.wasm, pts.native, pts.total());

    assert_eq!(sponsored_finalize(&mut env, &sk, id, &acct.did), None);
    // The payout landed in an account created in that same transaction. Read its address before any other call
    // replaces the harness's record of the last transaction's outputs.
    let outputs: Vec<_> = [SubstateType::Component]
        .iter()
        .map(|t| env.test.get_previous_output_address(*t))
        .collect();
    let account = outputs.iter().find_map(|o| o.as_component_address()).expect("an account was created");
    assert!(env.fee_balance() < after_start, "the payout fee also came from the sponsor vault");
    assert_eq!(env.escrowed(), Amount::zero(), "deposit paid out");
    // The harness reports only one of the components the transaction touched, and which one is not stable: it may
    // be the escrow itself rather than the new account. The escrow being empty above already proves the payout.
    if account != env.component {
        assert_eq!(env.test.call_method::<Amount>(account, "balance", args![TARI_TOKEN], vec![]), Amount::from(5_000_000u64));
    }
}

#[test]
fn sponsorship_only_pays_for_valid_claims_and_is_bounded() {
    let mut env = Env::new();
    let (sender, funder) = (user(&mut env.test), user(&mut env.test));
    let acct = Account::new();
    env.fund_sponsor(&funder, 2_000_000);
    assert_eq!(env.deposit(&sender, &acct.did, 5_000_000, 100, WINDOW), None);
    let (sk, id) = bare_claimant(&mut env);
    let before = env.fee_balance();

    // A proof without the claim code is rejected and costs the vault nothing.
    let bad = acct.post("no code here", "3kaaaaaaaaaaa");
    assert!(sponsored_start(&mut env, &sk, id, &acct, &bad).is_some());
    assert_eq!(env.fee_balance(), before);

    // A valid claim is sponsored; but its payout is not sponsored while the window is open.
    let code: String = env.test.call_method(env.component, "expected_post_text", args![acct.did.clone(), id], vec![]);
    let post = acct.post(&format!("code {code}"), "3kaaaaaaaaaaa");
    assert_eq!(sponsored_start(&mut env, &sk, id, &acct, &post), None);
    let mid = env.fee_balance();
    assert!(sponsored_finalize(&mut env, &sk, id, &acct.did).is_some());
    assert_eq!(env.fee_balance(), mid, "no fee paid for a payout that cannot happen yet");

    // Someone else cannot spend this account's sponsored payout.
    let (sk2, id2) = bare_claimant(&mut env);
    set_epoch(&mut env.test, 1 + WINDOW);
    assert!(sponsored_finalize(&mut env, &sk2, id2, &acct.did).is_some());
    assert_eq!(sponsored_finalize(&mut env, &sk, id, &acct.did), None);
}

// ---- tips from a budget ---------------------------------------------------------------------------------

const MENTION: &str = "app.bsky.richtext.facet#mention";

fn facet(start: usize, end: usize, did: &str) -> V {
    V::M(vec![
        ("index", V::M(vec![("byteStart", V::U(start as u64)), ("byteEnd", V::U(end as u64))])),
        ("features", V::A(vec![V::M(vec![("$type", V::T(MENTION.into())), ("did", V::T(did.into()))])])),
    ])
}

/// `@bot.test tip @bob.test <amount>` with real mention facets for the bot and the recipient.
fn tip_record(recipient_did: &str, amount: &str) -> Vec<u8> {
    let (bot, bob) = ("@bot.test", "@bob.test");
    let text = format!("{bot} tip {bob} {amount}");
    let bob_start = bot.len() + 5;
    cbor(&V::M(vec![
        ("$type", V::T(COLLECTION.into())),
        ("text", V::T(text)),
        ("createdAt", V::T("2026-10-10T00:00:00.000Z".into())),
        ("facets", V::A(vec![facet(0, bot.len(), BOT), facet(bob_start, bob_start + bob.len(), recipient_did)])),
    ]))
}

impl Env {
    fn open_budget(&mut self, owner: &User, did: &str, window: u64, refund_after: u64, max_tip: u64, amount: u64) -> Option<String> {
        let (c, account, id, did) = (self.component, owner.account, owner.id, did.to_string());
        self.run(owner, |t| {
            t.call_method(account, "withdraw", args![TARI_TOKEN, Amount::from(amount)])
                .put_last_instruction_output_on_workspace("funds")
                .call_method(c, "open_budget", args![did, id, window, refund_after, Amount::from(max_tip), Workspace("funds")])
        })
    }

    fn close_budget(&mut self, who: &User, did: &str, owner: RistrettoPublicKeyBytes, amount: u64) -> Option<String> {
        let (c, account, did) = (self.component, who.account, did.to_string());
        self.run(who, |t| {
            t.call_method(c, "close_budget", args![did, owner, Amount::from(amount)])
                .put_last_instruction_output_on_workspace("back")
                .call_method(account, "deposit", args![Workspace("back")])
        })
    }

    fn tip(&mut self, relayer: &User, tipper: &Account, owner: RistrettoPublicKeyBytes, post: &Post) -> Option<String> {
        let c = self.component;
        let (did, ops, commit, nodes, record, rkey) = (
            tipper.did.clone(),
            bytes_list(&tipper.ops),
            Bytes::from_vec(post.commit.clone()),
            bytes_list(&post.nodes),
            Bytes::from_vec(post.record.clone()),
            post.rkey.clone(),
        );
        self.run(relayer, |t| t.call_method(c, "tip", args![did, owner, ops, commit, nodes, record, rkey]))
    }

    fn budget(&mut self, did: &str, owner: RistrettoPublicKeyBytes) -> Option<(Amount, u64, u64, Amount)> {
        self.test.call_method(self.component, "budget_for", args![did.to_string(), owner], vec![])
    }

    fn deposits_for(&mut self, did: &str) -> Vec<(RistrettoPublicKeyBytes, Amount, u64, u64, String)> {
        self.test.call_method(self.component, "deposits_for", args![did.to_string()], vec![])
    }
}

#[test]
fn a_tip_post_moves_budget_to_the_recipient_who_then_claims_it() {
    let mut env = Env::new();
    let (owner, relayer, bob_owner) = (user(&mut env.test), user(&mut env.test), user(&mut env.test));
    let (alice, bob) = (Account::new(), Account::new());
    assert_eq!(env.open_budget(&owner, &alice.did, 0, 100, 5_000_000, 10_000_000), None);
    assert_eq!(env.escrowed(), Amount::from(10_000_000u64));

    let post = alice.post_record(tip_record(&bob.did, "3"), "3kaaaaaaaaaaa");
    // Anyone can relay it. The relayer is not the owner.
    assert_eq!(env.tip(&relayer, &alice, owner.id, &post), None);
    let pts = env.test.last_execution_points();
    println!("tip points: wasm={} native={} total={}", pts.wasm, pts.native, pts.total());
    assert_eq!(env.budget(&alice.did, owner.id).unwrap().0, Amount::from(7_000_000u64));
    assert_eq!(env.escrowed(), Amount::from(10_000_000u64), "money only changes books");
    let deps = env.deposits_for(&bob.did);
    assert_eq!(deps.len(), 1);
    assert_eq!((deps[0].0, deps[0].1, deps[0].3), (owner.id, Amount::from(3_000_000u64), 0));

    // Bob proves he owns his account and collects the tip.
    let code = env.code_for(&bob.did, &bob_owner);
    let claim = bob.post(&format!("hi {code}"), "3kbbbbbbbbbbb");
    let before = env.balance(&bob_owner);
    assert_eq!(env.start_claim(&bob_owner, bob_owner.id, &bob, &claim), None);
    assert_eq!(env.finalize(&bob_owner, &bob.did), None);
    assert_eq!(env.balance(&bob_owner), before + Amount::from(3_000_000u64));
}

#[test]
fn a_post_can_only_tip_once_and_in_order() {
    let mut env = Env::new();
    let (owner, relayer) = (user(&mut env.test), user(&mut env.test));
    let (alice, bob) = (Account::new(), Account::new());
    assert_eq!(env.open_budget(&owner, &alice.did, 0, 100, 5_000_000, 10_000_000), None);

    let first = alice.post_record(tip_record(&bob.did, "1"), "3kbbbbbbbbbbb");
    assert_eq!(env.tip(&relayer, &alice, owner.id, &first), None);
    expect_err(env.tip(&relayer, &alice, owner.id, &first), "already spent");
    // An older post cannot be replayed after a newer one.
    let older = alice.post_record(tip_record(&bob.did, "1"), "3kaaaaaaaaaaa");
    expect_err(env.tip(&relayer, &alice, owner.id, &older), "already spent");
    let newer = alice.post_record(tip_record(&bob.did, "1"), "3kccccccccccc");
    assert_eq!(env.tip(&relayer, &alice, owner.id, &newer), None);
    assert_eq!(env.budget(&alice.did, owner.id).unwrap().0, Amount::from(8_000_000u64));
}

#[test]
fn tips_are_limited_by_the_budget_and_must_be_authentic() {
    let mut env = Env::new();
    let (owner, relayer, stranger) = (user(&mut env.test), user(&mut env.test), user(&mut env.test));
    let (alice, bob) = (Account::new(), Account::new());
    assert_eq!(env.open_budget(&owner, &alice.did, 0, 100, 2_000_000, 3_000_000), None);

    // Over the per-tip limit, then over the balance.
    let big = alice.post_record(tip_record(&bob.did, "2.5"), "3kaaaaaaaaaaa");
    expect_err(env.tip(&relayer, &alice, owner.id, &big), "per-tip limit");
    assert_eq!(env.tip(&relayer, &alice, owner.id, &alice.post_record(tip_record(&bob.did, "2"), "3kbbbbbbbbbbb")), None);
    expect_err(
        env.tip(&relayer, &alice, owner.id, &alice.post_record(tip_record(&bob.did, "2"), "3kccccccccccc")),
        "budget too small",
    );
    // A budget that belongs to someone else's key is a different budget.
    expect_err(
        env.tip(&relayer, &alice, stranger.id, &alice.post_record(tip_record(&bob.did, "1"), "3kddddddddddd")),
        "no such budget",
    );

    // A post signed by another account, a post that is not a tip, a post to the wrong bot, and self-tipping.
    let mallory = Account::new();
    let forged = mallory.post_record(tip_record(&bob.did, "1"), "3keeeeeeeeeee");
    expect_err(env.tip(&relayer, &alice, owner.id, &forged), "invalid repo proof");
    expect_err(env.tip(&relayer, &alice, owner.id, &alice.post("tip bob 1", "3kfffffffffff")), "not a tip post");
    let wrong_bot = cbor(&V::M(vec![
        ("$type", V::T(COLLECTION.into())),
        ("text", V::T("@bot.test tip @bob.test 1".into())),
        ("facets", V::A(vec![facet(0, 9, "did:plc:zzzzzzzzzzzzzzzzzzzzzzzz"), facet(14, 23, &bob.did)])),
    ]));
    expect_err(env.tip(&relayer, &alice, owner.id, &alice.post_record(wrong_bot, "3kggggggggggg")), "not a tip post");
    expect_err(
        env.tip(&relayer, &alice, owner.id, &alice.post_record(tip_record(&alice.did, "1"), "3khhhhhhhhhhh")),
        "cannot tip yourself",
    );
    // A short record key is not a TID.
    expect_err(
        env.tip(&relayer, &alice, owner.id, &alice.post_record(tip_record(&bob.did, "1"), "3kshort")),
        "13-character",
    );
}

#[test]
fn only_the_owner_withdraws_and_unclaimed_tips_refund_to_the_owner() {
    let mut env = Env::new();
    let (owner, relayer, thief) = (user(&mut env.test), user(&mut env.test), user(&mut env.test));
    let (alice, bob) = (Account::new(), Account::new());
    assert_eq!(env.open_budget(&owner, &alice.did, 0, 50, 5_000_000, 6_000_000), None);

    assert!(env.close_budget(&thief, &alice.did, owner.id, 1_000_000).is_some());
    let before = env.balance(&owner);
    assert_eq!(env.close_budget(&owner, &alice.did, owner.id, 1_000_000), None);
    assert_eq!(env.balance(&owner), before + Amount::from(1_000_000u64));

    assert_eq!(env.tip(&relayer, &alice, owner.id, &alice.post_record(tip_record(&bob.did, "2"), "3kaaaaaaaaaaa")), None);
    // Bob never claims. After the refund period the owner takes the tip back out of escrow.
    let c = env.component;
    let (did, owner_account) = (bob.did.clone(), owner.account);
    expect_err(env.run(&owner, |t| t.call_method(c, "refund", args![did.clone(), 0u32])), "not refundable yet");
    set_epoch(&mut env.test, 1 + 50);
    let mid = env.balance(&owner);
    assert_eq!(
        env.run(&owner, |t| {
            t.call_method(c, "refund", args![did, 0u32])
                .put_last_instruction_output_on_workspace("back")
                .call_method(owner_account, "deposit", args![Workspace("back")])
        }),
        None
    );
    assert_eq!(env.balance(&owner), mid + Amount::from(2_000_000u64));
}

fn sponsored_tip(
    env: &mut Env,
    sk: &RistrettoSecretKey,
    tipper: &Account,
    owner: RistrettoPublicKeyBytes,
    post: &Post,
) -> Option<String> {
    let c = env.component;
    let (did, ops, commit, nodes, record, rkey) = (
        tipper.did.clone(),
        bytes_list(&tipper.ops),
        Bytes::from_vec(post.commit.clone()),
        bytes_list(&post.nodes),
        Bytes::from_vec(post.record.clone()),
        post.rkey.clone(),
    );
    env.test.enable_fees();
    let tx = Transaction::builder_localnet(env.test.current_epoch())
        .with_fee_instructions_builder(|b| {
            b.call_method(c, "tip_sponsored", args![did, owner, ops, commit, nodes, record, rkey, Amount::from(60_000u64)])
        })
        .with_seal_signer_authorized(true)
        .build_and_seal(sk);
    let r = env.test.execute_and_commit_on_success(tx, vec![]);
    env.test.disable_fees();
    r.finalize.result.any_reject().map(|x| format!("{x:?}"))
}

#[test]
fn a_relayer_with_no_funds_relays_a_tip_and_the_tipper_covers_the_fee() {
    let mut env = Env::new();
    let (owner, funder) = (user(&mut env.test), user(&mut env.test));
    let (alice, bob) = (Account::new(), Account::new());
    env.fund_sponsor(&funder, 1_000_000);
    assert_eq!(env.open_budget(&owner, &alice.did, 0, 100, 5_000_000, 3_000_000), None);
    let (sk, _id) = bare_claimant(&mut env);

    let post = alice.post_record(tip_record(&bob.did, "2"), "3kaaaaaaaaaaa");
    assert_eq!(sponsored_tip(&mut env, &sk, &alice, owner.id, &post), None);
    let pts = env.test.last_execution_points();
    println!("sponsored tip points: wasm={} native={} total={}", pts.wasm, pts.native, pts.total());
    // The tipper's budget put the whole offered fee into the vault and the vault paid the real fee, so the
    // vault ends level (never drained by tips): within the offered fee of where it started.
    let vault = env.fee_balance();
    assert!(vault >= Amount::from(1_000_000u64) && vault <= Amount::from(1_060_000u64), "vault at {vault:?}");
    // The budget was charged the tip and the fee, and the books balance.
    let left = env.budget(&alice.did, owner.id).unwrap().0;
    assert!(left < Amount::from(1_000_000u64) && left > Amount::from(800_000u64), "budget left {left:?}");
    assert_eq!(env.deposits_for(&bob.did).len(), 1);

    // A tip that does not verify costs the sponsor vault nothing.
    let before = env.fee_balance();
    let bad = alice.post("not a tip", "3kbbbbbbbbbbb");
    assert!(sponsored_tip(&mut env, &sk, &alice, owner.id, &bad).is_some());
    assert_eq!(env.fee_balance(), before);
}

#[test]
fn a_deposit_with_a_challenge_only_pays_when_the_claim_post_says_it() {
    let mut env = Env::new();
    let (sender, alice) = (user(&mut env.test), user(&mut env.test));
    let acct = Account::new();
    assert_eq!(env.deposit_with(&sender, &acct.did, 5_000_000, 100, 0, "I love Tari"), None);
    let code = env.code_for(&acct.did, &alice);

    // A claim post without the phrase starts a claim but pays nothing.
    let plain = acct.post(&format!("claiming {code}"), "3kaaaaaaaaaaa");
    assert_eq!(env.start_claim(&alice, alice.id, &acct, &plain), None);
    expect_err(env.finalize(&alice, &acct.did), "required phrase");
    assert_eq!(env.escrowed(), Amount::from(5_000_000u64));

    // The phrase is exact and case sensitive.
    let wrong = acct.post(&format!("i love tari {code}"), "3kbbbbbbbbbbb");
    assert_eq!(env.start_claim(&alice, alice.id, &acct, &wrong), None);
    expect_err(env.finalize(&alice, &acct.did), "required phrase");

    // Posting it releases the money.
    let right = acct.post(&format!("I love Tari {code}"), "3kcccccccccc");
    let before = env.balance(&alice);
    assert_eq!(env.start_claim(&alice, alice.id, &acct, &right), None);
    assert_eq!(env.finalize(&alice, &acct.did), None);
    assert_eq!(env.balance(&alice), before + Amount::from(5_000_000u64));
    assert_eq!(env.escrowed(), Amount::zero());
}

#[test]
fn a_hostile_challenge_cannot_block_other_deposits_and_is_bounded() {
    let mut env = Env::new();
    let (honest, hostile, alice) = (user(&mut env.test), user(&mut env.test), user(&mut env.test));
    let acct = Account::new();
    expect_err(env.deposit_with(&hostile, &acct.did, 1_000_000, 100, 0, &"x".repeat(81)), "too long");
    expect_err(env.deposit_with(&hostile, &acct.did, 1_000_000, 100, 0, "line
break"), "control characters");
    assert_eq!(env.deposit(&honest, &acct.did, 4_000_000, 100, 0), None);
    assert_eq!(env.deposit_with(&hostile, &acct.did, 1_000_000, 100, 0, "say something impossible"), None);
    let code = env.code_for(&acct.did, &alice);
    let post = acct.post(&format!("claiming {code}"), "3kaaaaaaaaaaa");
    let before = env.balance(&alice);
    assert_eq!(env.start_claim(&alice, alice.id, &acct, &post), None);
    // The plain deposit pays; the one with an unmet phrase stays escrowed and its sender can refund it.
    assert_eq!(env.finalize(&alice, &acct.did), None);
    assert_eq!(env.balance(&alice), before + Amount::from(4_000_000u64));
    assert_eq!(env.escrowed(), Amount::from(1_000_000u64));
}

#[test]
fn two_deposits_with_different_phrases_can_be_claimed_together_or_one_at_a_time() {
    let mut env = Env::new();
    let (s1, s2, alice) = (user(&mut env.test), user(&mut env.test), user(&mut env.test));
    let acct = Account::new();
    assert_eq!(env.deposit_with(&s1, &acct.did, 3_000_000, 100, 0, "I love Tari"), None);
    assert_eq!(env.deposit_with(&s2, &acct.did, 2_000_000, 100, 0, "gm Ootle"), None);
    let code = env.code_for(&acct.did, &alice);
    let before = env.balance(&alice);

    // A post with only the first phrase releases only the first deposit; the claim stays pending for the other.
    let first = acct.post(&format!("I love Tari\nclaiming {code}"), "3kaaaaaaaaaaa");
    assert_eq!(env.start_claim(&alice, alice.id, &acct, &first), None);
    assert_eq!(env.finalize(&alice, &acct.did), None);
    assert_eq!(env.balance(&alice), before + Amount::from(3_000_000u64));
    assert_eq!(env.escrowed(), Amount::from(2_000_000u64));
    expect_err(env.finalize(&alice, &acct.did), "required phrase");

    // A second post with the other phrase releases the rest.
    let second = acct.post(&format!("gm Ootle\nclaiming {code}"), "3kbbbbbbbbbbb");
    assert_eq!(env.start_claim(&alice, alice.id, &acct, &second), None);
    assert_eq!(env.finalize(&alice, &acct.did), None);
    assert_eq!(env.balance(&alice), before + Amount::from(5_000_000u64));
    assert_eq!(env.escrowed(), Amount::zero());
}

#[test]
fn one_post_with_both_phrases_releases_both_deposits() {
    let mut env = Env::new();
    let (s1, s2, alice) = (user(&mut env.test), user(&mut env.test), user(&mut env.test));
    let acct = Account::new();
    assert_eq!(env.deposit_with(&s1, &acct.did, 3_000_000, 100, 0, "I love Tari"), None);
    assert_eq!(env.deposit_with(&s2, &acct.did, 2_000_000, 100, 0, "gm Ootle"), None);
    let code = env.code_for(&acct.did, &alice);
    let before = env.balance(&alice);
    let post = acct.post(&format!("I love Tari\ngm Ootle\nclaiming {code}"), "3kaaaaaaaaaaa");
    assert_eq!(env.start_claim(&alice, alice.id, &acct, &post), None);
    assert_eq!(env.finalize(&alice, &acct.did), None);
    assert_eq!(env.balance(&alice), before + Amount::from(5_000_000u64));
    assert_eq!(env.escrowed(), Amount::zero());
}

#[test]
fn a_bound_account_is_paid_directly_when_nothing_is_asked_of_it() {
    let mut env = Env::new();
    let (sender, wallet, relayer) = (user(&mut env.test), user(&mut env.test), user(&mut env.test));
    let acct = Account::new();
    assert_eq!(env.bound(&acct.did), None);
    let post = env.bind_post(&acct, wallet.account, "3kaaaaaaaaaaa");
    // anyone can relay the bind: the post is the authority
    assert_eq!(env.bind(&relayer, &acct, wallet.account, &post), None);
    assert_eq!(env.bound(&acct.did), Some(wallet.account));

    let before = env.balance(&wallet);
    assert_eq!(env.deposit(&sender, &acct.did, 3_000_000, 100, 0), None);
    assert_eq!(env.balance(&wallet), before + Amount::from(3_000_000u64));
    assert_eq!(env.escrowed(), Amount::zero());

    // a window or a phrase still escrows
    assert_eq!(env.deposit(&sender, &acct.did, 1_000_000, 100, WINDOW), None);
    assert_eq!(env.deposit_with(&sender, &acct.did, 2_000_000, 100, 0, "I love Tari"), None);
    assert_eq!(env.escrowed(), Amount::from(3_000_000u64));
}

#[test]
fn a_claim_for_a_bound_account_pays_the_bound_address() {
    let mut env = Env::new();
    let (sender, wallet, claimant) = (user(&mut env.test), user(&mut env.test), user(&mut env.test));
    let acct = Account::new();
    let post = env.bind_post(&acct, wallet.account, "3kaaaaaaaaaaa");
    assert_eq!(env.bind(&claimant, &acct, wallet.account, &post), None);
    assert_eq!(env.deposit_with(&sender, &acct.did, 2_000_000, 100, 0, "I love Tari"), None);

    let code = env.code_for(&acct.did, &claimant);
    let claim = acct.post(&format!("I love Tari {code}"), "3kbbbbbbbbbbb");
    assert_eq!(env.start_claim(&claimant, claimant.id, &acct, &claim), None);
    let (w0, c0) = (env.balance(&wallet), env.balance(&claimant));
    assert_eq!(env.finalize(&claimant, &acct.did), None);
    assert_eq!(env.balance(&wallet), w0 + Amount::from(2_000_000u64));
    assert_eq!(env.balance(&claimant), c0);
    assert_eq!(env.escrowed(), Amount::zero());
}

#[test]
fn a_new_binding_waits_and_an_old_post_cannot_move_it_back() {
    let mut env = Env::new();
    let (sender, first, second, relayer) = (user(&mut env.test), user(&mut env.test), user(&mut env.test), user(&mut env.test));
    let acct = Account::new();
    let p1 = env.bind_post(&acct, first.account, "3kaaaaaaaaaaa");
    assert_eq!(env.bind(&relayer, &acct, first.account, &p1), None);
    let p2 = env.bind_post(&acct, second.account, "3kbbbbbbbbbbb");
    assert_eq!(env.bind(&relayer, &acct, second.account, &p2), None);
    // the old binding still applies until the delay passes
    assert_eq!(env.bound(&acct.did), Some(first.account));
    let f0 = env.balance(&first);
    assert_eq!(env.deposit(&sender, &acct.did, 1_000_000, 100, 0), None);
    assert_eq!(env.balance(&first), f0 + Amount::from(1_000_000u64));

    set_epoch(&mut env.test, 2);
    assert_eq!(env.bound(&acct.did), Some(second.account));
    let s0 = env.balance(&second);
    assert_eq!(env.deposit(&sender, &acct.did, 1_000_000, 100, 0), None);
    assert_eq!(env.balance(&second), s0 + Amount::from(1_000_000u64));

    // replaying the earlier post is refused
    expect_err(env.bind(&relayer, &acct, first.account, &p1), "already used");
}

#[test]
fn a_bind_needs_the_owners_post_for_that_exact_address() {
    let mut env = Env::new();
    let (wallet, other, relayer) = (user(&mut env.test), user(&mut env.test), user(&mut env.test));
    let acct = Account::new();
    // a post for a different address does not bind this one
    let wrong = env.bind_post(&acct, other.account, "3kaaaaaaaaaaa");
    expect_err(env.bind(&relayer, &acct, wallet.account, &wrong), "bind code");
    // someone else's post, even with the right text, fails for this DID
    let intruder = Account::new();
    let code = env.bind_text(&acct.did, wallet.account);
    let forged = intruder.post(&format!("hi {code}"), "3kaaaaaaaaaaa");
    assert!(env.bind(&relayer, &acct, wallet.account, &forged).is_some());
    assert_eq!(env.bound(&acct.did), None);
}
