#!/bin/bash
# Builds atp-verify for the browser and copies it into the site. Works on a WSL copy (no build output on C:).
set -e
SRC=/mnt/c/Users/harsh/bsky-tari
B=$HOME/atp-wasm-build
mkdir -p "$B"
rsync -a --delete --exclude target --exclude Cargo.lock "$SRC/atp-verify/" "$B/atp-verify/"
rsync -a --delete --exclude target --exclude Cargo.lock "$SRC/atp-verify-wasm/" "$B/atp-verify-wasm/"
find "$B" -name '*.rs' -exec touch {} +
cd "$B/atp-verify-wasm"
CARGO_TARGET_DIR=$HOME/atp-wasm-target cargo build --release --target wasm32-unknown-unknown 2>&1 | grep -E '^error|^ +--> |Finished' | head -30
OUT=$HOME/atp-wasm-target/wasm32-unknown-unknown/release/atp_verify_wasm.wasm
OPT=$(find ~/.cache/.wasm-pack -name wasm-opt -type f | head -1)
mkdir -p "$SRC/web-atproto/public"
"$OPT" -Oz --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext --enable-mutable-globals "$OUT" -o "$SRC/web-atproto/public/atp_verify.wasm"
mkdir -p "$SRC/web/public"; cp "$SRC/web-atproto/public/atp_verify.wasm" "$SRC/web/public/atp_verify.wasm"
ls -la "$OUT" "$SRC/web-atproto/public/atp_verify.wasm"
cd "$B/atp-verify" && CARGO_TARGET_DIR=$HOME/atp-target cargo test 2>&1 | grep -E 'test result|FAILED|^error' | head
