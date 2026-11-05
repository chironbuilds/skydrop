//   SPDX-License-Identifier: BSD-3-Clause
//! atproto **service-auth JWT** verification. A service-auth token is a compact JWT
//! `base64url(header).base64url(payload).base64url(sig)` signed by the account's repo signing key — the
//! same key this crate derives from the PLC chain — so it is fully trustless: a contract that has run
//! [`crate::verify_plc_chain`] can verify a token the account issued without any oracle.
//!
//! The signature is checked over the ASCII `header.payload` with the known key, so the header's `alg` is
//! not trusted (a mismatched curve simply fails verification — no alg-confusion surface). Only the payload
//! claims are parsed, with a deliberately small JSON reader that rejects duplicate keys so a token cannot
//! smuggle a second `aud`/`iss`/`exp` past the check.
//!
//! Expiry is returned, not enforced: WASM has no clock, so the calling contract compares `exp` to its own
//! epoch/time.

use alloc::{string::String, vec::Vec};

use crate::{Error, Key, enc};

/// The verified claims of a service-auth token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceAuth {
    /// Issuer DID (the account that signed the token).
    pub iss: String,
    /// Audience — the service DID the token is addressed to.
    pub aud: String,
    /// Expiry, seconds since the Unix epoch.
    pub exp: u64,
    /// Lexicon method (NSID) the token authorises, if present.
    pub lxm: Option<String>,
}

/// Verifies a compact service-auth JWT signed by `key`. Checks the signature over `header.payload`, then
/// parses and returns the payload claims. Does NOT check `exp` against a clock (the caller does).
pub fn verify_service_auth(token: &str, key: &Key) -> Result<ServiceAuth, Error> {
    let bytes = token.as_bytes();
    // Exactly two dots, three non-empty parts.
    let d1 = find_dot(bytes, 0).ok_or(Error::BadProof)?;
    let d2 = find_dot(bytes, d1 + 1).ok_or(Error::BadProof)?;
    if find_dot(bytes, d2 + 1).is_some() {
        return Err(Error::BadProof);
    }
    let header = &token[..d1];
    let payload_b64 = &token[d1 + 1..d2];
    let sig_b64 = &token[d2 + 1..];
    if header.is_empty() || payload_b64.is_empty() || sig_b64.is_empty() {
        return Err(Error::BadProof);
    }

    // Signing input is the exact ASCII "header.payload"; the signature covers it with the account's key.
    let signing_input = &bytes[..d2];
    let sig = enc::base64url_decode(sig_b64).ok_or(Error::BadSignature)?;
    if sig.len() != 64 || !key.verify(signing_input, &sig) {
        return Err(Error::BadSignature);
    }

    let payload = enc::base64url_decode(payload_b64).ok_or(Error::Cbor)?;
    let fields = parse_object(&payload)?;
    Ok(ServiceAuth {
        iss: take_str(&fields, "iss")?,
        aud: take_str(&fields, "aud")?,
        exp: take_num(&fields, "exp")?,
        lxm: match take_str(&fields, "lxm") {
            Ok(s) => Some(s),
            Err(Error::NotFound) => None,
            Err(e) => return Err(e),
        },
    })
}

fn find_dot(b: &[u8], from: usize) -> Option<usize> {
    (from..b.len()).find(|&i| b[i] == b'.')
}

// ---- minimal JSON object reader --------------------------------------------------------------------
// Reads a flat JSON object's top-level members. String and unsigned-integer values are kept; objects,
// arrays, booleans and null are skipped. Duplicate keys are an error so a claim cannot be shadowed.

enum Val {
    Str(String),
    Num(u64),
}

fn take_str(fields: &[(String, Val)], key: &str) -> Result<String, Error> {
    let mut found = None;
    for (k, v) in fields {
        if k == key {
            if found.is_some() {
                return Err(Error::BadProof); // duplicate key
            }
            match v {
                Val::Str(s) => found = Some(s.clone()),
                Val::Num(_) => return Err(Error::BadProof),
            }
        }
    }
    found.ok_or(Error::NotFound)
}

fn take_num(fields: &[(String, Val)], key: &str) -> Result<u64, Error> {
    let mut found = None;
    for (k, v) in fields {
        if k == key {
            if found.is_some() {
                return Err(Error::BadProof);
            }
            match v {
                Val::Num(n) => found = Some(*n),
                Val::Str(_) => return Err(Error::BadProof),
            }
        }
    }
    found.ok_or(Error::NotFound)
}

struct P<'a> {
    b: &'a [u8],
    i: usize,
}

fn parse_object(b: &[u8]) -> Result<Vec<(String, Val)>, Error> {
    let mut p = P { b, i: 0 };
    p.ws();
    p.expect(b'{')?;
    let mut out: Vec<(String, Val)> = Vec::new();
    p.ws();
    if p.peek() == Some(b'}') {
        p.i += 1;
    } else {
        loop {
            p.ws();
            let key = p.string()?;
            p.ws();
            p.expect(b':')?;
            p.ws();
            match p.value()? {
                Some(v) => out.push((key, v)),
                None => {}, // skipped (object/array/bool/null)
            }
            p.ws();
            match p.next_byte()? {
                b',' => continue,
                b'}' => break,
                _ => return Err(Error::Cbor),
            }
        }
    }
    p.ws();
    if p.i != p.b.len() {
        return Err(Error::Cbor); // trailing garbage
    }
    Ok(out)
}

impl<'a> P<'a> {
    fn peek(&self) -> Option<u8> {
        self.b.get(self.i).copied()
    }

    fn next_byte(&mut self) -> Result<u8, Error> {
        let c = *self.b.get(self.i).ok_or(Error::Cbor)?;
        self.i += 1;
        Ok(c)
    }

    fn expect(&mut self, c: u8) -> Result<(), Error> {
        if self.next_byte()? == c { Ok(()) } else { Err(Error::Cbor) }
    }

    fn ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.i += 1;
        }
    }

    /// Parses a JSON string. Handles the standard two-char escapes; rejects `\u` (our claims are ASCII, so
    /// refusing is the safe choice) and control characters.
    fn string(&mut self) -> Result<String, Error> {
        self.expect(b'"')?;
        let mut s = String::new();
        loop {
            match self.next_byte()? {
                b'"' => return Ok(s),
                b'\\' => match self.next_byte()? {
                    b'"' => s.push('"'),
                    b'\\' => s.push('\\'),
                    b'/' => s.push('/'),
                    b'n' => s.push('\n'),
                    b't' => s.push('\t'),
                    b'r' => s.push('\r'),
                    b'b' => s.push('\u{0008}'),
                    b'f' => s.push('\u{000c}'),
                    _ => return Err(Error::Cbor),
                },
                c if c < 0x20 => return Err(Error::Cbor),
                c if c < 0x80 => s.push(c as char),
                // A UTF-8 continuation/lead byte: collect the whole code point so we never split it.
                c => {
                    let extra = if c >= 0xf0 {
                        3
                    } else if c >= 0xe0 {
                        2
                    } else if c >= 0xc0 {
                        1
                    } else {
                        return Err(Error::Cbor);
                    };
                    let mut buf = Vec::with_capacity(1 + extra);
                    buf.push(c);
                    for _ in 0..extra {
                        buf.push(self.next_byte()?);
                    }
                    let ch = core::str::from_utf8(&buf).map_err(|_| Error::Cbor)?;
                    s.push_str(ch);
                },
            }
        }
    }

    /// Parses a value. Returns the kept value, or `None` for object/array/bool/null (skipped).
    fn value(&mut self) -> Result<Option<Val>, Error> {
        match self.peek().ok_or(Error::Cbor)? {
            b'"' => Ok(Some(Val::Str(self.string()?))),
            b'0'..=b'9' => Ok(Some(Val::Num(self.number()?))),
            b'{' => {
                self.skip_container(b'{', b'}')?;
                Ok(None)
            },
            b'[' => {
                self.skip_container(b'[', b']')?;
                Ok(None)
            },
            b't' => {
                self.lit(b"true")?;
                Ok(None)
            },
            b'f' => {
                self.lit(b"false")?;
                Ok(None)
            },
            b'n' => {
                self.lit(b"null")?;
                Ok(None)
            },
            _ => Err(Error::Cbor), // negative/float/other: not a claim shape we accept
        }
    }

    /// An unsigned integer with no leading zero (except `0` itself) and no fractional/exponent part.
    fn number(&mut self) -> Result<u64, Error> {
        let start = self.i;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.i += 1;
        }
        let digits = &self.b[start..self.i];
        if digits.len() > 1 && digits[0] == b'0' {
            return Err(Error::Cbor);
        }
        // Reject floats/exponents: next char must not continue a number.
        if matches!(self.peek(), Some(b'.' | b'e' | b'E')) {
            return Err(Error::Cbor);
        }
        let mut v: u64 = 0;
        for &d in digits {
            v = v.checked_mul(10).and_then(|x| x.checked_add((d - b'0') as u64)).ok_or(Error::Cbor)?;
        }
        Ok(v)
    }

    fn lit(&mut self, word: &[u8]) -> Result<(), Error> {
        for &w in word {
            if self.next_byte()? != w {
                return Err(Error::Cbor);
            }
        }
        Ok(())
    }

    /// Skips a balanced container, respecting strings so braces inside strings don't miscount. Bounded by
    /// the input length.
    fn skip_container(&mut self, open: u8, close: u8) -> Result<(), Error> {
        self.expect(open)?;
        let mut depth = 1usize;
        while depth > 0 {
            match self.next_byte()? {
                b'"' => {
                    // consume a string body
                    loop {
                        match self.next_byte()? {
                            b'"' => break,
                            b'\\' => {
                                self.next_byte()?;
                            },
                            _ => {},
                        }
                    }
                },
                c if c == open => depth += 1,
                c if c == close => depth -= 1,
                _ => {},
            }
        }
        Ok(())
    }
}
