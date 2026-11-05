#!/bin/bash
# Mirror Rust sources into the WSL Ootle v0.49.2 worktree where engine tests are built, and touch them so
# cargo notices (rsync -a keeps source mtimes, which otherwise reuses stale artifacts).
set -e
SRC=/mnt/c/Users/harsh/bsky-tari
DST=${OOTLE_TREE:-$HOME/ootle-skydrop}
T=$DST/crates/engine/tests
mkdir -p "$DST/atp-verify"
rsync -a --delete --exclude target --exclude Cargo.lock "$SRC/atp-verify/" "$DST/atp-verify/"
for t in escrow claim-policy tip-policy link-registry engagement-bounty list-drop service-pay social-recovery verifier campaigns escrow-probe; do
  [ -d "$SRC/$t" ] || continue
  mkdir -p "$T/templates/$t"
  rsync -a --delete --exclude target --exclude Cargo.lock "$SRC/$t/" "$T/templates/$t/"
done
for f in escrow claim linkclaim linkreg tippolicy engbounty listdrop servicepay recovery verifier campaigns escrowprobe; do
  [ -f "$SRC/$f.rs" ] && cp "$SRC/$f.rs" "$T/$f.rs"
done
find "$DST/atp-verify/src" "$T/templates"/{escrow,claim-policy,tip-policy,link-registry,engagement-bounty,list-drop,service-pay,social-recovery,verifier,campaigns,escrow-probe}/src -name '*.rs' -exec touch {} + 2>/dev/null || true
