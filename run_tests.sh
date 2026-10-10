#!/bin/bash
# Sync into the WSL workspace, build the engine test binary, then run it (optionally filtered by $1).
# The test builds the template with its own cargo; that child must use a different target dir than the
# parent or it waits forever on the parent's build lock.
bash /mnt/c/Users/harsh/bsky-tari/sync.sh >/dev/null 2>&1
cd ~/ootle-ringfence
cargo test --target-dir ~/ootle-target -p tari_engine --test bskyclaim --release --no-run > /tmp/build.log 2>&1
BIN=$(grep -oE 'target/release/deps/bskyclaim-[0-9a-f]+' /tmp/build.log | head -1)
if [ -z "$BIN" ]; then grep -E "^error|-->" /tmp/build.log | head -40; exit 1; fi
cd crates/engine
~/ootle-target/${BIN#target/} --nocapture --test-threads=1 $1 2>&1 \
  | grep -E "^error|^test |points|panicked|-->|left:|right:|wanted|test result" | head -${2:-80}
