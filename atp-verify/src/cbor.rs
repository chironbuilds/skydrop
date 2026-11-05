//! Just enough DAG-CBOR reading to verify atproto data. It works on byte ranges, so a signed block can be
//! turned into the unsigned form that was signed without re-encoding anything.

use alloc::vec::Vec;

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    Malformed,
    Missing,
    Unsupported,
}

pub type Res<T> = Result<T, Error>;

/// Deepest nesting we are willing to skip through.
const MAX_DEPTH: usize = 16;

/// Reads a CBOR head. Returns (major type, argument, position after the head).
pub fn head(b: &[u8], pos: usize) -> Res<(u8, u64, usize)> {
    let first = *b.get(pos).ok_or(Error::Malformed)?;
    let major = first >> 5;
    let info = first & 0x1f;
    let mut p = pos + 1;
    let arg = match info {
        0..=23 => u64::from(info),
        24..=27 => {
            let n = 1usize << (info - 24);
            let bytes = b.get(p..p + n).ok_or(Error::Malformed)?;
            p += n;
            bytes.iter().fold(0u64, |a, x| (a << 8) | u64::from(*x))
        },
        _ => return Err(Error::Unsupported),
    };
    Ok((major, arg, p))
}

/// Returns the position just after the item starting at `pos`.
pub fn skip(b: &[u8], pos: usize) -> Res<usize> {
    skip_depth(b, pos, 0)
}

fn skip_depth(b: &[u8], pos: usize, depth: usize) -> Res<usize> {
    if depth > MAX_DEPTH {
        return Err(Error::Unsupported);
    }
    let (major, arg, mut p) = head(b, pos)?;
    match major {
        0 | 1 | 7 => Ok(p),
        2 | 3 => {
            let len = usize::try_from(arg).map_err(|_| Error::Malformed)?;
            let end = p.checked_add(len).ok_or(Error::Malformed)?;
            if end > b.len() {
                return Err(Error::Malformed);
            }
            Ok(end)
        },
        4 => {
            for _ in 0..arg {
                p = skip_depth(b, p, depth + 1)?;
            }
            Ok(p)
        },
        5 => {
            for _ in 0..arg {
                p = skip_depth(b, p, depth + 1)?;
                p = skip_depth(b, p, depth + 1)?;
            }
            Ok(p)
        },
        6 => skip_depth(b, p, depth + 1),
        _ => Err(Error::Unsupported),
    }
}

fn span(b: &[u8], p: usize, arg: u64) -> Res<(&[u8], usize)> {
    let len = usize::try_from(arg).map_err(|_| Error::Malformed)?;
    let end = p.checked_add(len).ok_or(Error::Malformed)?;
    Ok((b.get(p..end).ok_or(Error::Malformed)?, end))
}

pub fn text(b: &[u8], pos: usize) -> Res<(&str, usize)> {
    let (major, arg, p) = head(b, pos)?;
    if major != 3 {
        return Err(Error::Malformed);
    }
    let (s, end) = span(b, p, arg)?;
    Ok((core::str::from_utf8(s).map_err(|_| Error::Malformed)?, end))
}

pub fn bytes(b: &[u8], pos: usize) -> Res<(&[u8], usize)> {
    let (major, arg, p) = head(b, pos)?;
    if major != 2 {
        return Err(Error::Malformed);
    }
    span(b, p, arg)
}

pub fn uint(b: &[u8], pos: usize) -> Res<(u64, usize)> {
    let (major, arg, p) = head(b, pos)?;
    if major != 0 {
        return Err(Error::Malformed);
    }
    Ok((arg, p))
}

/// An IPLD link (tag 42). Returns the 32-byte sha2-256 digest of a CIDv1 dag-cbor link.
pub fn link_digest(b: &[u8], pos: usize) -> Res<([u8; 32], usize)> {
    let (major, arg, p) = head(b, pos)?;
    if major != 6 || arg != 42 {
        return Err(Error::Malformed);
    }
    let (raw, end) = bytes(b, p)?;
    // 0x00 identity multibase prefix, then CIDv1 (0x01), dag-cbor (0x71), sha2-256 (0x12), length 32.
    if raw.len() != 37 || raw[..5] != [0x00, 0x01, 0x71, 0x12, 0x20] {
        return Err(Error::Unsupported);
    }
    let mut d = [0u8; 32];
    d.copy_from_slice(&raw[5..]);
    Ok((d, end))
}

pub fn is_null(b: &[u8], pos: usize) -> bool {
    b.get(pos) == Some(&0xf6)
}

/// Iterates a map's entries. Keys must be text.
pub struct MapIter<'a> {
    b: &'a [u8],
    pos: usize,
    left: u64,
}

pub fn map(b: &[u8], pos: usize) -> Res<MapIter<'_>> {
    let (major, arg, p) = head(b, pos)?;
    if major != 5 {
        return Err(Error::Malformed);
    }
    Ok(MapIter { b, pos: p, left: arg })
}

impl<'a> Iterator for MapIter<'a> {
    /// (key, value start, value end, entry start)
    type Item = Res<(&'a str, usize, usize, usize)>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.left == 0 {
            return None;
        }
        self.left -= 1;
        let entry_start = self.pos;
        let r = (|| {
            let (k, vp) = text(self.b, self.pos)?;
            let ve = skip(self.b, vp)?;
            self.pos = ve;
            Ok((k, vp, ve, entry_start))
        })();
        if r.is_err() {
            self.left = 0;
        }
        Some(r)
    }
}

/// Iterates an array's items, yielding each item's start position.
pub fn array_items(b: &[u8], pos: usize) -> Res<Vec<usize>> {
    let (major, arg, mut p) = head(b, pos)?;
    if major != 4 {
        return Err(Error::Malformed);
    }
    let mut out = Vec::new();
    for _ in 0..arg {
        out.push(p);
        p = skip(b, p)?;
    }
    Ok(out)
}

/// Finds `key` in the top-level map at position 0. Returns (value start, value end).
pub fn map_get(b: &[u8], key: &str) -> Res<(usize, usize)> {
    for e in map(b, 0)? {
        let (k, vs, ve, _) = e?;
        if k == key {
            return Ok((vs, ve));
        }
    }
    Err(Error::Missing)
}

/// Returns the top-level map with `key` removed, which is the unsigned form of a signed block, along with
/// the removed value's range. The block must be a single item with fewer than 24 entries.
pub fn strip_key(b: &[u8], key: &str) -> Res<(Vec<u8>, (usize, usize))> {
    let (major, count, hp) = head(b, 0)?;
    if major != 5 || count == 0 || count >= 24 || hp != 1 {
        return Err(Error::Unsupported);
    }
    if skip(b, 0)? != b.len() {
        return Err(Error::Malformed);
    }
    let mut out = Vec::with_capacity(b.len());
    out.push(0xa0 | (count as u8 - 1));
    let mut removed = None;
    for e in map(b, 0)? {
        let (k, vs, ve, es) = e?;
        if k == key {
            removed = Some((vs, ve));
        } else {
            out.extend_from_slice(&b[es..ve]);
        }
    }
    Ok((out, removed.ok_or(Error::Missing)?))
}

pub fn text_field<'a>(b: &'a [u8], key: &str) -> Res<&'a str> {
    let (vs, _) = map_get(b, key)?;
    Ok(text(b, vs)?.0)
}

/// Navigates nested maps following `path` from the top-level map, returning the final value's
/// (start, end). Every element except the last must name a map-valued field. An empty path denotes
/// the top-level map itself.
pub fn path_get(b: &[u8], path: &[&str]) -> Res<(usize, usize)> {
    let mut range = (0usize, b.len());
    let mut pos = 0usize;
    for key in path {
        let mut found = None;
        for e in map(b, pos)? {
            let (k, vs, ve, _) = e?;
            if k == *key {
                found = Some((vs, ve));
                break;
            }
        }
        range = found.ok_or(Error::Missing)?;
        pos = range.0;
    }
    Ok(range)
}
