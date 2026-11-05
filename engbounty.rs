//   SPDX-License-Identifier: BSD-3-Clause
//! End-to-end test of EngagementBounty: a repost bounty pool on the shared Escrow. A claimant proves a
//! repost of the target post plus a claim-code post binding their wallet, and takes one slot; a second
//! claim by the same account is refused.

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
const BOUNTY: &str = "tests/templates/engagement-bounty";
const LINK: &str = "tests/templates/link-registry";
const TARGET: &str = "at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/app.bsky.feed.post/abc123";

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

#[test]
fn repost_bounty_pays_each_account_once() {
    let mut test = TemplateTest::new(CRATE_PATH, [ESCROW, BOUNTY, LINK]);
    set_epoch(&mut test, 1);
    let escrow_t = test.get_template_address("Escrow");
    let bounty_t = test.get_template_address("EngagementBounty");
    let link_t = test.get_template_address("LinkRegistry");
    let admin = user(&mut test);

    let tx = test.transaction().call_function(escrow_t, "new", args![TARI_TOKEN, Amount::from(1_000u64), admin.id, 20_000u32]).build_and_seal(&admin.key);
    test.execute_expect_success(tx, vec![admin.badge.clone()]);
    let escrow = test.get_previous_output_address(SubstateType::Component).as_component_address().unwrap();
    let badge_res: ResourceAddress = test.call_method(escrow, "policy_badge_resource", args![], vec![]);

    let tx = test.transaction().call_function(link_t, "new", args![0u64, 20_000u32]).build_and_seal(&admin.key);
    test.execute_expect_success(tx, vec![admin.badge.clone()]);
    let reg = test.get_previous_output_address(SubstateType::Component).as_component_address().unwrap();

    let tx = test.transaction().call_function(bounty_t, "new", args![escrow, badge_res, reg]).build_and_seal(&admin.key);
    test.execute_expect_success(tx, vec![admin.badge.clone()]);
    let bounty = test.get_previous_output_address(SubstateType::Component).as_component_address().unwrap();

    let tx = test.transaction()
        .call_method(escrow, "approve_policy", args![bounty])
        .put_last_instruction_output_on_workspace("b")
        .call_method(bounty, "receive_badge", args![Workspace("b")])
        .build_and_seal(&admin.key);
    test.execute_expect_success(tx, vec![admin.badge.clone()]);

    // Funder escrows two equal slots under the campaign. metadata = [kind=1 repost][target uri].
    let funder = user(&mut test);
    let campaign = format!("{}:repost-launch", hex(&funder.id));
    // A stranger first drops an unclaimable slot (unknown kind) at the front of the campaign. It must not
    // block anyone: only the funder's own slots count.
    let griefer = user(&mut test);
    ensure_open(&mut test, escrow, &campaign.clone());
    let tx = test.transaction()
        .call_method(griefer.account, "withdraw", args![TARI_TOKEN, Amount::from(1_000u64)])
        .put_last_instruction_output_on_workspace("funds")
        .call_method(escrow, "deposit", args![campaign.clone(), griefer.id, 100u64, bounty, Bytes::from_vec(vec![9u8, b'x']), Workspace("funds")])
        .build_and_seal(&griefer.key);
    test.execute_expect_success(tx, vec![griefer.badge.clone()]);
    let mut meta = vec![1u8];
    meta.extend_from_slice(TARGET.as_bytes());
    for _ in 0..2u32 {
        ensure_open(&mut test, escrow, &campaign.clone());
        let tx = test.transaction()
            .call_method(funder.account, "withdraw", args![TARI_TOKEN, Amount::from(1_000u64)])
            .put_last_instruction_output_on_workspace("funds")
            .call_method(escrow, "deposit", args![campaign.clone(), funder.id, 100u64, bounty, Bytes::from_vec(meta.clone()), Workspace("funds")])
            .build_and_seal(&funder.key);
        test.execute_expect_success(tx, vec![funder.badge.clone()]);
    }
    assert_eq!(test.call_method::<u32>(bounty, "slots_left", args![campaign.clone()], vec![]), 2);
    assert_eq!(test.call_method::<Amount>(escrow, "total_escrowed", args![], vec![]), Amount::from(3_000u64));

    // A reposter claims: repost record + claim-code post, both in their repo.
    let acct = Account::new();
    ensure_open(&mut test, reg, &acct.did);
    let claimant = user(&mut test);
    let code: String = test.call_method(bounty, "expected_post_text", args![acct.did.clone(), claimant.id], vec![]);
    let codepost = acct.post(&code, "3jaaaaaaaaaaa");
    let repost = acct.repost(TARGET, "3jbbbbbbbbbbb");
    let before = test.call_method::<Amount>(claimant.account, "balance", args![TARI_TOKEN], vec![]);

    let tx = test.transaction()
        .call_method(bounty, "claim", args![
            campaign.clone(), acct.did.clone(), claimant.id, bytes_list(&acct.ops),
            Bytes::from_vec(repost.commit.clone()), bytes_list(&repost.nodes), Bytes::from_vec(repost.record.clone()), repost.rkey.clone(),
            Bytes::from_vec(codepost.commit.clone()), bytes_list(&codepost.nodes), Bytes::from_vec(codepost.record.clone()), codepost.rkey.clone()
        ])
        .put_last_instruction_output_on_workspace("paid")
        .call_method(claimant.account, "deposit", args![Workspace("paid")])
        .build_and_seal(&claimant.key);
    test.execute_expect_success(tx, vec![claimant.badge.clone()]);

    let after = test.call_method::<Amount>(claimant.account, "balance", args![TARI_TOKEN], vec![]);
    assert_eq!(after, before + Amount::from(1_000u64));
    assert_eq!(test.call_method::<u32>(bounty, "slots_left", args![campaign.clone()], vec![]), 1);

    // The same account cannot claim again.
    let codepost2 = acct.post(&code, "3jccccccccccc");
    let repost2 = acct.repost(TARGET, "3jdddddddddddd");
    let tx = test.transaction()
        .call_method(bounty, "claim", args![
            campaign.clone(), acct.did.clone(), claimant.id, bytes_list(&acct.ops),
            Bytes::from_vec(repost2.commit), bytes_list(&repost2.nodes), Bytes::from_vec(repost2.record), repost2.rkey,
            Bytes::from_vec(codepost2.commit), bytes_list(&codepost2.nodes), Bytes::from_vec(codepost2.record), codepost2.rkey
        ])
        .build_and_seal(&claimant.key);
    test.execute_expect_failure(tx, vec![claimant.badge.clone()]);
}

#[test]
fn proof_of_post_bounty_pays_a_post_containing_the_text() {
    let mut test = TemplateTest::new(CRATE_PATH, [ESCROW, BOUNTY, LINK]);
    set_epoch(&mut test, 1);
    let escrow_t = test.get_template_address("Escrow");
    let bounty_t = test.get_template_address("EngagementBounty");
    let link_t = test.get_template_address("LinkRegistry");
    let admin = user(&mut test);
    let tx = test.transaction().call_function(escrow_t, "new", args![TARI_TOKEN, Amount::from(1_000u64), admin.id, 20_000u32]).build_and_seal(&admin.key);
    test.execute_expect_success(tx, vec![admin.badge.clone()]);
    let escrow = test.get_previous_output_address(SubstateType::Component).as_component_address().unwrap();
    let badge_res: ResourceAddress = test.call_method(escrow, "policy_badge_resource", args![], vec![]);
    let tx = test.transaction().call_function(link_t, "new", args![0u64, 20_000u32]).build_and_seal(&admin.key);
    test.execute_expect_success(tx, vec![admin.badge.clone()]);
    let reg = test.get_previous_output_address(SubstateType::Component).as_component_address().unwrap();
    let tx = test.transaction().call_function(bounty_t, "new", args![escrow, badge_res, reg]).build_and_seal(&admin.key);
    test.execute_expect_success(tx, vec![admin.badge.clone()]);
    let bounty = test.get_previous_output_address(SubstateType::Component).as_component_address().unwrap();
    let tx = test.transaction()
        .call_method(escrow, "approve_policy", args![bounty])
        .put_last_instruction_output_on_workspace("b")
        .call_method(bounty, "receive_badge", args![Workspace("b")])
        .build_and_seal(&admin.key);
    test.execute_expect_success(tx, vec![admin.badge.clone()]);

    // One slot: kind 3, the post must contain "#OotleLaunch".
    let funder = user(&mut test);
    let campaign = format!("{}:hashtag", hex(&funder.id));
    let mut meta = vec![3u8];
    meta.extend_from_slice(b"#OotleLaunch");
    ensure_open(&mut test, escrow, &campaign.clone());
    let tx = test.transaction()
        .call_method(funder.account, "withdraw", args![TARI_TOKEN, Amount::from(2_000u64)])
        .put_last_instruction_output_on_workspace("funds")
        .call_method(escrow, "deposit", args![campaign.clone(), funder.id, 100u64, bounty, Bytes::from_vec(meta), Workspace("funds")])
        .build_and_seal(&funder.key);
    test.execute_expect_success(tx, vec![funder.badge.clone()]);

    let acct = Account::new();
    ensure_open(&mut test, reg, &acct.did);
    let claimant = user(&mut test);
    let code: String = test.call_method(bounty, "expected_post_text", args![acct.did.clone(), claimant.id], vec![]);
    let claim = |test: &mut TemplateTest, post: &Post, expect_ok: bool| {
        let tx = test.transaction()
            .call_method(bounty, "claim", args![
                campaign.clone(), acct.did.clone(), claimant.id, bytes_list(&acct.ops),
                Bytes::from_vec(post.commit.clone()), bytes_list(&post.nodes), Bytes::from_vec(post.record.clone()), post.rkey.clone(),
                Bytes::from_vec(post.commit.clone()), bytes_list(&post.nodes), Bytes::from_vec(post.record.clone()), post.rkey.clone()
            ])
            .put_last_instruction_output_on_workspace("paid")
            .call_method(claimant.account, "deposit", args![Workspace("paid")])
            .build_and_seal(&claimant.key);
        if expect_ok { test.execute_expect_success(tx, vec![claimant.badge.clone()]); } else { test.execute_expect_failure(tx, vec![claimant.badge.clone()]); }
    };
    // a post with the code but without the hashtag: refused
    claim(&mut test, &acct.post(&code, "3jaaaaaaaaaaa"), false);
    // one post carrying both the code and the hashtag: pays (the same post proves both)
    let before = test.call_method::<Amount>(claimant.account, "balance", args![TARI_TOKEN], vec![]);
    claim(&mut test, &acct.post(&format!("Hyped for #OotleLaunch {code}"), "3jbbbbbbbbbbb"), true);
    assert_eq!(test.call_method::<Amount>(claimant.account, "balance", args![TARI_TOKEN], vec![]), before + Amount::from(2_000u64));
}
