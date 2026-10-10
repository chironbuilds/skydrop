//! Small text encodings atproto uses: base32 (CIDs, did:plc), base64url (plc signatures), base58btc (did:key).

use alloc::{string::String, vec::Vec};

const B32: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";

/// RFC 4648 base32, lower case, no padding.
pub fn base32_lower(data: &[u8]) -> String {
    let mut out = String::new();
    let mut acc: u32 = 0;
    let mut bits = 0;
    for &byte in data {
        acc = (acc << 8) | u32::from(byte);
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

/// base64url without padding.
pub fn base64url_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits = 0;
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            _ => return None,
        };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

const B58: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

pub fn base58btc_decode(s: &str) -> Option<Vec<u8>> {
    let mut out: Vec<u8> = Vec::new();
    for c in s.bytes() {
        let mut carry = B58.iter().position(|&x| x == c)? as u32;
        for b in out.iter_mut() {
            carry += u32::from(*b) * 58;
            *b = (carry & 0xff) as u8;
            carry >>= 8;
        }
        while carry > 0 {
            out.push((carry & 0xff) as u8);
            carry >>= 8;
        }
    }
    for c in s.bytes() {
        if c == b'1' {
            out.push(0);
        } else {
            break;
        }
    }
    out.reverse();
    Some(out)
}
