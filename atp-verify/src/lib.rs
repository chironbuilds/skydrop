//! Verifies, with no trusted third party, that a Bluesky (atproto) account created a given record.
//!
//! The chain of trust:
//!  1. A `did:plc:` identifier is the hash of the account's signed genesis operation, so the DID itself
//!     commits to the first operation.
//!  2. Every later operation is signed by one of the previous operation's rotation keys, so walking the
//!     operation log from genesis yields the account's current repo signing key.
//!  3. The repo commit is signed by that key and commits to the root of a Merkle search tree.
//!  4. The tree path from the root to the record key authenticates the record's bytes.
//!
//! What this cannot prove is that the operation log is *complete*: a later rotation could exist that the
//! prover left out. Callers handle that with a challenge window (see `chain_tip`).

#![no_std]
extern crate alloc;

pub mod cbor;
pub mod enc;
pub mod jwt;
pub mod tip;

use alloc::{collections::BTreeMap, string::String, vec::Vec};

use cbor::Error as CborError;
use sha2::{Digest, Sha256};

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    Cbor,
    BadDid,
    BadOp,
    BadKey,
    BadSignature,
    BrokenChain,
    BadCommit,
    NotFound,
    BadProof,
}

impl From<CborError> for Error {
    fn from(_: CborError) -> Self {
        Error::Cbor
    }
}

pub fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Alg {
    K256,
    P256,
}

/// A compressed SEC1 public key and its curve.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Key {
    pub alg: Alg,
    pub bytes: [u8; 33],
}

impl Key {
    /// Parses a `did:key:z…` string.
    pub fn from_did_key(s: &str) -> Result<Self, Error> {
        let rest = s.strip_prefix("did:key:z").ok_or(Error::BadKey)?;
        let raw = enc::base58btc_decode(rest).ok_or(Error::BadKey)?;
        if raw.len() != 35 {
            return Err(Error::BadKey);
        }
        let alg = match raw[..2] {
            [0xe7, 0x01] => Alg::K256,
            [0x80, 0x24] => Alg::P256,
            _ => return Err(Error::BadKey),
        };
        let mut bytes = [0u8; 33];
        bytes.copy_from_slice(&raw[2..]);
        Ok(Key { alg, bytes })
    }

    /// Verifies an ECDSA signature (64-byte compact, low-S) over SHA-256 of `msg`.
    pub fn verify(&self, msg: &[u8], sig: &[u8]) -> bool {
        match self.alg {
            Alg::K256 => {
                use k256::ecdsa::{Signature, VerifyingKey, signature::Verifier};
                let Ok(vk) = VerifyingKey::from_sec1_bytes(&self.bytes) else { return false };
                let Ok(sig) = Signature::from_slice(sig) else { return false };
                sig.normalize_s().is_none() && vk.verify(msg, &sig).is_ok()
            },
            Alg::P256 => {
                use p256::ecdsa::{Signature, VerifyingKey, signature::Verifier};
                let Ok(vk) = VerifyingKey::from_sec1_bytes(&self.bytes) else { return false };
                let Ok(sig) = Signature::from_slice(sig) else { return false };
                sig.normalize_s().is_none() && vk.verify(msg, &sig).is_ok()
            },
        }
    }
}

/// CID string of a dag-cbor block as plc operations reference their predecessor: `b` + base32(cidv1).
fn cid_string(block: &[u8]) -> String {
    let mut cid = Vec::with_capacity(36);
    cid.extend_from_slice(&[0x01, 0x71, 0x12, 0x20]);
    cid.extend_from_slice(&sha256(block));
    let mut s = String::from("b");
    s.push_str(&enc::base32_lower(&cid));
    s
}

pub struct ChainInfo {
    /// The repo signing key (`verificationMethods.atproto`) after the last operation.
    pub signing_key: Key,
    /// Identifies the last operation by what its signature covers. The `sig` field itself isn't covered, so a hash of
    /// the whole block would let anyone make a "different" chain by re-encoding it. Only a key holder can change this.
    pub tip: [u8; 32],
    pub len: u32,
    /// The same hash for every operation, genesis first.
    pub hashes: Vec<[u8; 32]>,
    /// Which of the previous operation's rotation keys signed each operation: 0 is the highest priority. Genesis has 0.
    pub signers: Vec<u8>,
}

impl ChainInfo {
    /// Whether this chain carries on from the one already seen: at least as long, and holding its last operation at the
    /// same place. Length alone isn't enough, because anyone holding a rotated-away rotation key can sign a longer fork.
    pub fn extends(&self, seen_len: u32, seen_tip: &[u8]) -> bool {
        if seen_len == 0 {
            return true;
        }
        self.len >= seen_len && self.hashes.get(seen_len as usize - 1).is_some_and(|h| h.as_slice() == seen_tip)
    }

    /// Whether this chain beats `seen` where the two split, by being signed there with a higher-priority rotation key.
    /// It's the rule PLC uses to let a recovery key undo a lower key's operation. False if neither split from the other.
    pub fn overrides(&self, seen: &ChainInfo) -> bool {
        let split = self.hashes.iter().zip(&seen.hashes).position(|(a, b)| a != b);
        split.is_some_and(|k| self.signers[k] < seen.signers[k])
    }
}

fn rotation_keys(op: &[u8]) -> Result<Vec<Key>, Error> {
    if cbor::text_field(op, "type")? == "create" {
        // Legacy genesis: the signing key and the recovery key may both authorise the next operation. PLC ranks recovery first.
        let (s, _) = cbor::map_get(op, "signingKey")?;
        let (r, _) = cbor::map_get(op, "recoveryKey")?;
        return Ok(alloc::vec![Key::from_did_key(cbor::text(op, r)?.0)?, Key::from_did_key(cbor::text(op, s)?.0)?]);
    }
    let (vs, _) = cbor::map_get(op, "rotationKeys")?;
    let mut keys = Vec::new();
    for item in cbor::array_items(op, vs)? {
        keys.push(Key::from_did_key(cbor::text(op, item)?.0)?);
    }
    if keys.is_empty() || keys.len() > 5 {
        return Err(Error::BadOp);
    }
    Ok(keys)
}

fn signing_key(op: &[u8]) -> Result<Key, Error> {
    if cbor::text_field(op, "type")? == "create" {
        let (s, _) = cbor::map_get(op, "signingKey")?;
        return Key::from_did_key(cbor::text(op, s)?.0);
    }
    let (vs, _) = cbor::map_get(op, "verificationMethods")?;
    for e in cbor::map(op, vs)? {
        let (k, kvs, _, _) = e?;
        if k == "atproto" {
            return Key::from_did_key(cbor::text(op, kvs)?.0);
        }
    }
    Err(Error::BadOp)
}

/// Checks that `ops` (signed DAG-CBOR operations, genesis first) is a valid chain for `did`.
pub fn verify_plc_chain(did: &str, ops: &[&[u8]]) -> Result<ChainInfo, Error> {
    let genesis = ops.first().ok_or(Error::BrokenChain)?;
    let id = did.strip_prefix("did:plc:").ok_or(Error::BadDid)?;
    let expected = enc::base32_lower(&sha256(genesis));
    if id.len() != 24 || expected[..24] != *id {
        return Err(Error::BadDid);
    }
    let mut signers: Vec<Key> = Vec::new();
    let mut prev_cid = String::new();
    let mut hashes = Vec::with_capacity(ops.len());
    let mut used = Vec::with_capacity(ops.len());
    for (i, op) in ops.iter().enumerate() {
        let ty = cbor::text_field(op, "type")?;
        if ty != "plc_operation" && !(i == 0 && ty == "create") {
            return Err(Error::BadOp);
        }
        let (vs, _) = cbor::map_get(op, "prev")?;
        if i == 0 {
            if !cbor::is_null(op, vs) {
                return Err(Error::BrokenChain);
            }
            signers = rotation_keys(op)?;
        } else if cbor::text(op, vs)?.0 != prev_cid {
            return Err(Error::BrokenChain);
        }
        let (unsigned, (sv, _)) = cbor::strip_key(op, "sig")?;
        let sig = enc::base64url_decode(cbor::text(op, sv)?.0).ok_or(Error::BadSignature)?;
        let signer = signers.iter().position(|k| k.verify(&unsigned, &sig)).ok_or(Error::BadSignature)?;
        used.push(signer as u8);
        hashes.push(sha256(&unsigned));
        signers = rotation_keys(op)?;
        prev_cid = cid_string(op);
    }
    let last = ops.last().ok_or(Error::BrokenChain)?;
    let tip = *hashes.last().ok_or(Error::BrokenChain)?;
    Ok(ChainInfo { signing_key: signing_key(last)?, tip, len: ops.len() as u32, hashes, signers: used })
}

/// The handles an account's own signed identity chain asserts, read from an operation's `alsoKnownAs`
/// (`at://…` URIs, returned as bare handles) or the legacy genesis `handle` field. These are **anchored
/// by the PLC chain**, so a contract can trust that the DID *claims* them. It must NOT treat this as a
/// verified handle: that a handle resolves *back* to this DID lives in DNS/HTTPS the chain does not
/// anchor (see docs/SECURITY.md "handle resolution"). Pass the last operation of a verified chain.
pub fn also_known_as(op: &[u8]) -> Result<Vec<String>, Error> {
    let mut out = Vec::new();
    if cbor::text_field(op, "type")? == "create" {
        // Legacy genesis carries a single bare `handle`.
        if let Ok((vs, _)) = cbor::map_get(op, "handle") {
            out.push(String::from(cbor::text(op, vs)?.0));
        }
        return Ok(out);
    }
    let (vs, _) = cbor::map_get(op, "alsoKnownAs")?;
    for item in cbor::array_items(op, vs)? {
        let s = cbor::text(op, item)?.0;
        out.push(String::from(s.strip_prefix("at://").unwrap_or(s)));
    }
    Ok(out)
}

/// Whether the account's signed chain asserts `handle` (bare, e.g. `alice.bsky.social`) in the given
/// operation. See [`also_known_as`] for the trust caveat.
pub fn chain_asserts_handle(op: &[u8], handle: &str) -> bool {
    also_known_as(op).map_or(false, |hs| hs.iter().any(|h| h == handle))
}

/// Finds `target` in the tree rooted at `root`, using only the supplied nodes (each authenticated by its
/// hash). Returns the digest of the value's CID.
fn mst_find(nodes: &BTreeMap<[u8; 32], &[u8]>, root: [u8; 32], target: &[u8]) -> Result<[u8; 32], Error> {
    let mut want = root;
    for _ in 0..64 {
        let node = *nodes.get(&want).ok_or(Error::BadProof)?;
        let (ls, _) = cbor::map_get(node, "l")?;
        let mut child: Option<[u8; 32]> = if cbor::is_null(node, ls) { None } else { Some(cbor::link_digest(node, ls)?.0) };
        let (es, _) = cbor::map_get(node, "e")?;
        let mut prev_key: Vec<u8> = Vec::new();
        let mut descend: Option<Option<[u8; 32]>> = None;
        for item in cbor::array_items(node, es)? {
            let (mut k, mut p, mut t, mut v) = (None, None, None, None);
            for e in cbor::map(node, item)? {
                let (name, vs, _, _) = e?;
                match name {
                    "k" => k = Some(cbor::bytes(node, vs)?.0),
                    "p" => p = Some(cbor::uint(node, vs)?.0),
                    "t" => t = Some(if cbor::is_null(node, vs) { None } else { Some(cbor::link_digest(node, vs)?.0) }),
                    "v" => v = Some(cbor::link_digest(node, vs)?.0),
                    _ => {},
                }
            }
            let (k, p, t, v) = (
                k.ok_or(Error::BadProof)?,
                p.ok_or(Error::BadProof)? as usize,
                t.ok_or(Error::BadProof)?,
                v.ok_or(Error::BadProof)?,
            );
            if p > prev_key.len() {
                return Err(Error::BadProof);
            }
            prev_key.truncate(p);
            prev_key.extend_from_slice(k);
            match prev_key.as_slice().cmp(target) {
                core::cmp::Ordering::Equal => return Ok(v),
                core::cmp::Ordering::Greater => {
                    descend = Some(child);
                    break;
                },
                core::cmp::Ordering::Less => child = t,
            }
        }
        match descend.unwrap_or(child) {
            Some(c) => want = c,
            None => return Err(Error::NotFound),
        }
    }
    Err(Error::BadProof)
}

/// Verifies that the repo of `did`, as signed by `key`, contains `record` at `collection/rkey`.
pub fn verify_record(
    did: &str,
    key: &Key,
    commit: &[u8],
    mst_nodes: &[&[u8]],
    record: &[u8],
    collection: &str,
    rkey: &str,
) -> Result<(), Error> {
    let root = verify_commit(did, key, commit)?;
    verify_in_root(&root, mst_nodes, record, collection, rkey)
}

/// Checks a repo commit's signature, DID and version, and returns the MST root it commits to. Several record
/// proofs against one commit need only one signature check: call this once, then `verify_in_root` for each.
pub fn verify_commit(did: &str, key: &Key, commit: &[u8]) -> Result<[u8; 32], Error> {
    let (unsigned, (sv, _)) = cbor::strip_key(commit, "sig")?;
    let sig = cbor::bytes(commit, sv)?.0;
    if !key.verify(&unsigned, sig) {
        return Err(Error::BadSignature);
    }
    if cbor::text_field(commit, "did")? != did {
        return Err(Error::BadCommit);
    }
    let (vs, _) = cbor::map_get(commit, "version")?;
    if cbor::uint(commit, vs)?.0 != 3 {
        return Err(Error::BadCommit);
    }
    let (ds, _) = cbor::map_get(commit, "data")?;
    Ok(cbor::link_digest(commit, ds)?.0)
}

/// Verifies that the MST rooted at `root` (from `verify_commit`) holds `record` at `collection/rkey`.
pub fn verify_in_root(root: &[u8; 32], mst_nodes: &[&[u8]], record: &[u8], collection: &str, rkey: &str) -> Result<(), Error> {
    let nodes: BTreeMap<[u8; 32], &[u8]> = mst_nodes.iter().map(|n| (sha256(n), *n)).collect();
    let mut path = Vec::with_capacity(collection.len() + 1 + rkey.len());
    path.extend_from_slice(collection.as_bytes());
    path.push(b'/');
    path.extend_from_slice(rkey.as_bytes());
    let value = mst_find(&nodes, *root, &path)?;
    if sha256(record) != value {
        return Err(Error::BadProof);
    }
    Ok(())
}

const TID_ALPHABET: &[u8] = b"234567abcdefghijklmnopqrstuvwxyz";

/// The time in a repo commit's `rev`, in microseconds since the Unix epoch. A `rev` is a TID: 13 base32-sortable
/// characters holding 53 bits of time and 10 bits of clock id. The repo's signing key signs it, so a commit can
/// never claim to be newer than it is, and a later commit that still holds a record proves the record was not
/// deleted before that time.
pub fn commit_rev_micros(commit: &[u8]) -> Result<u64, Error> {
    let rev = cbor::text_field(commit, "rev")?;
    let b = rev.as_bytes();
    if b.len() != 13 {
        return Err(Error::BadCommit);
    }
    let mut v: u64 = 0;
    for (i, c) in b.iter().enumerate() {
        let d = TID_ALPHABET.iter().position(|a| a == c).ok_or(Error::BadCommit)? as u64;
        if i == 0 && d >= 16 {
            return Err(Error::BadCommit);
        }
        v = (v << 5) | d;
    }
    Ok(v >> 10)
}

// ---- generic record / field proofs -----------------------------------------------------------------
// Once `verify_record` has authenticated a record's bytes against the signed repo, these read fields
// out of it. They work on any lexicon (post, like, follow, repost, custom), so a contract building on
// this layer proves "account DID published a record at collection/rkey whose field X = Y" without
// re-implementing any atproto crypto. `path` descends nested maps, e.g. &["reply", "parent", "uri"].

/// The `$type` (lexicon id) of a record, e.g. `app.bsky.feed.post`.
pub fn record_type(record: &[u8]) -> Result<&str, Error> {
    field_str(record, &["$type"])
}

/// A text field at a nested `path`.
pub fn field_str<'a>(record: &'a [u8], path: &[&str]) -> Result<&'a str, Error> {
    let (vs, _) = cbor::path_get(record, path)?;
    Ok(cbor::text(record, vs)?.0)
}

/// A non-negative integer field at a nested `path`.
pub fn field_u64(record: &[u8], path: &[&str]) -> Result<u64, Error> {
    let (vs, _) = cbor::path_get(record, path)?;
    Ok(cbor::uint(record, vs)?.0)
}

/// Whether a field exists at `path`.
pub fn field_present(record: &[u8], path: &[&str]) -> bool {
    cbor::path_get(record, path).is_ok()
}

/// Whether the text field at `path` equals `expected` exactly.
pub fn field_eq(record: &[u8], path: &[&str], expected: &str) -> bool {
    field_str(record, path).map_or(false, |s| s == expected)
}

/// Whether the text field at `path` contains `needle`.
pub fn field_contains(record: &[u8], path: &[&str], needle: &str) -> bool {
    field_str(record, path).map_or(false, |s| s.contains(needle))
}

/// The `text` field of a (verified) record, e.g. a post's text.
pub fn record_text(record: &[u8]) -> Result<&str, Error> {
    field_str(record, &["text"])
}
