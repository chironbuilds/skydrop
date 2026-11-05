#!/bin/bash
# Build + run engine tests against the 0.49.2 worktree. Usage: wsl-test.sh [test names...]
bash /mnt/c/Users/harsh/bsky-tari/scripts/wsl-sync.sh
cd ~/ootle-skydrop
grep -q '^k256 = ' crates/engine/Cargo.toml || sed -i '/^\[dev-dependencies\]/a k256 = { version = "0.13", features = ["ecdsa"] }\nrand_core = { version = "0.6", features = ["getrandom"] }\nsha2 = "0.10"\ntari_crypto = { workspace = true }' crates/engine/Cargo.toml
TESTS=${@:-escrow escrowprobe claim linkclaim linkreg tippolicy engbounty listdrop servicepay recovery verifier campaigns}
for t in $TESTS; do
  [ -f crates/engine/tests/$t.rs ] || continue
  echo "=== $t"
  cargo test --target-dir ~/ootle-target-skydrop -p tari_engine --test $t --release -- --test-threads=1 2>&1 | grep -E "^error|^ +--> |^test |test result|panicked|could not compile|points:|state bytes|expected failure" | head -${LINES_MAX:-40}
done
