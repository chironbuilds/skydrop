#!/bin/bash
# Mirror the Rust sources into the WSL workspace where the Ootle engine tests are built.
set -e
SRC=/mnt/c/Users/harsh/bsky-tari
DST=$HOME/ootle-ringfence
mkdir -p $DST/atp-verify
rsync -a --delete --exclude target --exclude Cargo.lock $SRC/atp-verify/ $DST/atp-verify/
[ -d $SRC/bskyclaim ] && mkdir -p $DST/crates/engine/tests/templates/bskyclaim && rsync -a --exclude target --exclude Cargo.lock $SRC/bskyclaim/ $DST/crates/engine/tests/templates/bskyclaim/
[ -f $SRC/bskyclaim.rs ] && cp $SRC/bskyclaim.rs $DST/crates/engine/tests/bskyclaim.rs
true
