/** Works out what `did` needs to do next to collect from a live campaign, and builds the transaction when it's ready.
 * Reads Bluesky and the chain; signs nothing. Shared by both sites. */
import { parseAtUri } from "./atproto";
import { buildAllocationTree, claimCode, fromHex, RULES, type Allocation, type Rule } from "./campaign";
import { checkRule, identity, type RuleResult } from "./check";
import { claimInputs, claimInstruction, claimRoundInstruction, hasRegistryRecord, openAccountInstruction, phaseOf, readReceipt, type ChainCampaign, type ClaimProofs, type Instruction, type Receipt, type RecordProof, type SubstateInput } from "./chain";

export type ClaimPlan =
  | { kind: "closed" }
  | { kind: "upcoming"; opensAt: number }
  | { kind: "empty" }
  | { kind: "done"; receipt: Receipt }
  | { kind: "wait"; receipt: Receipt; opensAt: number }
  | { kind: "not-listed" }
  | { kind: "bad-list" }
  | { kind: "steps"; results: RuleResult[] }
  | { kind: "post"; code: string; text: string; round: number; receipt: Receipt | null }
  | { kind: "ready"; instructions: Instruction[]; inputs: SubstateInput[]; amount: bigint; round: number; bytes: number; account: string };

/** Who a rule's proof comes from, if not the claimant: the voucher whose identity log has to come with it. */
function voucherOf(rule: Rule): string | null {
  if (RULES[rule.kind]?.side !== "voucher") return null;
  return rule.kind === 6 ? (parseAtUri(rule.target)?.did ?? null) : rule.target;
}

function asProof(r: RuleResult): RecordProof {
  const at = r.uri ? parseAtUri(r.uri) : null;
  if (!r.proof || !at) throw new Error("A proof is missing its record address.");
  return { commit: r.proof.commit, nodes: r.proof.nodes, record: r.proof.record, rkey: at.rkey };
}

export async function planClaim(c: ChainCampaign, did: string, walletKey: string, walletAccount: string, allocations?: Allocation[]): Promise<ClaimPlan> {
  const receipt = await readReceipt(c, did);
  if (receipt && receipt.roundsPaid >= c.rounds) return { kind: "done", receipt };
  const phase = phaseOf(c);
  if (phase === "closed") return { kind: "closed" };
  if (phase === "upcoming") return { kind: "upcoming", opensAt: c.openEpoch };
  if (receipt && c.epoch < receipt.lastEpoch + c.roundEpochs) return { kind: "wait", receipt, opensAt: receipt.lastEpoch + c.roundEpochs };

  let amount = 0n;
  let path: string[] = [];
  let pay = c.reward;
  if (c.root) {
    if (!allocations?.length) return { kind: "bad-list" };
    const tree = await buildAllocationTree(allocations);
    if (tree.root !== c.root) return { kind: "bad-list" };
    const mine = tree.proofs[did];
    if (!mine) return { kind: "not-listed" };
    amount = BigInt(mine.amount);
    path = mine.path;
    pay = amount;
  }
  if (c.balance < pay) return { kind: "empty" };

  const me = await identity(did);
  const results = await Promise.all(c.rules.map((r) => checkRule(r, me)));
  // One proof per requirement: the first met member of an either/or group, nothing for the rest.
  const usedGroups = new Set<number>();
  const chosen = results.map((r, i) => {
    const group = c.groups[i] ?? 0;
    if (r.status !== "met" || (group && usedGroups.has(group))) return null;
    if (group) usedGroups.add(group);
    return r;
  });
  const missing = c.groups.some((g, i) => (g === 0 ? !chosen[i] : !usedGroups.has(g)));
  if (missing) return { kind: "steps", results };

  const round = receipt?.roundsPaid ?? 0;
  const code = await claimCode(c.component, did, fromHex(walletKey), round);
  const posted = await checkRule({ kind: 3, target: code }, me);
  if (posted.status !== "met") {
    return { kind: "post", code, round, receipt, text: `Claiming my reward from ${c.name}. ${code}` };
  }

  const proofs: ClaimProofs = {
    did,
    ops: me.ops,
    proofs: chosen.map((r) => (r ? asProof(r) : null)),
    vouchOps: [],
    code: asProof(posted),
    amount,
    path,
  };
  const dids = new Set<string>([did]);
  for (let i = 0; i < chosen.length; i++) {
    const voucher = chosen[i] ? voucherOf(c.rules[i]!) : null;
    if (!voucher) continue;
    proofs.vouchOps.push((await identity(voucher)).ops);
    dids.add(voucher);
  }
  // Claims read each account's record in the registry, which has no "if it exists" check, so missing ones are opened first.
  const open = await Promise.all([...dids].map(async (d) => ((await hasRegistryRecord(d, c.linkRegistry)) ? null : openAccountInstruction(d, c.linkRegistry))));
  const claim = receipt ? claimRoundInstruction(c.component, proofs, walletKey) : claimInstruction(c.component, proofs, walletKey, walletAccount);
  const bytes = chosen.reduce((n, r) => n + (r?.bytes ?? 0), posted.bytes ?? 0);
  const inputs = await claimInputs(c, [...dids], receipt ? did : null);
  return { kind: "ready", instructions: [...open.filter((x): x is Instruction => !!x), claim], inputs, amount: pay, round, bytes, account: receipt?.account ?? walletAccount };
}

/** Upper limit on a claim's fee: the wallet is only charged what it really costs. A one-step claim measured 0.04 tTARI. */
export const CLAIM_MAX_FEE = 2_000_000n;
