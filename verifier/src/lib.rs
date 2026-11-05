//   SPDX-License-Identifier: BSD-3-Clause

//! The **Bluesky identity layer for Ootle**: a pure, stateless Verifier component that any contract can
//! call to prove, in-WASM with no oracle, facts about a Bluesky (atproto) account. It wraps the
//! `atp-verify` crate and exposes the whole verification menu over the component ABI.
//!
//! Trust notes (see the project's `docs/SECURITY.md`):
//!  * Everything here is anchored by the account's own signatures or by content hashes, so a caller that
//!    pins this component's address gets trustless results.
//!  * `record_field_text` is a **pure read** that does NOT verify — a caller must first prove the record
//!    with `prove_record`/`prove_record_field`, or use the atomic `prove_record_field`.
//!  * Handle→DID, did:web and account status are NOT representable here: they are not anchored on-chain.
//!    This component deliberately offers only the DID→handle direction (`asserts_handle`).

use atp_verify::{Alg, Key};
use tari_template_lib::prelude::*;

const MAX_OPS: usize = 16;
const MAX_NODES: usize = 32;
const MAX_BLOCK_LEN: usize = 16 * 1024;
const MAX_PATH: usize = 8;

fn slices(items: &[Bytes], max: usize) -> Vec<&[u8]> {
    assert!(items.len() <= max, "too many blocks");
    assert!(items.iter().all(|b| b.len() <= MAX_BLOCK_LEN), "block too large");
    items.iter().map(|b| b.as_slice()).collect()
}

/// Rebuilds an `atp_verify::Key` from a 33-byte compressed SEC1 key and an algorithm tag (0 = k256/secp256k1,
/// 1 = p256). Panics (aborts the transaction) on a malformed key.
fn key_from(bytes: &Bytes, alg: u8) -> Key {
    assert!(bytes.len() == 33, "a compressed key is 33 bytes");
    let alg = match alg {
        0 => Alg::K256,
        1 => Alg::P256,
        _ => panic!("unknown key algorithm"),
    };
    let mut b = [0u8; 33];
    b.copy_from_slice(bytes.as_slice());
    Key { alg, bytes: b }
}

#[template]
mod verifier {
    use super::*;

    pub struct Verifier {}

    impl Verifier {
        /// Deploys the layer. One instance is enough for a whole network; callers pin its address.
        pub fn new() -> Component<Self> {
            Component::new(Self {}).with_access_rules(AccessRules::allow_all()).create()
        }

        /// Verifies a `did:plc` operation chain (genesis first). Aborts if invalid. Returns
        /// `(signing_key, alg, tip, len)`: the repo signing key (33-byte compressed SEC1), its algorithm
        /// (0 = k256, 1 = p256), the 32-byte hash of the last operation, and the chain length. A caller
        /// uses `len`/`tip` for its own staleness/challenge logic.
        pub fn verify_chain(&self, did: String, ops: Vec<Bytes>) -> (Bytes, u8, Bytes, u32) {
            assert!(!ops.is_empty(), "empty operation chain");
            let ops = slices(&ops, MAX_OPS);
            let chain = atp_verify::verify_plc_chain(&did, &ops).expect("invalid operation chain");
            let alg = match chain.signing_key.alg {
                Alg::K256 => 0u8,
                Alg::P256 => 1u8,
            };
            (
                Bytes::from_vec(chain.signing_key.bytes.to_vec()),
                alg,
                Bytes::from_vec(chain.tip.to_vec()),
                chain.len,
            )
        }

        /// Proves that `did`'s repo (as signed by the key its chain yields) contains `record` at
        /// `collection/rkey`. Aborts if any step fails. Returns `(tip, len)` of the chain for staleness use.
        pub fn prove_record(
            &self,
            did: String,
            ops: Vec<Bytes>,
            commit: Bytes,
            mst_nodes: Vec<Bytes>,
            record: Bytes,
            collection: String,
            rkey: String,
        ) -> (Bytes, u32) {
            let chain = self.prove_record_inner(&did, &ops, &commit, &mst_nodes, &record, &collection, &rkey);
            (Bytes::from_vec(chain.tip.to_vec()), chain.len)
        }

        /// Proves a record (as `prove_record`) and atomically returns a text field from it, so a caller
        /// never reads an unverified field. `path` descends nested maps, e.g. `["reply","root","uri"]`.
        /// Returns an empty string if the field is absent or not text.
        pub fn prove_record_field(
            &self,
            did: String,
            ops: Vec<Bytes>,
            commit: Bytes,
            mst_nodes: Vec<Bytes>,
            record: Bytes,
            collection: String,
            rkey: String,
            path: Vec<String>,
        ) -> String {
            self.prove_record_inner(&did, &ops, &commit, &mst_nodes, &record, &collection, &rkey);
            field_text(&record, &path)
        }

        /// Reads a text field out of a record WITHOUT verifying it. Only safe on a record already proven by
        /// `prove_record` in the same transaction. Empty string if absent or not text.
        pub fn record_field_text(&self, record: Bytes, path: Vec<String>) -> String {
            field_text(&record, &path)
        }

        /// The `$type` (lexicon id) of a record. Pure read; verify the record first.
        pub fn record_type(&self, record: Bytes) -> String {
            atp_verify::record_type(record.as_slice()).map(String::from).unwrap_or_default()
        }

        /// Whether the account's signed chain asserts `handle` (bare, e.g. `alice.bsky.social`) in the
        /// given operation (pass the last op of a verified chain). This is the DID→handle direction only;
        /// it does NOT prove the handle resolves back to the DID.
        pub fn asserts_handle(&self, op: Bytes, handle: String) -> bool {
            atp_verify::chain_asserts_handle(op.as_slice(), &handle)
        }

        /// The time in a repo commit's `rev`, microseconds since the Unix epoch. Aborts on a malformed rev.
        pub fn commit_time(&self, commit: Bytes) -> u64 {
            atp_verify::commit_rev_micros(commit.as_slice()).expect("bad commit revision")
        }

        /// Verifies an atproto service-auth JWT signed by `key` (`key_alg`: 0 = k256, 1 = p256). Aborts if
        /// the signature or structure is invalid. Returns `(iss, aud, exp, lxm)`; `lxm` is empty if absent.
        /// `exp` is NOT checked against a clock — the caller compares it to its own epoch/time.
        pub fn verify_service_auth(&self, token: String, key: Bytes, key_alg: u8) -> (String, String, u64, String) {
            let k = key_from(&key, key_alg);
            let c = atp_verify::jwt::verify_service_auth(&token, &k).expect("invalid service-auth token");
            (c.iss, c.aud, c.exp, c.lxm.unwrap_or_default())
        }

        fn prove_record_inner(
            &self,
            did: &str,
            ops: &[Bytes],
            commit: &Bytes,
            mst_nodes: &[Bytes],
            record: &Bytes,
            collection: &str,
            rkey: &str,
        ) -> atp_verify::ChainInfo {
            assert!(!ops.is_empty(), "empty operation chain");
            assert!(commit.len() <= MAX_BLOCK_LEN && record.len() <= MAX_BLOCK_LEN, "block too large");
            let ops_s = slices(ops, MAX_OPS);
            let nodes = slices(mst_nodes, MAX_NODES);
            let chain = atp_verify::verify_plc_chain(did, &ops_s).expect("invalid operation chain");
            atp_verify::verify_record(did, &chain.signing_key, commit.as_slice(), &nodes, record.as_slice(), collection, rkey)
                .expect("invalid repo proof");
            chain
        }
    }
}

/// Reads a text field at `path` from a record, empty if absent/not text. Shared by the pure and atomic reads.
fn field_text(record: &Bytes, path: &[String]) -> String {
    assert!(path.len() <= MAX_PATH, "path too deep");
    let refs: Vec<&str> = path.iter().map(|s| s.as_str()).collect();
    atp_verify::field_str(record.as_slice(), &refs).map(String::from).unwrap_or_default()
}
