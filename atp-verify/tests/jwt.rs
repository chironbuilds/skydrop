//   SPDX-License-Identifier: BSD-3-Clause
//! Service-auth JWT verification, signed with a real k256 key (fixed, no RNG).

use atp_verify::{Alg, Error, Key, jwt::verify_service_auth};
use k256::ecdsa::{Signature, SigningKey, signature::Signer};

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

fn key_pair() -> (SigningKey, Key) {
    let sk = SigningKey::from_slice(&[7u8; 32]).unwrap();
    let vk = sk.verifying_key();
    let enc = vk.to_encoded_point(true);
    let mut bytes = [0u8; 33];
    bytes.copy_from_slice(enc.as_bytes());
    (sk, Key { alg: Alg::K256, bytes })
}

fn sign_token(sk: &SigningKey, header: &str, payload: &str) -> String {
    let si = format!("{}.{}", b64url(header.as_bytes()), b64url(payload.as_bytes()));
    let sig: Signature = sk.sign(si.as_bytes());
    format!("{}.{}", si, b64url(&sig.to_bytes()))
}

const HDR: &str = r#"{"typ":"JWT","alg":"ES256K"}"#;

#[test]
fn verifies_and_parses_claims() {
    let (sk, key) = key_pair();
    let payload = r#"{"iss":"did:plc:aaa","aud":"did:web:svc.test","lxm":"com.atproto.repo.createRecord","exp":9999999999}"#;
    let token = sign_token(&sk, HDR, payload);
    let claims = verify_service_auth(&token, &key).unwrap();
    assert_eq!(claims.iss, "did:plc:aaa");
    assert_eq!(claims.aud, "did:web:svc.test");
    assert_eq!(claims.exp, 9999999999);
    assert_eq!(claims.lxm.as_deref(), Some("com.atproto.repo.createRecord"));
}

#[test]
fn lxm_is_optional() {
    let (sk, key) = key_pair();
    let token = sign_token(&sk, HDR, r#"{"iss":"did:plc:aaa","aud":"did:web:svc.test","exp":100}"#);
    let claims = verify_service_auth(&token, &key).unwrap();
    assert_eq!(claims.lxm, None);
    assert_eq!(claims.exp, 100);
}

#[test]
fn tampered_payload_fails_signature() {
    let (sk, key) = key_pair();
    let token = sign_token(&sk, HDR, r#"{"iss":"did:plc:aaa","aud":"did:web:svc.test","exp":100}"#);
    // Flip one byte of the payload segment; signature must no longer verify.
    let mut t: Vec<char> = token.chars().collect();
    let d1 = token.find('.').unwrap();
    t[d1 + 2] = if t[d1 + 2] == 'A' { 'B' } else { 'A' };
    let tampered: String = t.into_iter().collect();
    assert_eq!(verify_service_auth(&tampered, &key), Err(Error::BadSignature));
}

#[test]
fn wrong_key_fails() {
    let (sk, _) = key_pair();
    let other = SigningKey::from_slice(&[9u8; 32]).unwrap();
    let ovk = other.verifying_key();
    let enc = ovk.to_encoded_point(true);
    let mut bytes = [0u8; 33];
    bytes.copy_from_slice(enc.as_bytes());
    let token = sign_token(&sk, HDR, r#"{"iss":"did:plc:aaa","aud":"x","exp":1}"#);
    assert_eq!(verify_service_auth(&token, &Key { alg: Alg::K256, bytes }), Err(Error::BadSignature));
}

#[test]
fn duplicate_aud_is_rejected() {
    // A valid signature over a payload that smuggles a second `aud` must still be refused.
    let (sk, key) = key_pair();
    let token = sign_token(&sk, HDR, r#"{"iss":"did:plc:aaa","aud":"good.test","aud":"evil.test","exp":1}"#);
    assert_eq!(verify_service_auth(&token, &key), Err(Error::BadProof));
}

#[test]
fn skips_nested_and_reads_siblings() {
    let (sk, key) = key_pair();
    // A nested object before the claims must be skipped without confusing the reader.
    let payload = r#"{"cnf":{"jkt":"zzz"},"iss":"did:plc:aaa","aud":"svc","exp":42}"#;
    let claims = verify_service_auth(&token_of(&sk, payload), &key).unwrap();
    assert_eq!(claims.iss, "did:plc:aaa");
    assert_eq!(claims.exp, 42);

    fn token_of(sk: &SigningKey, p: &str) -> String {
        sign_token(sk, HDR, p)
    }
}
