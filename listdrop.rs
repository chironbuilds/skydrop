//   SPDX-License-Identifier: BSD-3-Clause
//! End-to-end test of ListDrop: an org vouches for members with list items in its own repo; each member
//! binds their payout with a claim-code post and takes one slot. Covers wrong list, wrong subject, a list
//! proof older than the snapshot, front-running, double claims, and a stranger griefing the pool.

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
const DROP: &str = "tests/templates/list-drop";
const LINK: &str = "tests/templates/link-registry";

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
    fn record_at(&self, collection: &str, record: Vec<u8>, rkey: &str, rev: u64) -> Post {
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
                ("did", V::T(self.did.clone())), ("rev", V::T(tid(rev))), ("data", V::Link(sha(&node))),
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
        self.record_at("app.bsky.feed.post", record, rkey, T0)
    }
    /// A list item in this (org) repo putting `member` on `list`, committed at `rev` µs.
    fn listitem(&self, member: &str, list: &str, rkey: &str, rev: u64) -> Post {
        let record = cbor(&V::M(vec![
            ("$type", V::T("app.bsky.graph.listitem".into())),
            ("subject", V::T(member.into())),
            ("list", V::T(list.into())),
            ("createdAt", V::T("2026-10-10T00:00:00.000Z".into())),
        ]));
        self.record_at("app.bsky.graph.listitem", record, rkey, rev)
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


struct Env { reg: ComponentAddress, test: TemplateTest, escrow: ComponentAddress, drop: ComponentAddress }

fn setup() -> Env {
    let mut test = TemplateTest::new(CRATE_PATH, [ESCROW, DROP, LINK]);
    set_epoch(&mut test, 1);
    let escrow_t = test.get_template_address("Escrow");
    let drop_t = test.get_template_address("ListDrop");
    let link_t = test.get_template_address("LinkRegistry");
    let admin = user(&mut test);
    let tx = test.transaction().call_function(escrow_t, "new", args![TARI_TOKEN, Amount::from(1_000u64), admin.id, 20_000u32]).build_and_seal(&admin.key);
    test.execute_expect_success(tx, vec![admin.badge.clone()]);
    let escrow = test.get_previous_output_address(SubstateType::Component).as_component_address().unwrap();
    let badge_res: ResourceAddress = test.call_method(escrow, "policy_badge_resource", args![], vec![]);
    let tx = test.transaction().call_function(link_t, "new", args![0u64, 20_000u32]).build_and_seal(&admin.key);
    test.execute_expect_success(tx, vec![admin.badge.clone()]);
    let reg = test.get_previous_output_address(SubstateType::Component).as_component_address().unwrap();
    let tx = test.transaction().call_function(drop_t, "new", args![escrow, badge_res, reg]).build_and_seal(&admin.key);
    test.execute_expect_success(tx, vec![admin.badge.clone()]);
    let drop = test.get_previous_output_address(SubstateType::Component).as_component_address().unwrap();
    let tx = test.transaction()
        .call_method(escrow, "approve_policy", args![drop])
        .put_last_instruction_output_on_workspace("b")
        .call_method(drop, "receive_badge", args![Workspace("b")])
        .build_and_seal(&admin.key);
    test.execute_expect_success(tx, vec![admin.badge.clone()]);
    Env { reg, test, escrow, drop }
}

fn terms(snapshot: u64, list: &str) -> Bytes {
    let mut m = snapshot.to_be_bytes().to_vec();
    m.extend_from_slice(list.as_bytes());
    Bytes::from_vec(m)
}

fn fund(env: &mut Env, who: &U, campaign: &str, meta: Bytes) {
    ensure_open(&mut env.test, env.escrow, &campaign.to_string());
    let tx = env.test.transaction()
        .call_method(who.account, "withdraw", args![TARI_TOKEN, Amount::from(1_000u64)])
        .put_last_instruction_output_on_workspace("funds")
        .call_method(env.escrow, "deposit", args![campaign.to_string(), who.id, 100u64, env.drop, meta, Workspace("funds")])
        .build_and_seal(&who.key);
    env.test.execute_expect_success(tx, vec![who.badge.clone()]);
}

/// `submitter` signs and receives; `claimant` is the key the payout is bound to (normally the same).
#[allow(clippy::too_many_arguments)]
fn claim(env: &mut Env, campaign: &str, member: &Account, org: &Account, item: &Post, code_post: &Post, claimant: &U, submitter: &U, expect_ok: bool) {
    let tx = env.test.transaction()
        .call_method(env.drop, "claim", args![
            campaign.to_string(), member.did.clone(), claimant.id, bytes_list(&member.ops), bytes_list(&org.ops),
            Bytes::from_vec(item.commit.clone()), bytes_list(&item.nodes), Bytes::from_vec(item.record.clone()), item.rkey.clone(),
            Bytes::from_vec(code_post.commit.clone()), bytes_list(&code_post.nodes), Bytes::from_vec(code_post.record.clone()), code_post.rkey.clone()
        ])
        .put_last_instruction_output_on_workspace("paid")
        .call_method(submitter.account, "deposit", args![Workspace("paid")])
        .build_and_seal(&submitter.key);
    if expect_ok {
        env.test.execute_expect_success(tx, vec![submitter.badge.clone()]);
    } else {
        env.test.execute_expect_failure(tx, vec![submitter.badge.clone()]);
    }
}

fn code(env: &mut Env, campaign: &str, member: &Account, claimant: &U) -> String {
    env.test.call_method(env.drop, "expected_post_text", args![campaign.to_string(), member.did.clone(), claimant.id], vec![])
}

fn balance(env: &mut Env, a: ComponentAddress) -> Amount {
    env.test.call_method(a, "balance", args![TARI_TOKEN], vec![])
}

#[test]
fn list_members_vouched_for_by_the_org_each_take_one_slot() {
    let mut env = setup();
    let org = Account::new();
    ensure_open(&mut env.test, env.reg, &org.did);
    let list = format!("at://{}/app.bsky.graph.list/3kteam00000aa", org.did);
    let other_list = format!("at://{}/app.bsky.graph.list/3kfans00000aa", org.did);
    let funder = user(&mut env.test);
    let campaign = format!("{}:team-drop", hex(&funder.id));

    // A stranger's junk slot at the front of the pool doesn't block anyone.
    let griefer = user(&mut env.test);
    fund(&mut env, &griefer, &campaign, Bytes::from_vec(vec![1, 2, 3]));
    fund(&mut env, &funder, &campaign, terms(T0, &list));
    fund(&mut env, &funder, &campaign, terms(T0, &list));
    assert_eq!(env.test.call_method::<u32>(env.drop, "slots_left", args![campaign.clone()], vec![]), 2);

    let alice = Account::new();
    ensure_open(&mut env.test, env.reg, &alice.did);
    let alice_w = user(&mut env.test);
    let mallory = user(&mut env.test);
    let alice_code = code(&mut env, &campaign, &alice, &alice_w);
    let alice_post = alice.post(&format!("claiming my team drop {alice_code}"), "3jaaaaaaaaaaa");

    // The org's item on a different list, or for a different account, proves nothing.
    claim(&mut env, &campaign, &alice, &org, &org.listitem(&alice.did, &other_list, "3kaaaaaaaaaaa", T0), &alice_post, &alice_w, &alice_w, false);
    claim(&mut env, &campaign, &alice, &org, &org.listitem(&Account::new().did, &list, "3kaaaaaaaaaaa", T0), &alice_post, &alice_w, &alice_w, false);
    // An item from a commit older than the snapshot (e.g. added and removed before the drop) is refused.
    claim(&mut env, &campaign, &alice, &org, &org.listitem(&alice.did, &list, "3kaaaaaaaaaaa", T0 - 1_000_000), &alice_post, &alice_w, &alice_w, false);
    // A self-made "list item" in the member's own repo is not the org vouching.
    let self_item = alice.listitem(&alice.did, &list, "3kaaaaaaaaaaa", T0);
    claim(&mut env, &campaign, &alice, &org, &self_item, &alice_post, &alice_w, &alice_w, false);

    let item = org.listitem(&alice.did, &list, "3kaaaaaaaaaaa", T0);
    // Mallory replays Alice's public proofs, binding the payout to her own key: the code doesn't match.
    claim(&mut env, &campaign, &alice, &org, &item, &alice_post, &mallory, &mallory, false);

    let before = balance(&mut env, alice_w.account);
    claim(&mut env, &campaign, &alice, &org, &item, &alice_post, &alice_w, &alice_w, true);
    assert_eq!(balance(&mut env, alice_w.account), before + Amount::from(1_000u64));
    assert!(env.test.call_method::<bool>(env.drop, "has_claimed", args![campaign.clone(), alice.did.clone()], vec![]));
    assert_eq!(env.test.call_method::<u32>(env.drop, "slots_left", args![campaign.clone()], vec![]), 1);
    // Once per account.
    claim(&mut env, &campaign, &alice, &org, &item, &alice.post(&alice_code, "3jbbbbbbbbbbb"), &alice_w, &alice_w, false);

    // A second member takes the last slot; after that the drop is exhausted.
    let bob = Account::new();
    ensure_open(&mut env.test, env.reg, &bob.did);
    let bob_w = user(&mut env.test);
    let bob_code = code(&mut env, &campaign, &bob, &bob_w);
    claim(&mut env, &campaign, &bob, &org, &org.listitem(&bob.did, &list, "3kbbbbbbbbbbb", T0 + 5), &bob.post(&bob_code, "3jaaaaaaaaaaa"), &bob_w, &bob_w, true);
    let carol = Account::new();
    ensure_open(&mut env.test, env.reg, &carol.did);
    let carol_w = user(&mut env.test);
    let carol_code = code(&mut env, &campaign, &carol, &carol_w);
    claim(&mut env, &campaign, &carol, &org, &org.listitem(&carol.did, &list, "3kccccccccccc", T0), &carol.post(&carol_code, "3jaaaaaaaaaaa"), &carol_w, &carol_w, false);
    // Only the griefer's junk deposit is left in escrow.
    assert_eq!(env.test.call_method::<Amount>(env.escrow, "total_escrowed", args![], vec![]), Amount::from(1_000u64));
}

#[test]
fn a_claim_code_is_bound_to_one_campaign() {
    let mut env = setup();
    let org = Account::new();
    ensure_open(&mut env.test, env.reg, &org.did);
    let list = format!("at://{}/app.bsky.graph.list/3kteam00000aa", org.did);
    let funder = user(&mut env.test);
    let (c1, c2) = (format!("{}:q1", hex(&funder.id)), format!("{}:q2", hex(&funder.id)));
    fund(&mut env, &funder, &c1, terms(T0, &list));
    fund(&mut env, &funder, &c2, terms(T0, &list));
    let alice = Account::new();
    ensure_open(&mut env.test, env.reg, &alice.did);
    let w = user(&mut env.test);
    let item = org.listitem(&alice.did, &list, "3kaaaaaaaaaaa", T0);
    let p1 = alice.post(&code(&mut env, &c1, &alice, &w), "3jaaaaaaaaaaa");
    // A post made for campaign q1 can't be used to claim q2 on the member's behalf.
    claim(&mut env, &c2, &alice, &org, &item, &p1, &w, &w, false);
    claim(&mut env, &c1, &alice, &org, &item, &p1, &w, &w, true);
    let p2 = alice.post(&code(&mut env, &c2, &alice, &w), "3jbbbbbbbbbbb");
    claim(&mut env, &c2, &alice, &org, &item, &p2, &w, &w, true);
}
