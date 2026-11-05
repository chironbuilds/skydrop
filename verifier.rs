//   SPDX-License-Identifier: BSD-3-Clause
//! Engine tests for the reusable Verifier component (the bsky identity layer for Ootle). The atproto
//! crypto is exercised exhaustively in the atp-verify crate's own tests; here we confirm the component
//! ABI — pure field reads, DID->handle assertion, and service-auth JWT verification with a real k256 key.

use k256::ecdsa::{Signature, SigningKey, signature::Signer as _};
use tari_ootle_common_types::substate_type::SubstateType;
use tari_ootle_transaction::args;
use tari_template_lib::types::{ComponentAddress, bytes::Bytes};
use tari_template_test_tooling::TemplateTest;

const CRATE_PATH: &str = env!("CARGO_MANIFEST_DIR");
const VERIFIER: &str = "tests/templates/verifier";

// ---- minimal canonical DAG-CBOR builder (small values only) ----------------------------------------

fn head(major: u8, n: u64, out: &mut Vec<u8>) {
    assert!(n < 24);
    out.push((major << 5) | n as u8);
}
fn tstr(s: &str) -> Vec<u8> {
    let mut v = Vec::new();
    head(3, s.len() as u64, &mut v);
    v.extend_from_slice(s.as_bytes());
    v
}
fn tarr(items: &[Vec<u8>]) -> Vec<u8> {
    let mut v = Vec::new();
    head(4, items.len() as u64, &mut v);
    for i in items {
        v.extend_from_slice(i);
    }
    v
}
fn tmap(entries: &[(&str, Vec<u8>)]) -> Vec<u8> {
    let mut v = Vec::new();
    head(5, entries.len() as u64, &mut v);
    for (k, val) in entries {
        v.extend(tstr(k));
        v.extend_from_slice(val);
    }
    v
}

// ---- base64url + k256 JWT signing (fixed key, no RNG) ----------------------------------------------

const B64: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
fn b64url(d: &[u8]) -> String {
    let mut s = String::new();
    for chunk in d.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | (b[2] as u32);
        let q = [(n >> 18) & 63, (n >> 12) & 63, (n >> 6) & 63, n & 63];
        for i in 0..chunk.len() + 1 {
            s.push(B64[q[i] as usize] as char);
        }
    }
    s
}

fn deploy() -> (TemplateTest, ComponentAddress) {
    let mut test = TemplateTest::new(CRATE_PATH, [VERIFIER]);
    let template = test.get_template_address("Verifier");
    let (_acct, badge, key) = test.create_funded_account();
    let tx = test.transaction().call_function(template, "new", args![]).build_and_seal(&key);
    test.execute_expect_success(tx, vec![badge]);
    let component = test.get_previous_output_address(SubstateType::Component).as_component_address().unwrap();
    (test, component)
}

fn post() -> Vec<u8> {
    // { "text": "...", "$type": "app.bsky.feed.post", "reply": { "root": { "uri": "at://x" } } }
    let reply = tmap(&[("root", tmap(&[("uri", tstr("at://x"))]))]);
    tmap(&[
        ("text", tstr("hello tari-claim:9f")),
        ("$type", tstr("app.bsky.feed.post")),
        ("reply", reply),
    ])
}

#[test]
fn reads_record_fields_over_abi() {
    let (mut test, c) = deploy();
    let rec = Bytes::from_vec(post());
    let text: String = test.call_method(c, "record_field_text", args![rec.clone(), vec!["text".to_string()]], vec![]);
    assert_eq!(text, "hello tari-claim:9f");
    let uri: String = test.call_method(
        c,
        "record_field_text",
        args![rec.clone(), vec!["reply".to_string(), "root".to_string(), "uri".to_string()]],
        vec![],
    );
    assert_eq!(uri, "at://x");
    let ty: String = test.call_method(c, "record_type", args![rec.clone()], vec![]);
    assert_eq!(ty, "app.bsky.feed.post");
    // Absent field -> empty string, never an abort.
    let missing: String = test.call_method(c, "record_field_text", args![rec, vec!["nope".to_string()]], vec![]);
    assert_eq!(missing, "");
}

#[test]
fn asserts_handle_over_abi() {
    let (mut test, c) = deploy();
    let op = Bytes::from_vec(tmap(&[
        ("type", tstr("plc_operation")),
        ("alsoKnownAs", tarr(&[tstr("at://alice.test")])),
    ]));
    assert!(test.call_method::<bool>(c, "asserts_handle", args![op.clone(), "alice.test".to_string()], vec![]));
    assert!(!test.call_method::<bool>(c, "asserts_handle", args![op, "mallory.test".to_string()], vec![]));
}

#[test]
fn verifies_service_auth_over_abi() {
    let (mut test, c) = deploy();
    let sk = SigningKey::from_slice(&[7u8; 32]).unwrap();
    let key = {
        let enc = sk.verifying_key().to_encoded_point(true);
        Bytes::from_vec(enc.as_bytes().to_vec())
    };
    let header = b64url(br#"{"typ":"JWT","alg":"ES256K"}"#);
    let payload = b64url(br#"{"iss":"did:plc:aaa","aud":"did:web:svc.test","lxm":"com.atproto.repo.createRecord","exp":9999999999}"#);
    let si = format!("{header}.{payload}");
    let sig: Signature = sk.sign(si.as_bytes());
    let token = format!("{si}.{}", b64url(&sig.to_bytes()));

    let (iss, aud, exp, lxm): (String, String, u64, String) =
        test.call_method(c, "verify_service_auth", args![token, key, 0u8], vec![]);
    assert_eq!(iss, "did:plc:aaa");
    assert_eq!(aud, "did:web:svc.test");
    assert_eq!(exp, 9999999999u64);
    assert_eq!(lxm, "com.atproto.repo.createRecord");
}
