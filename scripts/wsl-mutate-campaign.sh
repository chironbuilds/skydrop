#!/bin/bash
# Mutation check: break one safety check at a time in a throwaway copy of the Campaign template and confirm the
# test suite notices. A mutant that survives means a test is not really testing that check.
bash /mnt/c/Users/harsh/bsky-tari/scripts/wsl-sync.sh
cd ~/ootle-skydrop
F=crates/engine/tests/templates/campaigns/src/lib.rs
cp "$F" /tmp/campaign.orig.rs
run() {
  local name="$1" from="$2" to="$3"
  cp /tmp/campaign.orig.rs "$F"
  FROM="$from" TO="$to" python3 - "$F" <<'PY'
import os,sys
p=sys.argv[1]; s=open(p,encoding='utf-8').read()
a=os.environ['FROM']; b=os.environ['TO']
assert s.count(a)>=1, "mutation target missing: "+a
open(p,'w',encoding='utf-8').write(s.replace(a,b,1))
PY
  [ $? -eq 0 ] || { echo "SKIP  $name (target missing)"; return; }
  local out
  out=$(cargo test --target-dir ~/ootle-target-skydrop -p tari_engine --test campaigns --release -- --test-threads=1 2>&1)
  if echo "$out" | grep -q 'test result: ok'; then echo "SURVIVED  $name"; else echo "caught    $name: $(echo "$out" | grep -E 'FAILED$' | wc -l) test(s)"; fi
}
run "no rule check"            'assert!(ok, "a record does not satisfy its campaign rule");' ''
run "no claim-code check"      'assert!(text.contains(&code), "the post does not contain the claim code");' ''
run "no claimant signature"    'require_signer(claimant);
            self.assert_open();
            let key = self.verify_chain(&did, &ops);
            self.verify_code(&did, &key, &claimant, 0,' 'self.assert_open();
            let key = self.verify_chain(&did, &ops);
            self.verify_code(&did, &key, &claimant, 0,'
run "no chain floor"           'assert!(chain.len >= floor, "stale operation chain: a longer one has been seen");' ''
run "no voucher subject"       'assert!(atp_verify::field_eq(record, &["subject"], did), "that record vouches for another account");' ''
run "no list match"            'assert!(atp_verify::field_eq(record, &["list"], target), "that list item is on another list");' ''
run "no snapshot"              'assert!(rev >= self.snapshots[i], "that voucher proof predates the campaign'"'"'s snapshot");' ''
run "voucher repo = claimant"  'atp_verify::verify_record(&voucher, &vkey, commit' 'atp_verify::verify_record(did, key, commit'
run "no allocation check"      'assert!(merkle_ok(self.allocation_root.as_slice(), allocation_leaf(did, amount), path), "this account is not on the allocation list for that amount");' ''
run "no round spacing"         'assert!(now >= last_epoch.saturating_add(self.round_epochs), "this round is not open yet");' ''
run "no newer-proof check"     'assert!(rev == 0 || rev > last_rev, "these proofs are not newer than the last round'"'"'s");' ''
run "no round limit"           'assert!(paid_rounds < self.rounds, "every round has been paid");' ''
run "funder can close early"   'assert!(Consensus::current_epoch() >= self.close_epoch, "the campaign has not closed yet");' ''
run "anyone can close"         'pub fn close(&mut self) -> Bucket {
            require_signer(self.funder);' 'pub fn close(&mut self) -> Bucket {'
run "close can move earlier"   'assert!(close_epoch > self.close_epoch, "the close epoch can only move later");' ''
run "claims after close"       'assert!(now < self.close_epoch, "the campaign has closed");' ''
run "claims before open"       'assert!(now >= self.open_epoch, "the campaign has not opened yet");' ''
run "self referral"            'assert!(from != did, "an account cannot refer itself");' ''
run "no referral cap"          'assert!(referrals < self.max_referrals, "that referrer has used all its referrals");' ''
run "no required-text check"   'assert!(text.is_empty() || atp_verify::field_contains(record, &["text"], text), "that post does not contain the required text");' ''
run "text on any rule"         'assert!(text.is_empty() || matches!(*kind, REPLY | QUOTE), "only replies and quotes can require text");' ''
run "required steps skippable" 'assert!(self.groups[i] != 0, "a required step has no proof");' ''
run "either/or group empty"    'assert!(g == 0 || (0..n).any(|j| self.groups[j] == g && proven[j]), "an either/or step has no proof");' ''
run "extra voucher chains"     'assert!(vouch == vouch_ops.len(), "one operation chain per proven vouch rule");' ''
run "receipts transferable"    '.withdrawable(rule!(deny_all), rule!(deny_all))' ''
run "dedupe by random id"      'manager.mint_non_fungible(receipt_id(&did), &data, &state)' 'manager.mint_non_fungible(NonFungibleId::random(), &data, &state)'
cp /tmp/campaign.orig.rs "$F"
