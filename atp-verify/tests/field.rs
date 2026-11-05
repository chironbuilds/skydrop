//   SPDX-License-Identifier: BSD-3-Clause
//! Generic record/field-proof readers over hand-built canonical DAG-CBOR.

use atp_verify::{field_contains, field_eq, field_present, field_str, field_u64, record_text, record_type};

// ---- minimal canonical DAG-CBOR builder (small values only: heads are one byte) --------------------

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

fn tuint(n: u64) -> Vec<u8> {
    let mut v = Vec::new();
    head(0, n, &mut v);
    v
}

/// Entries MUST be given in canonical order (shorter key first, then bytewise).
fn tmap(entries: &[(&str, Vec<u8>)]) -> Vec<u8> {
    let mut v = Vec::new();
    head(5, entries.len() as u64, &mut v);
    for (k, val) in entries {
        v.extend(tstr(k));
        v.extend_from_slice(val);
    }
    v
}

fn post() -> Vec<u8> {
    // { "text": "gm tari-claim:abc", "$type": "app.bsky.feed.post",
    //   "reply": { "root": { "uri": "at://x" } } }
    // Canonical key order by (len, bytes): "text"(4) < "$type"(5) < "reply"(5)  — '$'(0x24) < 'r'(0x72).
    let reply = tmap(&[("root", tmap(&[("uri", tstr("at://x"))]))]);
    tmap(&[
        ("text", tstr("gm tari-claim:abc")),
        ("$type", tstr("app.bsky.feed.post")),
        ("reply", reply),
    ])
}

#[test]
fn reads_top_level_and_type() {
    let r = post();
    assert_eq!(record_type(&r).unwrap(), "app.bsky.feed.post");
    assert_eq!(record_text(&r).unwrap(), "gm tari-claim:abc");
    assert_eq!(field_str(&r, &["text"]).unwrap(), "gm tari-claim:abc");
}

#[test]
fn reads_nested_path() {
    let r = post();
    assert_eq!(field_str(&r, &["reply", "root", "uri"]).unwrap(), "at://x");
    assert!(field_present(&r, &["reply", "root", "uri"]));
    assert!(!field_present(&r, &["reply", "root", "cid"]));
    assert!(!field_present(&r, &["nope"]));
}

#[test]
fn eq_and_contains() {
    let r = post();
    assert!(field_eq(&r, &["$type"], "app.bsky.feed.post"));
    assert!(!field_eq(&r, &["$type"], "app.bsky.feed.like"));
    assert!(field_contains(&r, &["text"], "tari-claim:abc"));
    assert!(!field_contains(&r, &["text"], "tari-bind:"));
    // Missing / wrong-typed fields are false, never panic.
    assert!(!field_eq(&r, &["missing"], "x"));
    assert!(!field_contains(&r, &["reply"], "x"));
}

#[test]
fn reads_uint() {
    // app.bsky.feed.like-ish: { "n": 7, "$type": "x" }  ("n"(1) < "$type"(5))
    let r = tmap(&[("n", tuint(7)), ("$type", tstr("x"))]);
    assert_eq!(field_u64(&r, &["n"]).unwrap(), 7);
    assert!(field_u64(&r, &["$type"]).is_err()); // text, not uint
}
