#!/bin/bash
# Mutation check for the Escrow: break one safety check at a time and confirm a test notices.
bash /mnt/c/Users/harsh/bsky-tari/scripts/wsl-sync.sh
cd ~/ootle-skydrop
F=crates/engine/tests/templates/escrow/src/lib.rs
cp "$F" /tmp/escrow.orig.rs
run() {
  local name="$1" from="$2" to="$3"
  cp /tmp/escrow.orig.rs "$F"
  FROM="$from" TO="$to" python3 - "$F" <<'PY'
import os,sys
p=sys.argv[1]; s=open(p,encoding='utf-8').read()
a=os.environ['FROM']; b=os.environ['TO']
assert s.count(a)>=1, "mutation target missing: "+a
open(p,'w',encoding='utf-8').write(s.replace(a,b,1))
PY
  [ $? -eq 0 ] || { echo "SKIP      $name (target missing)"; return; }
  local fails=0 s
  for s in escrow escrowprobe linkclaim claim; do
    if ! cargo test --target-dir ~/ootle-target-skydrop -p tari_engine --test $s --release -- --test-threads=1 2>&1 | grep -q 'test result: ok'; then fails=1; break; fi
  done
  if [ $fails = 1 ]; then echo "caught    $name (in $s)"; else echo "SURVIVED  $name"; fi
}
run "policy can release others' deposits" 'let dep = list.get(index as usize).cloned().expect("no such deposit");
            assert!(dep.3 == policy, "that deposit is governed by another policy");
            list.remove(index as usize);' 'let dep = list.get(index as usize).cloned().expect("no such deposit");
            list.remove(index as usize);'
run "policy can return others' deposits" 'let (mut list, mut owed) = self.read(&account_id);
            let dep = list.get(index as usize).cloned().expect("no such deposit");
            assert!(dep.3 == policy, "that deposit is governed by another policy");
            let took' 'let (mut list, mut owed) = self.read(&account_id);
            let dep = list.get(index as usize).cloned().expect("no such deposit");
            let took'
run "anyone can refund"              'require_signer(dep.0);
            assert!(Consensus' 'assert!(Consensus'
run "refund any time"                'assert!(Consensus::current_epoch() >= dep.2, "not refundable yet");' ''
run "returned stays under its policy" 'list[index as usize] = (dep.0, back, Consensus::current_epoch(), me, Bytes::from_vec(vec![]), dep.5);' 'let _ = me; list[index as usize] = (dep.0, back, Consensus::current_epoch(), dep.3, Bytes::from_vec(vec![]), dep.5);'
run "returned not refundable yet"    'list[index as usize] = (dep.0, back, Consensus::current_epoch(), me,' 'list[index as usize] = (dep.0, back, dep.2, me,'
run "returned money backs fees"      'list.iter().filter(|d| d.3 != me).fold(Amount::zero(), |a, e| a + e.1);' '{ let _ = me; list.iter().fold(Amount::zero(), |a, e| a + e.1) };'
run "returned repays fees twice"     'let took = if dep.3 == me { Amount::zero() } else { self.reimburse(&mut owed, dep.1) };' 'let _ = me; let took = self.reimburse(&mut owed, dep.1);'
run "ledger vault never rotates"     'if self.ledger_vault_count >= self.ledger_vault_size {' 'if false {'
run "ledger id ignores account"      'NonFungibleId::from_u256(Sha256::digest(account_id.as_bytes()).into())' '{ let _ = account_id; let _ = Sha256::digest(b"x"); NonFungibleId::from_u32(1) }'
# Not listed: removing .withdrawable(deny_all) on ledgers can't be observed, since ledgers sit in vaults only this
# component holds and it has no method that withdraws them. The rule stays as defence in depth.
run "no vault size limit"            'assert!(ledger_vault_size >= 1 && ledger_vault_size <= MAX_LEDGER_VAULT_SIZE, "ledger vault size out of range");' ''
run "no minimum deposit"             'assert!(amount >= self.min_deposit, "deposit below the minimum");' ''
run "no per-policy lane"             'assert!(list.iter().filter(|d| d.3 == policy).count() < MAX_DEPOSITS_PER_POLICY, "too many deposits for this account");' ''
run "fees not repaid on release"     'let took = self.reimburse(&mut owed, dep.1);
            self.write(account_id, &(list, owed));' 'let took = Amount::zero();
            self.write(account_id, &(list, owed));'
cp /tmp/escrow.orig.rs "$F"
