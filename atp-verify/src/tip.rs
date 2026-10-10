//! Reads a tip command out of an authenticated post record.
//!
//! A tip post reads `@bot tip @recipient 5`, where both handles are real mentions (rich-text facets that
//! carry the account's DID, so the recipient cannot be confused with a similarly spelled handle). The
//! amount is in whole tokens with up to six decimals, optionally followed by ` tTARI`.

use alloc::{string::String, vec::Vec};

use crate::{
    cbor::{array_items, map, map_get, text, uint},
    Error,
};

const MENTION: &str = "app.bsky.richtext.facet#mention";
/// Micro-units per whole token.
const UNIT: u64 = 1_000_000;
const MAX_FACETS: usize = 16;

/// (byteStart, byteEnd, did) of every mention in the record.
fn mentions(record: &[u8]) -> Result<Vec<(u64, u64, String)>, Error> {
    let (fs, _) = map_get(record, "facets")?;
    let mut out = Vec::new();
    let items = array_items(record, fs)?;
    if items.len() > MAX_FACETS {
        return Err(Error::BadProof);
    }
    for item in items {
        let (mut start, mut end, mut did) = (None, None, None);
        for e in map(record, item)? {
            let (k, vs, _, _) = e?;
            match k {
                "index" => {
                    for ie in map(record, vs)? {
                        let (ik, ivs, _, _) = ie?;
                        match ik {
                            "byteStart" => start = Some(uint(record, ivs)?.0),
                            "byteEnd" => end = Some(uint(record, ivs)?.0),
                            _ => {},
                        }
                    }
                },
                "features" => {
                    for f in array_items(record, vs)? {
                        let (mut ty, mut d) = (None, None);
                        for fe in map(record, f)? {
                            let (fk, fvs, _, _) = fe?;
                            match fk {
                                "$type" => ty = Some(text(record, fvs)?.0),
                                "did" => d = Some(text(record, fvs)?.0),
                                _ => {},
                            }
                        }
                        if ty == Some(MENTION) {
                            did = d.map(String::from);
                        }
                    }
                },
                _ => {},
            }
        }
        if let (Some(s), Some(e), Some(d)) = (start, end, did) {
            out.push((s, e, d));
        }
    }
    Ok(out)
}

/// Parses `1`, `5.5`, `0.000001` into micro-units. Rejects zero, signs, exponents and extra decimals.
fn parse_amount(s: &str) -> Option<u64> {
    let (whole, frac) = match s.split_once('.') {
        Some((w, f)) => (w, f),
        None => (s, ""),
    };
    if whole.is_empty() || whole.len() > 12 || frac.len() > 6 || (s.contains('.') && frac.is_empty()) {
        return None;
    }
    if !whole.bytes().all(|c| c.is_ascii_digit()) || !frac.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let w: u64 = whole.parse().ok()?;
    let mut f: u64 = if frac.is_empty() { 0 } else { frac.parse().ok()? };
    for _ in frac.len()..6 {
        f *= 10;
    }
    let total = w.checked_mul(UNIT)?.checked_add(f)?;
    (total > 0).then_some(total)
}

/// Returns (recipient DID, amount in micro-units) if the record is exactly `@bot tip @recipient <amount>`.
pub fn parse_tip(record: &[u8], bot_did: &str) -> Result<(String, u64), Error> {
    let post = crate::record_text(record)?;
    let m = mentions(record)?;
    let first = m.iter().find(|(s, _, d)| *s == 0 && d == bot_did).ok_or(Error::BadProof)?;
    let bytes = post.as_bytes();
    if bytes.first() != Some(&b'@') {
        return Err(Error::BadProof);
    }
    let after_bot = usize::try_from(first.1).map_err(|_| Error::BadProof)?;
    const TIP: &[u8] = b" tip ";
    if bytes.get(after_bot..after_bot + TIP.len()) != Some(TIP) {
        return Err(Error::BadProof);
    }
    let rstart = (after_bot + TIP.len()) as u64;
    let recipient = m.iter().find(|(s, _, _)| *s == rstart).ok_or(Error::BadProof)?;
    let rend = usize::try_from(recipient.1).map_err(|_| Error::BadProof)?;
    if bytes.get(rend) != Some(&b' ') || rend + 1 >= bytes.len() {
        return Err(Error::BadProof);
    }
    let rest = core::str::from_utf8(&bytes[rend + 1..]).map_err(|_| Error::BadProof)?;
    let amount_str = rest.strip_suffix(" tTARI").unwrap_or(rest);
    let amount = parse_amount(amount_str).ok_or(Error::BadProof)?;
    if !recipient.2.starts_with("did:plc:") || recipient.2 == bot_did {
        return Err(Error::BadProof);
    }
    Ok((recipient.2.clone(), amount))
}

#[cfg(test)]
mod tests {
    use super::parse_amount;

    #[test]
    fn amounts() {
        assert_eq!(parse_amount("5"), Some(5_000_000));
        assert_eq!(parse_amount("0.5"), Some(500_000));
        assert_eq!(parse_amount("0.000001"), Some(1));
        assert_eq!(parse_amount("12.34"), Some(12_340_000));
        for bad in ["", "0", "0.0", ".5", "5.", "-1", "1e3", "1.2345678", "1 2", "٣", "+1"] {
            assert_eq!(parse_amount(bad), None, "{bad}");
        }
    }
}
