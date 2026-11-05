//! Browser build of `atp-verify`: the same Rust the Ootle contracts link, behind a tiny C ABI, so a web page can
//! run the very checks a contract runs. Inputs are length-prefixed frames (u32 LE length, then bytes); outputs are
//! JSON. No wasm-bindgen: three exports and a few KB of glue.

use atp_verify::{Alg, Error, Key};

fn frames(input: &[u8]) -> Option<Vec<&[u8]>> {
    let mut out = Vec::new();
    let mut rest = input;
    while !rest.is_empty() {
        if rest.len() < 4 {
            return None;
        }
        let n = u32::from_le_bytes(rest[..4].try_into().ok()?) as usize;
        rest = &rest[4..];
        if rest.len() < n {
            return None;
        }
        out.push(&rest[..n]);
        rest = &rest[n..];
    }
    Some(out)
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn json_str(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

fn fail(stage: &str, e: &Error) -> String {
    format!("{{\"ok\":false,\"stage\":{},\"error\":{}}}", json_str(stage), json_str(&format!("{e:?}")))
}

/// frames: did, op, op, ...
fn chain(f: &[&[u8]]) -> String {
    if f.len() < 2 {
        return fail("input", &Error::BadOp);
    }
    let Ok(did) = core::str::from_utf8(f[0]) else { return fail("input", &Error::BadDid) };
    match atp_verify::verify_plc_chain(did, &f[1..]) {
        Err(e) => fail("chain", &e),
        Ok(info) => {
            let (alg, key) = (if info.signing_key.alg == Alg::K256 { "k256" } else { "p256" }, hex(&info.signing_key.bytes));
            let handles = atp_verify::also_known_as(f[f.len() - 1]).unwrap_or_default();
            let hs: Vec<String> = handles.iter().map(|h| json_str(h)).collect();
            format!(
                "{{\"ok\":true,\"len\":{},\"alg\":\"{alg}\",\"key\":\"{key}\",\"tip\":\"{}\",\"handles\":[{}]}}",
                info.len,
                hex(&info.tip),
                hs.join(",")
            )
        },
    }
}

/// frames: did, alg (1 byte, 0 = k256), key (33 bytes), commit, collection, rkey, record, node, node, ...
fn record(f: &[&[u8]]) -> String {
    if f.len() < 7 || f[1].len() != 1 || f[2].len() != 33 {
        return fail("input", &Error::BadProof);
    }
    let (Ok(did), Ok(collection), Ok(rkey)) = (core::str::from_utf8(f[0]), core::str::from_utf8(f[4]), core::str::from_utf8(f[5])) else {
        return fail("input", &Error::BadProof);
    };
    let mut bytes = [0u8; 33];
    bytes.copy_from_slice(f[2]);
    let key = Key { alg: if f[1][0] == 0 { Alg::K256 } else { Alg::P256 }, bytes };
    let root = match atp_verify::verify_commit(did, &key, f[3]) {
        Ok(r) => r,
        Err(e) => return fail("commit", &e),
    };
    if let Err(e) = atp_verify::verify_in_root(&root, &f[7..], f[6], collection, rkey) {
        return fail("path", &e);
    }
    let rev = atp_verify::commit_rev_micros(f[3]).unwrap_or(0);
    let ty = atp_verify::record_type(f[6]).unwrap_or("");
    format!("{{\"ok\":true,\"root\":\"{}\",\"rev\":{rev},\"type\":{}}}", hex(&root), json_str(ty))
}

/// frames: record, path segment, path segment, ... Returns the string at that path, the way a contract reads it.
fn field(f: &[&[u8]]) -> String {
    if f.len() < 2 {
        return fail("input", &Error::BadProof);
    }
    let mut path = Vec::with_capacity(f.len() - 1);
    for p in &f[1..] {
        let Ok(s) = core::str::from_utf8(p) else { return fail("input", &Error::BadProof) };
        path.push(s);
    }
    match atp_verify::field_str(f[0], &path) {
        Ok(v) => format!("{{\"ok\":true,\"value\":{}}}", json_str(v)),
        Err(e) => fail("field", &e),
    }
}

static mut OUT: Vec<u8> = Vec::new();

#[unsafe(no_mangle)]
pub extern "C" fn alloc(n: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(n);
    let p = v.as_mut_ptr();
    core::mem::forget(v);
    p
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn dealloc(p: *mut u8, n: usize) {
    drop(unsafe { Vec::from_raw_parts(p, 0, n) });
}

/// Runs function `which` (0 chain, 1 record, 2 field) over the frames at `p`/`n`; returns the output's address.
/// The output length is then read with `out_len`.
#[unsafe(no_mangle)]
#[allow(static_mut_refs)]
pub unsafe extern "C" fn call(which: u32, p: *const u8, n: usize) -> *const u8 {
    let input = unsafe { core::slice::from_raw_parts(p, n) };
    let result = match frames(input) {
        None => fail("input", &Error::BadProof),
        Some(f) => match which {
            0 => chain(&f),
            1 => record(&f),
            2 => field(&f),
            _ => fail("input", &Error::BadProof),
        },
    };
    unsafe {
        OUT = result.into_bytes();
        OUT.as_ptr()
    }
}

#[unsafe(no_mangle)]
#[allow(static_mut_refs)]
pub extern "C" fn out_len() -> usize {
    unsafe { OUT.len() }
}
