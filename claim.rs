//   SPDX-License-Identifier: BSD-3-Clause
//! End-to-end test of the generic split: Escrow + ClaimPolicy as separate templates, with a claim driving
//! a badge-authenticated release across the component boundary. The synthetic-account builder is ported
//! from the monolith's test.

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
const LINK: &str = "tests/templates/link-registry";
const COLLECTION: &str = "app.bsky.feed.post";

// ---- DAG-CBOR builder (ported from bskyclaim.rs) ---------------------------------------------------

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
            ("prev", match prev {
                Some(p) => V::T(format!("b{}", base32(&[&[0x01, 0x71, 0x12, 0x20][..], &sha(p)].concat()))),
                None => V::Null,
            }),
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
struct Post {
    commit: Vec<u8>,
    nodes: Vec<Vec<u8>>,
    record: Vec<u8>,
    rkey: String,
}
#[derive(Clone)]
struct Account {
    did: String,
    ops: Vec<Vec<u8>>,
    repo_key: SigningKey,
    rotation_key: SigningKey,
}
impl Account {
    fn new() -> Self {
        let rotation_key = SigningKey::random(&mut rand_core::OsRng);
        let repo_key = SigningKey::random(&mut rand_core::OsRng);
        let genesis = plc_op(None, &rotation_key, &repo_key, &rotation_key);
        let did = format!("did:plc:{}", &base32(&sha(&genesis))[..24]);
        Self { did, ops: vec![genesis], repo_key, rotation_key }
    }
    /// The owner rotates the repo signing key (e.g. after it leaked): one more PLC op, a fresh key.
    fn rotate(&mut self) {
        let repo_key = SigningKey::random(&mut rand_core::OsRng);
        let op = plc_op(Some(self.ops.last().unwrap()), &self.rotation_key, &repo_key, &self.rotation_key);
        self.ops.push(op);
        self.repo_key = repo_key;
    }
    fn post(&self, text: &str, rkey: &str) -> Post {
        self.post_at(text, rkey, T0)
    }
    fn post_at(&self, text: &str, rkey: &str, rev: u64) -> Post {
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
            ("e", V::A(vec![
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
            ])),
        ]));
        let commit = |sig: Option<Vec<u8>>| {
            let mut m = vec![
                ("did", V::T(self.did.clone())),
                ("rev", V::T(tid(rev))),
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

fn bytes_list(items: &[Vec<u8>]) -> Vec<Bytes> {
    items.iter().map(|b| Bytes::from_vec(b.clone())).collect()
}

// ---- harness ---------------------------------------------------------------------------------------

struct U {
    account: ComponentAddress,
    badge: NonFungibleAddress,
    key: RistrettoSecretKey,
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

struct Setup {
    test: TemplateTest,
    escrow: ComponentAddress,
    claim: ComponentAddress,
    reg: ComponentAddress,
}

fn setup() -> Setup {
    let mut test = TemplateTest::new(CRATE_PATH, [ESCROW, CLAIM, LINK]);
    set_epoch(&mut test, 1);
    let escrow_t = test.get_template_address("Escrow");
    let claim_t = test.get_template_address("ClaimPolicy");
    let link_t = test.get_template_address("LinkRegistry");
    let admin = user(&mut test);
    let tx = test.transaction().call_function(escrow_t, "new", args![TARI_TOKEN, Amount::from(1_000u64), admin.id, 20_000u32]).build_and_seal(&admin.key);
    test.execute_expect_success(tx, vec![admin.badge.clone()]);
    let escrow = test.get_previous_output_address(SubstateType::Component).as_component_address().unwrap();
    let badge_res: ResourceAddress = test.call_method(escrow, "policy_badge_resource", args![], vec![]);
    let tx = test.transaction().call_function(link_t, "new", args![0u64]).build_and_seal(&admin.key);
    test.execute_expect_success(tx, vec![admin.badge.clone()]);
    let reg = test.get_previous_output_address(SubstateType::Component).as_component_address().unwrap();
    let tx = test.transaction().call_function(claim_t, "new", args![escrow, badge_res, reg]).build_and_seal(&admin.key);
    test.execute_expect_success(tx, vec![admin.badge.clone()]);
    let claim = test.get_previous_output_address(SubstateType::Component).as_component_address().unwrap();
    let tx = test
        .transaction()
        .call_method(escrow, "approve_policy", args![claim])
        .put_last_instruction_output_on_workspace("b")
        .call_method(claim, "receive_badge", args![Workspace("b")])
        .build_and_seal(&admin.key);
    test.execute_expect_success(tx, vec![admin.badge.clone()]);
    Setup { test, escrow, claim, reg }
}

/// Escrow a deposit for `did` governed by the claim policy, with the given challenge `window` (epochs).
fn deposit(s: &mut Setup, sender: &U, did: &str, amount: u64, refund: u64, window: u64) {
    let meta = Bytes::from_vec(window.to_be_bytes().to_vec());
    ensure_open(&mut s.test, s.escrow, &did.to_string());
    let tx = s
        .test
        .transaction()
        .call_method(sender.account, "withdraw", args![TARI_TOKEN, Amount::from(amount)])
        .put_last_instruction_output_on_workspace("funds")
        .call_method(s.escrow, "deposit", args![did.to_string(), sender.id, refund, s.claim, meta, Workspace("funds")])
        .build_and_seal(&sender.key);
    s.test.execute_expect_success(tx, vec![sender.badge.clone()]);
}

fn start_claim(s: &mut Setup, claimant: &U, acct: &Account, rkey: &str) {
    let code: String = s.test.call_method(s.claim, "expected_post_text", args![acct.did.clone(), claimant.id], vec![]);
    let post = acct.post(&code, rkey);
    let tx = s
        .test
        .transaction()
        .call_method(
            s.claim,
            "start_claim",
            args![acct.did.clone(), claimant.id, bytes_list(&acct.ops), Bytes::from_vec(post.commit), bytes_list(&post.nodes), Bytes::from_vec(post.record), rkey.to_string()],
        )
        .build_and_seal(&claimant.key);
    s.test.execute_expect_success(tx, vec![claimant.badge.clone()]);
}

/// Attempt finalize; returns whether it succeeded (routes any payout into the claimant's account).
fn finalize(s: &mut Setup, claimant: &U, did: &str, expect_ok: bool) {
    let tx = s
        .test
        .transaction()
        .call_method(s.claim, "finalize_claim", args![did.to_string()])
        .put_last_instruction_output_on_workspace("paid")
        .call_method(claimant.account, "deposit", args![Workspace("paid")])
        .build_and_seal(&claimant.key);
    if expect_ok {
        s.test.execute_expect_success(tx, vec![claimant.badge.clone()]);
    } else {
        s.test.execute_expect_failure(tx, vec![claimant.badge.clone()]);
    }
}

fn escrowed(s: &mut Setup) -> Amount {
    s.test.call_method(s.escrow, "total_escrowed", args![], vec![])
}

#[test]
fn window_zero_deposit_claims_immediately() {
    let mut s = setup();
    let acct = Account::new();
    let sender = user(&mut s.test);
    deposit(&mut s, &sender, &acct.did, 5_000, 100, 0);
    let claimant = user(&mut s.test);
    let before = s.test.call_method::<Amount>(claimant.account, "balance", args![TARI_TOKEN], vec![]);
    start_claim(&mut s, &claimant, &acct, "3jaaaaaaaaaaa");
    finalize(&mut s, &claimant, &acct.did, true);
    assert_eq!(escrowed(&mut s), Amount::zero());
    let after = s.test.call_method::<Amount>(claimant.account, "balance", args![TARI_TOKEN], vec![]);
    assert_eq!(after, before + Amount::from(5_000u64));
}

#[test]
fn deposit_stays_escrowed_until_its_window_passes() {
    let mut s = setup();
    let acct = Account::new();
    let sender = user(&mut s.test);
    deposit(&mut s, &sender, &acct.did, 7_000, 100, 3); // window of 3 epochs
    let claimant = user(&mut s.test);
    start_claim(&mut s, &claimant, &acct, "3jaaaaaaaaaaa"); // started at epoch 1
    // Before epoch 1+3, nothing is payable: finalize must fail and funds stay escrowed.
    set_epoch(&mut s.test, 3);
    finalize(&mut s, &claimant, &acct.did, false);
    assert_eq!(escrowed(&mut s), Amount::from(7_000u64));
    // Once the window has passed it pays out.
    set_epoch(&mut s.test, 4);
    finalize(&mut s, &claimant, &acct.did, true);
    assert_eq!(escrowed(&mut s), Amount::zero());
}

#[test]
fn finalize_pays_every_elapsed_deposit_in_one_call() {
    let mut s = setup();
    let acct = Account::new();
    let a = user(&mut s.test);
    let b = user(&mut s.test);
    deposit(&mut s, &a, &acct.did, 2_000, 100, 0);
    deposit(&mut s, &b, &acct.did, 3_000, 100, 0);
    assert_eq!(escrowed(&mut s), Amount::from(5_000u64));
    let claimant = user(&mut s.test);
    let before = s.test.call_method::<Amount>(claimant.account, "balance", args![TARI_TOKEN], vec![]);
    start_claim(&mut s, &claimant, &acct, "3jaaaaaaaaaaa");
    finalize(&mut s, &claimant, &acct.did, true);
    assert_eq!(escrowed(&mut s), Amount::zero());
    let after = s.test.call_method::<Amount>(claimant.account, "balance", args![TARI_TOKEN], vec![]);
    assert_eq!(after, before + Amount::from(5_000u64));
}

/// Escrow a deposit carrying a challenge phrase (metadata = window ++ phrase).
fn deposit_phrase(s: &mut Setup, sender: &U, did: &str, amount: u64, refund: u64, window: u64, phrase: &str) {
    let mut m = window.to_be_bytes().to_vec();
    m.extend_from_slice(&0u64.to_be_bytes()); // hold = 0
    m.push(0); // no envelope
    m.extend_from_slice(phrase.as_bytes());
    let meta = Bytes::from_vec(m);
    ensure_open(&mut s.test, s.escrow, &did.to_string());
    let tx = s
        .test
        .transaction()
        .call_method(sender.account, "withdraw", args![TARI_TOKEN, Amount::from(amount)])
        .put_last_instruction_output_on_workspace("funds")
        .call_method(s.escrow, "deposit", args![did.to_string(), sender.id, refund, s.claim, meta, Workspace("funds")])
        .build_and_seal(&sender.key);
    s.test.execute_expect_success(tx, vec![sender.badge.clone()]);
}

/// start_claim where the post also carries `extra` text (e.g. a required phrase) after the claim code.
fn start_claim_with(s: &mut Setup, claimant: &U, acct: &Account, rkey: &str, extra: &str) {
    let code: String = s.test.call_method(s.claim, "expected_post_text", args![acct.did.clone(), claimant.id], vec![]);
    let post = acct.post(&format!("{code} {extra}"), rkey);
    let tx = s
        .test
        .transaction()
        .call_method(
            s.claim,
            "start_claim",
            args![acct.did.clone(), claimant.id, bytes_list(&acct.ops), Bytes::from_vec(post.commit), bytes_list(&post.nodes), Bytes::from_vec(post.record), rkey.to_string()],
        )
        .build_and_seal(&claimant.key);
    s.test.execute_expect_success(tx, vec![claimant.badge.clone()]);
}

#[test]
fn phrase_deposit_pays_only_when_phrase_posted() {
    let mut s = setup();
    let acct = Account::new();
    let sender = user(&mut s.test);
    deposit_phrase(&mut s, &sender, &acct.did, 4_000, 100, 0, "launch");
    let claimant = user(&mut s.test);
    // A claim post with the code but not the phrase: nothing is payable yet, funds stay escrowed.
    start_claim(&mut s, &claimant, &acct, "3jaaaaaaaaaaa");
    finalize(&mut s, &claimant, &acct.did, false);
    assert_eq!(escrowed(&mut s), Amount::from(4_000u64));
    // Re-claim with a post that carries the code and the phrase: it pays.
    start_claim_with(&mut s, &claimant, &acct, "3jbbbbbbbbbbb", "launch");
    finalize(&mut s, &claimant, &acct.did, true);
    assert_eq!(escrowed(&mut s), Amount::zero());
}

const HOUR: u64 = 3_600_000_000;

/// Escrow a deposit requiring the claim post to stay up `hold` epochs (metadata = window ++ hold ++ "").
fn deposit_hold(s: &mut Setup, sender: &U, did: &str, amount: u64, refund: u64, window: u64, hold: u64) {
    let mut m = window.to_be_bytes().to_vec();
    m.extend_from_slice(&hold.to_be_bytes());
    let meta = Bytes::from_vec(m);
    ensure_open(&mut s.test, s.escrow, &did.to_string());
    let tx = s
        .test
        .transaction()
        .call_method(sender.account, "withdraw", args![TARI_TOKEN, Amount::from(amount)])
        .put_last_instruction_output_on_workspace("funds")
        .call_method(s.escrow, "deposit", args![did.to_string(), sender.id, refund, s.claim, meta, Workspace("funds")])
        .build_and_seal(&sender.key);
    s.test.execute_expect_success(tx, vec![sender.badge.clone()]);
}

/// Re-prove the claim post is still up, with a repo snapshot at `rev` micros.
fn confirm(s: &mut Setup, who: &U, acct: &Account, code: &str, rkey: &str, rev: u64) {
    let post = acct.post_at(code, rkey, rev);
    let tx = s
        .test
        .transaction()
        .call_method(s.claim, "confirm_claim", args![acct.did.clone(), bytes_list(&acct.ops), Bytes::from_vec(post.commit), bytes_list(&post.nodes), Bytes::from_vec(post.record), rkey.to_string()])
        .build_and_seal(&who.key);
    s.test.execute_expect_success(tx, vec![who.badge.clone()]);
}

#[test]
fn hold_deposit_pays_only_after_the_post_is_held() {
    let mut s = setup();            // epoch 1
    let acct = Account::new();
    let sender = user(&mut s.test);
    deposit_hold(&mut s, &sender, &acct.did, 6_000, 100, 0, 2); // 2-epoch hold, no window
    let claimant = user(&mut s.test);
    let code: String = s.test.call_method(s.claim, "expected_post_text", args![acct.did.clone(), claimant.id], vec![]);
    // start the claim at epoch 1 with the post at snapshot T0
    start_claim(&mut s, &claimant, &acct, "3jaaaaaaaaaaa");
    // before the hold is satisfied, nothing is payable
    s.test.set_virtual_substate(VirtualSubstateId::CurrentEpoch, VirtualSubstate::CurrentEpoch(3));
    finalize(&mut s, &claimant, &acct.did, false);
    assert_eq!(escrowed(&mut s), Amount::from(6_000u64));
    // re-prove the same post up, at a snapshot 2 hours later; now the hold is met
    confirm(&mut s, &claimant, &acct, &code, "3jaaaaaaaaaaa", T0 + 2 * HOUR);
    finalize(&mut s, &claimant, &acct.did, true);
    assert_eq!(escrowed(&mut s), Amount::zero());
}

#[test]
fn sponsored_start_and_finalize_are_paid_by_the_fee_vault() {
    let mut s = setup();
    // Fund the escrow fee vault with 2 tTARI.
    let funder = user(&mut s.test);
    let tx = s.test.transaction()
        .call_method(funder.account, "withdraw", args![TARI_TOKEN, Amount::from(2_000_000u64)])
        .put_last_instruction_output_on_workspace("f")
        .call_method(s.escrow, "fund", args![Workspace("f")])
        .build_and_seal(&funder.key);
    s.test.execute_expect_success(tx, vec![funder.badge.clone()]);
    assert_eq!(s.test.call_method::<Amount>(s.escrow, "fee_balance", args![], vec![]), Amount::from(2_000_000u64));

    // A 0.5 tTARI deposit for the account, enough to cover the sponsored fees it will draw.
    let acct = Account::new();
    let sender = user(&mut s.test);
    deposit(&mut s, &sender, &acct.did, 500_000, 100, 0);
    let claimant = user(&mut s.test);
    let code: String = s.test.call_method(s.claim, "expected_post_text", args![acct.did.clone(), claimant.id], vec![]);
    let post = acct.post(&code, "3jaaaaaaaaaaa");

    // Sponsored start: the fee is paid by the vault, from the fee phase.
    s.test.enable_fees();
    let tx = s.test.transaction()
        .with_fee_instructions_builder(|b| b.call_method(s.claim, "start_claim_sponsored", args![acct.did.clone(), claimant.id, bytes_list(&acct.ops), Bytes::from_vec(post.commit), bytes_list(&post.nodes), Bytes::from_vec(post.record), post.rkey, Amount::from(60_000u64)]))
        .build_and_seal(&claimant.key);
    s.test.execute_expect_success(tx, vec![claimant.badge.clone()]);
    s.test.disable_fees();
    let after_start = s.test.call_method::<Amount>(s.escrow, "fee_balance", args![], vec![]);
    assert!(after_start < Amount::from(2_000_000u64), "the fee vault paid the start");

    // Sponsored finalize (fee phase) + the finalize itself (main phase); the payout nets the owed fees back.
    s.test.enable_fees();
    let tx = s.test.transaction()
        .with_fee_instructions_builder(|b| b.call_method(s.claim, "sponsor_finalize", args![acct.did.clone(), Amount::from(60_000u64)]))
        .call_method(s.claim, "finalize_claim", args![acct.did.clone()])
        .put_last_instruction_output_on_workspace("paid")
        .call_method(claimant.account, "deposit", args![Workspace("paid")])
        .build_and_seal(&claimant.key);
    s.test.execute_expect_success(tx, vec![claimant.badge.clone()]);
    s.test.disable_fees();
    assert!(s.test.call_method::<Amount>(s.escrow, "fee_balance", args![], vec![]) > after_start, "the vault is repaid out of the payout");
    assert_eq!(escrowed(&mut s), Amount::zero());
}

/// Escrow a deposit with raw `meta` bytes (to exercise malformed / out-of-range metadata).
fn deposit_raw(s: &mut Setup, sender: &U, did: &str, amount: u64, refund: u64, meta: Vec<u8>) {
    ensure_open(&mut s.test, s.escrow, &did.to_string());
    let tx = s
        .test
        .transaction()
        .call_method(sender.account, "withdraw", args![TARI_TOKEN, Amount::from(amount)])
        .put_last_instruction_output_on_workspace("funds")
        .call_method(s.escrow, "deposit", args![did.to_string(), sender.id, refund, s.claim, Bytes::from_vec(meta), Workspace("funds")])
        .build_and_seal(&sender.key);
    s.test.execute_expect_success(tx, vec![sender.badge.clone()]);
}

fn sweep(s: &mut Setup, who: &U, did: &str, expect_ok: bool) {
    let tx = s.test.transaction().call_method(s.claim, "sweep", args![did.to_string()]).build_and_seal(&who.key);
    if expect_ok {
        s.test.execute_expect_success(tx, vec![who.badge.clone()]);
    } else {
        s.test.execute_expect_failure(tx, vec![who.badge.clone()]);
    }
}

fn returned_for(s: &mut Setup, did: &str, sender: &U) -> Amount {
    s.test.call_method(s.escrow, "returned_for", args![did.to_string(), sender.id], vec![])
}

#[test]
fn a_huge_window_deposit_cannot_block_real_deposits_and_is_swept() {
    let mut s = setup();
    let acct = Account::new();
    let honest = user(&mut s.test);
    let griefer = user(&mut s.test);
    deposit(&mut s, &honest, &acct.did, 5_000, 100, 0);
    // window = u64::MAX: unchecked `start + window` would overflow on every payout check for this account.
    deposit_raw(&mut s, &griefer, &acct.did, 1_000, 100, u64::MAX.to_be_bytes().to_vec());
    let claimant = user(&mut s.test);
    start_claim(&mut s, &claimant, &acct, "3jaaaaaaaaaaa");
    finalize(&mut s, &claimant, &acct.did, true);
    // The honest deposit paid; the invalid one is still escrowed and goes back to its sender, mid-claim or not.
    assert_eq!(escrowed(&mut s), Amount::from(1_000u64));
    let anyone = user(&mut s.test);
    sweep(&mut s, &anyone, &acct.did, true);
    assert_eq!(returned_for(&mut s, &acct.did, &griefer), Amount::from(1_000u64));
    assert_eq!(escrowed(&mut s), Amount::from(1_000u64)); // waiting for its sender's refund
}

#[test]
fn an_unanswered_phrase_gift_is_swept_back_only_after_72_epochs() {
    let mut s = setup();
    let acct = Account::new();
    let sender = user(&mut s.test);
    deposit_phrase(&mut s, &sender, &acct.did, 4_000, 500, 0, "launch");
    let anyone = user(&mut s.test);
    // made at epoch 1 (setup's epoch), so sweepable from epoch 1 + 72
    set_epoch(&mut s.test, 72);
    sweep(&mut s, &anyone, &acct.did, false);
    set_epoch(&mut s.test, 73);
    sweep(&mut s, &anyone, &acct.did, true);
    assert_eq!(returned_for(&mut s, &acct.did, &sender), Amount::from(4_000u64));
    // A plain gift is never swept: it pays whoever claims.
    deposit(&mut s, &sender, &acct.did, 2_000, 500, 0);
    set_epoch(&mut s.test, 400);
    sweep(&mut s, &anyone, &acct.did, false);
}

#[test]
fn out_of_range_metadata_never_pays() {
    let mut s = setup();
    let acct = Account::new();
    let sender = user(&mut s.test);
    // window 11 (> MAX_WINDOW 10), and a bad envelope flag: both invalid, so nothing is payable.
    deposit_raw(&mut s, &sender, &acct.did, 3_000, 100, 11u64.to_be_bytes().to_vec());
    let mut bad_flag = 0u64.to_be_bytes().to_vec();
    bad_flag.extend_from_slice(&0u64.to_be_bytes());
    bad_flag.push(7);
    deposit_raw(&mut s, &sender, &acct.did, 3_000, 100, bad_flag);
    let claimant = user(&mut s.test);
    start_claim(&mut s, &claimant, &acct, "3jaaaaaaaaaaa");
    finalize(&mut s, &claimant, &acct.did, false);
    assert_eq!(escrowed(&mut s), Amount::from(6_000u64));
}

#[test]
fn a_rotated_away_key_cannot_claim_once_the_registry_has_seen_the_rotation() {
    let mut s = setup();
    let mut acct = Account::new();
    let thief = acct.clone(); // holds the old repo key and the old (shorter) chain
    acct.rotate();
    // the owner rotated; someone (the bot) shows the registry the new chain
    let anyone = user(&mut s.test);
    let tx = s.test.transaction().call_method(s.reg, "observe_chain", args![acct.did.clone(), bytes_list(&acct.ops)]).build_and_seal(&anyone.key);
    s.test.execute_expect_success(tx, vec![anyone.badge.clone()]);

    let sender = user(&mut s.test);
    deposit(&mut s, &sender, &acct.did, 5_000, 100, 0);
    // the thief proves a claim post with the old key and old chain: refused
    let claimant = user(&mut s.test);
    let code: String = s.test.call_method(s.claim, "expected_post_text", args![thief.did.clone(), claimant.id], vec![]);
    let post = thief.post(&code, "3jaaaaaaaaaaa");
    let tx = s.test.transaction()
        .call_method(s.claim, "start_claim", args![thief.did.clone(), claimant.id, bytes_list(&thief.ops), Bytes::from_vec(post.commit), bytes_list(&post.nodes), Bytes::from_vec(post.record), "3jaaaaaaaaaaa".to_string()])
        .build_and_seal(&claimant.key);
    s.test.execute_expect_failure(tx, vec![claimant.badge.clone()]);
    // the real owner, with the new key and chain, can
    start_claim(&mut s, &claimant, &acct, "3jbbbbbbbbbbb");
    finalize(&mut s, &claimant, &acct.did, true);
}
