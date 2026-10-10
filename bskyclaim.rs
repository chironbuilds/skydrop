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
            .call_function(template, "new", args![TARI_TOKEN, Amount::from(1_000u64), WINDOW])
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

    fn deposit(&mut self, from: &User, did: &str, amount: u64, refund_epoch: u64) -> Option<String> {
        let c = self.component;
        let (account, id, did) = (from.account, from.id, did.to_string());
        self.run(from, |t| {
            t.call_method(account, "withdraw", args![TARI_TOKEN, Amount::from(amount)])
                .put_last_instruction_output_on_workspace("funds")
                .call_method(c, "deposit", args![did, id, refund_epoch, Workspace("funds")])
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
    assert_eq!(env.deposit(&sender1, &acct.did, 5_000_000, 100), None);
    assert_eq!(env.deposit(&sender2, &acct.did, 2_000_000, 100), None);
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
    assert_eq!(env.deposit(&sender, &acct.did, 5_000_000, 100), None);
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
    assert_eq!(env.deposit(&sender, &acct.did, 5_000_000, 100), None);
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
    assert_eq!(env.deposit(&sender, &acct.did, 5_000_000, 100), None);

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
    assert_eq!(env.deposit(&sender, &acct.did, 5_000_000, 10), None);
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
