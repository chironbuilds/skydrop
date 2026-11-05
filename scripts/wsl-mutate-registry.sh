#!/bin/bash
# Mutation check for the LinkRegistry: break one safety check at a time and confirm a test notices.
bash /mnt/c/Users/harsh/bsky-tari/scripts/wsl-sync.sh
cd ~/ootle-skydrop
F=crates/engine/tests/templates/link-registry/src/lib.rs
cp "$F" /tmp/registry.orig.rs
run() {
  local name="$1" from="$2" to="$3"
  cp /tmp/registry.orig.rs "$F"
  FROM="$from" TO="$to" python3 - "$F" <<'PY'
import os,sys
p=sys.argv[1]; s=open(p,encoding='utf-8').read()
a=os.environ['FROM']; b=os.environ['TO']
assert s.count(a)>=1, "mutation target missing: "+a
open(p,'w',encoding='utf-8').write(s.replace(a,b,1))
PY
  [ $? -eq 0 ] || { echo "SKIP      $name (target missing)"; return; }
  local fails=0 s
  for s in linkreg campaigns; do
    if ! cargo test --target-dir ~/ootle-target-skydrop -p tari_engine --test $s --release -- --test-threads=1 2>&1 | grep -q 'test result: ok'; then fails=1; break; fi
  done
  if [ $fails = 1 ]; then echo "caught    $name (in $s)"; else echo "SURVIVED  $name"; fi
}
run "post can be reused"             'assert!(rkey.as_str() > last.as_str(), "this post, or a later one, was already used to bind");' ''
run "bind ignores the floor"         'assert!(chain.len >= known_len, "stale operation chain: a longer one has been seen");' ''
run "no bind code check"             'assert!(text.contains(&code), "the post does not contain the bind code");' ''
run "any component can be linked"    'ComponentManager::get(address).get_template_address() == TemplateAddress::from_array([0; 32]),' 'true,'
run "replacement applies at once"    'Some((c, co)) => (address, now + self.bind_delay, c, owner, co),' 'Some((c, co)) => (address, now, c, owner, co),'
run "first bind applies at once"     'None => (address, now + self.bind_delay, me, owner, owner),' 'None => (address, now, me, owner, owner),'
run "bind doesn't raise the floor"   'Some(rkey), chain.len);' 'Some(rkey), known_len);'
run "late challenge allowed"         'assert!(Consensus::current_epoch() < since, "the binding is already in effect");' ''
run "shorter chain can challenge"    'assert!(chain.len >= len, "that chain is shorter than the one the binding relied on");' ''
run "same chain can challenge"       'assert!(chain.tip.as_slice() != tip.as_slice(), "that is the chain the binding already relies on");' ''
run "challenge loses the old wallet" 'let restored: Option<Binding> = if old == me { None } else { Some((old, 0, old, old_owner, old_owner)) };' 'let _ = (old, old_owner, me); let restored: Option<Binding> = None;'
run "challenge doesn't raise floor"  'let updated: Record = (restored, None, last_bind, known_len.max(chain.len));' 'let updated: Record = (restored, None, last_bind, known_len);'
run "observe can lower the floor"    'let updated: Record = (binding, proof, last_bind, known_len.max(chain.len));' 'let _ = known_len; let updated: Record = (binding, proof, last_bind, chain.len);'
run "observe needs no valid chain"   'let chain = atp_verify::verify_plc_chain(&did, &ops_s).expect("invalid operation chain");
            let (binding, proof, last_bind, known_len) = self.read(&did);' 'let _ = ops_s; let chain = atp_verify::ChainInfo { signing_key: atp_verify::Key { alg: atp_verify::Alg::K256, bytes: [0; 33] }, tip: [0; 32], len: ops.len() as u32 + 9 };
            let (binding, proof, last_bind, known_len) = self.read(&did);'
run "vault never rotates"            'if self.record_vault_count >= self.record_vault_size {' 'if false {'
run "record id ignores the DID"      'NonFungibleId::from_u256(sha256(did.as_bytes()))' '{ let _ = did; NonFungibleId::from_u32(1) }'
run "no vault size limit"            'assert!(record_vault_size >= 1 && record_vault_size <= MAX_RECORD_VAULT_SIZE, "record vault size out of range");' ''
run "wrong wallet while pending"     'Some((old, old_owner))' 'Some((address, owner))'
# Not listed: .withdrawable(deny_all) on records can't be observed, since no method moves a record out of its vault.
cp /tmp/registry.orig.rs "$F"
