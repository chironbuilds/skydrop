#!/bin/bash
# Mutation check for ClaimPolicy: break one safety check at a time and confirm a test notices.
bash /mnt/c/Users/harsh/bsky-tari/scripts/wsl-sync.sh
cd ~/ootle-skydrop
F=crates/engine/tests/templates/claim-policy/src/lib.rs
cp "$F" /tmp/claimp.orig.rs
run() {
  local name="$1" from="$2" to="$3"
  cp /tmp/claimp.orig.rs "$F"
  FROM="$from" TO="$to" python3 - "$F" <<'PY'
import os,sys
p=sys.argv[1]; s=open(p,encoding='utf-8').read()
a=os.environ['FROM']; b=os.environ['TO']
assert s.count(a)>=1, "mutation target missing: "+a
open(p,'w',encoding='utf-8').write(s.replace(a,b,1))
PY
  [ $? -eq 0 ] || { echo "SKIP      $name (target missing)"; return; }
  local fails=0 s
  for s in claim linkclaim; do
    if ! cargo test --target-dir ~/ootle-target-skydrop -p tari_engine --test $s --release -- --test-threads=1 2>&1 | grep -q 'test result: ok'; then fails=1; break; fi
  done
  if [ $fails = 1 ]; then echo "caught    $name (in $s)"; else echo "SURVIVED  $name"; fi
}
run "no post length cap"              'assert!(text.len() <= MAX_POST_TEXT, "that post is longer than Bluesky allows");' ''
run "vault never rotates"             'if self.record_vault_count >= self.record_vault_size {' 'if false {'
run "record id ignores the DID"       'NonFungibleId::from_u256(sha256(did.as_bytes()))' '{ let _ = did; NonFungibleId::from_u32(1) }'
run "no vault size limit"             'assert!(record_vault_size >= 1 && record_vault_size <= MAX_RECORD_VAULT_SIZE, "record vault size out of range");' ''
run "ignores own chain floor"         'assert!(len >= self.read(did).known_len, "stale operation chain: a longer one has been seen");' ''
run "ignores registry floor"          'assert!(len >= floor, "stale operation chain: a longer one has been seen");' ''
run "no claim code check"             'assert!(text.contains(&code), "the post does not contain the claim code");' ''
run "start needs no signature"        'require_signer(claimant);
            self.do_start(&did, claimant, &ops, &commit, &mst_nodes, &record, &rkey);
        }

        /// `start_claim` with' 'self.do_start(&did, claimant, &ops, &commit, &mst_nodes, &record, &rkey);
        }

        /// `start_claim` with'
run "start needs no deposit"          'let deps: Vec<EscDep> = ComponentManager::get(self.escrow).call("deposits_for", args![did.to_string()]);
            assert!(deps.iter().any(|d| d.3 == me), "no deposits for this account under this policy");' ''
run "finalize needs no signature"     'let (claimant, start, _, _) = rec.pending.clone().expect("no pending claim");
            require_signer(claimant);
            let me = CallerContext::current_component_address();
            let now = Consensus::current_epoch();
            let text = rec.claim_text.clone().unwrap_or_default();
            // seen = epoch' 'let (_claimant, start, _, _) = rec.pending.clone().expect("no pending claim");
            let me = CallerContext::current_component_address();
            let now = Consensus::current_epoch();
            let text = rec.claim_text.clone().unwrap_or_default();
            // seen = epoch'
run "window not enforced"             '&& now >= start.saturating_add(window_of(&d.4))' ''
run "phrase not enforced"             '&& phrase_ok(text, &d.4)' ''
run "hold epochs not enforced"        '&& seen >= start.saturating_add(hold)' ''
run "hold snapshot time not enforced" '&& gap >= hold.saturating_mul(EPOCH_MICROS)' ''
run "invalid metadata pays"           '&& metadata_valid(&d.4)
        && now' '&& now'
run "late challenge allowed"          'assert!(Consensus::current_epoch() < start.saturating_add(max_window), "the challenge window has closed");' ''
run "shorter chain can challenge"     'assert!(chain.len >= len, "that chain is shorter than the one the claim relied on");' ''
run "same chain can challenge"        'assert!(chain.tip.as_slice() != tip.as_slice(), "that is the chain the claim already relies on");' ''
run "challenge keeps the claim"       'rec.known_len = rec.known_len.max(chain.len);
            rec.pending = None;' 'rec.known_len = rec.known_len.max(chain.len);'
run "challenge doesn't raise floor"   'rec.known_len = rec.known_len.max(chain.len);
            rec.pending = None;' 'rec.pending = None;'
run "confirm accepts another post"    'assert!(rkey == held_rkey, "that is not the post the claim was made with");' ''
run "confirm accepts changed text"    'assert!(rec.claim_text.as_deref() == Some(text), "the post has changed since the claim started");' ''
run "confirm accepts old snapshot"    'assert!(rev >= last_rev, "that snapshot of the account is older than one already proven");' ''
run "linked post can be replayed"     'assert!(rkey.as_str() > h.0.as_str(), "a newer post than the pending claim'"'"'s is needed");' ''
run "unlimited sponsored starts"      'assert!(self.read(&did).sponsored.0 < MAX_SPONSORED, "this account has used its sponsored claims");' ''
run "unlimited sponsored payouts"     'assert!(rec.sponsored.1 < MAX_SPONSORED, "this account has used its sponsored payouts");' ''
run "unlimited sponsored confirms"    'assert!(self.read(&did).sponsored.2 < MAX_SPONSORED, "this account has used its sponsored confirmations");' ''
run "unlimited sponsored declines"    'assert!(self.read(&did).sponsored.3 < MAX_SPONSORED, "this account has used its sponsored declines");' ''
run "sweep ignores a pending claim"   '(!claiming && !phrase_of(&d.4).is_empty() && now >= d.5.saturating_add(SWEEP_AFTER))' '(!phrase_of(&d.4).is_empty() && now >= d.5.saturating_add(SWEEP_AFTER))'
run "phrase gifts swept at once"      '&& now >= d.5.saturating_add(SWEEP_AFTER)' ''
run "pay_linked needs no signature"   'require_signer(sender);
            let reg = self.link_registry;' 'let reg = self.link_registry;'
run "unbounded delivery log"          'if rec.delivered.len() >= MAX_DELIVERED {
                rec.delivered.remove(0);
            }' ''
run "anyone can decline"              'require_signer(owner);' 'let _ = owner;'
cp /tmp/claimp.orig.rs "$F"
