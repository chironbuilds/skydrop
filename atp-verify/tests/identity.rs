//   SPDX-License-Identifier: BSD-3-Clause
//! DID->handle (alsoKnownAs) extraction, the trustless direction of handle verification.

use atp_verify::{also_known_as, chain_asserts_handle};

fn head(major: u8, n: u64, out: &mut Vec<u8>) {
    assert!(n < 24, "test builder only emits one-byte heads");
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

#[test]
fn modern_op_also_known_as_strips_at_uri() {
    // canonical key order: "type"(4) < "alsoKnownAs"(11)
    let op = tmap(&[
        ("type", tstr("plc_operation")),
        ("alsoKnownAs", tarr(&[tstr("at://alice.test"), tstr("at://a.example")])),
    ]);
    assert_eq!(also_known_as(&op).unwrap(), vec!["alice.test", "a.example"]);
    assert!(chain_asserts_handle(&op, "alice.test"));
    assert!(chain_asserts_handle(&op, "a.example"));
    assert!(!chain_asserts_handle(&op, "mallory.test"));
}

#[test]
fn legacy_create_uses_bare_handle() {
    // canonical: "type"(4) < "handle"(6)
    let op = tmap(&[("type", tstr("create")), ("handle", tstr("old.test"))]);
    assert_eq!(also_known_as(&op).unwrap(), vec!["old.test"]);
    assert!(chain_asserts_handle(&op, "old.test"));
}

#[test]
fn missing_handle_is_not_asserted() {
    let op = tmap(&[("type", tstr("plc_operation")), ("alsoKnownAs", tarr(&[]))]);
    assert_eq!(also_known_as(&op).unwrap(), Vec::<String>::new());
    assert!(!chain_asserts_handle(&op, "anything.test"));
}
