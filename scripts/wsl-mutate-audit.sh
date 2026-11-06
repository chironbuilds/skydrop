#!/bin/bash
# Removes each check added by the 2026-11-07 audit in turn, and confirms the tests notice. Works on the WSL tree only.
# ONLY=<part of a name> runs just that one.
T=~/ootle-skydrop
TPL=$T/crates/engine/tests/templates
run() { # name, file, python expression old, new, test name
  local name="$1" file="$2" old="$3" new="$4" tests="$5"
  [ -n "$ONLY" ] && [[ "$name" != *"$ONLY"* ]] && return
  bash /mnt/c/Users/harsh/bsky-tari/scripts/wsl-sync.sh
  OLD="$old" NEW="$new" FILE="$file" python3 - <<'EOF' || { echo "COULD NOT APPLY: $name"; return; }
import os, sys
p = os.environ["FILE"]; s = open(p).read(); o = os.environ["OLD"]
if o not in s: sys.exit(1)
open(p, "w").write(s.replace(o, os.environ["NEW"], 1))
EOF
  cd $T
  if cargo test --target-dir ~/ootle-target-skydrop -p tari_engine --test "$tests" --release -- --test-threads=1 2>&1 | grep -q "test result: FAILED"; then echo "caught    $name"; else echo "MISSED    $name"; fi
}
run "a fork longer than the pin" $T/atp-verify/src/lib.rs 'self.len >= seen_len && self.hashes.get(seen_len as usize - 1).is_some_and(|h| h.as_slice() == seen_tip)' 'self.len >= seen_len' linkreg
run "a fork longer than the pin, on a claim" $TPL/campaigns/src/lib.rs 'assert!(chain.extends(floor, floor_tip.as_slice()),' 'assert!(chain.len >= floor,' campaigns
run "the tip hashing the whole operation" $T/atp-verify/src/lib.rs 'hashes.push(sha256(&unsigned));' 'hashes.push(sha256(op));' linkreg
run "resolve_fork without a priority check" $TPL/link-registry/src/lib.rs 'assert!(new.overrides(&seen), "that chain doesn'"'"'t outrank the one already seen");' '' linkreg
run "resolve_fork without naming the pinned chain" $TPL/link-registry/src/lib.rs 'assert!(known.0 > 0 && seen.extends(known.0, known.1.as_slice()), "that isn'"'"'t the chain already seen");' '' linkreg
run "resolve_fork keeping the link" $TPL/link-registry/src/lib.rs 'let updated: Record = (None, None, None, pin_of(&new));' 'let (b, p, l, _) = self.read(&did); let updated: Record = (b, p, l, pin_of(&new));' linkreg
run "a forged bind on a fork" $TPL/link-registry/src/lib.rs 'assert!(chain.extends(known.0, known.1.as_slice()), "stale operation chain: a longer or different one has been seen");
            atp_verify::verify_record' 'atp_verify::verify_record' linkreg
run "anyone naming a referrer" $TPL/campaigns/src/lib.rs 'require_signer(owner);' '' campaigns
run "a vouch replayed in a later round" $TPL/campaigns/src/lib.rs 'assert!(rev > last_vouched.get(i).copied().unwrap_or(0), "that voucher proof is not newer than the last round'"'"'s");' '' campaigns
run "a token signature in another spelling" $T/atp-verify/src/enc.rs 'if bits >= 6 || acc != 0 {' 'if false {' servicepay
bash /mnt/c/Users/harsh/bsky-tari/scripts/wsl-sync.sh
