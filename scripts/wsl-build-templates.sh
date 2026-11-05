#!/bin/bash
# Compile every template to wasm against the 0.49.2 worktree; print errors only.
bash /mnt/c/Users/harsh/bsky-tari/scripts/wsl-sync.sh
T=~/ootle-skydrop/crates/engine/tests/templates
for t in ${@:-escrow claim-policy tip-policy link-registry engagement-bounty list-drop service-pay social-recovery verifier campaigns}; do
  [ -d $T/$t ] || continue
  echo "== $t"
  (cd $T/$t && CARGO_TARGET_DIR=~/skydrop-wasm-target cargo build --release --target wasm32-unknown-unknown 2>&1 | grep -E '^(error|warning: unused)|^ +--> |Finished' | head -40)
done
ls -la ~/skydrop-wasm-target/wasm32-unknown-unknown/release/*.wasm 2>/dev/null
