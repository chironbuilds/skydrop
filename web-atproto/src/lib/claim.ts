/** Works out what `did` needs to do next to collect from a live campaign, and builds the transaction when it's ready.
 * Reads Bluesky and the chain; signs nothing. Shared by both sites. */
import { parseAtUri } from "./atproto";
import { bindCode, buildAllocationTree, claimCode, fromHex, RULES, type Allocation, type Rule } from "./campaign";
import { checkRule, identity, type RuleResult } from "./check";
import { asInputs, bindInstruction, claimInputs, claimInstruction, claimLinkedInstruction, claimRoundInstruction, hasRegistryRecord, linkInputs, openAccountInstruction, phaseOf, readLink, readReceipt, usableReferrer, type ChainCampaign, type ClaimProofs, type Instruction, type Receipt, type RecordProof, type SubstateInput } from "./chain";

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
  | { kind: "ready"; instructions: Instruction[]; inputs: SubstateInput[]; amount: bigint; round: number; bytes: number; account: string; referrer: string | null; linked: boolean };

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

export interface ClaimOptions {
  allocations?: Allocation[];
  /** Who invited this person. Dropped if naming them wouldn't work. */
  ref?: string | null;
  /** Pay the connected wallet with a claim post, even if a different wallet is linked. */
  ignoreLink?: boolean;
}

export async function planClaim(c: ChainCampaign, did: string, walletKey: string, walletAccount: string, { allocations, ref, ignoreLink }: ClaimOptions = {}): Promise<ClaimPlan> {
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

  // Vouches come with their identity logs, whichever way this is paid.
  const vouchOps: Uint8Array[][] = [];
  const dids = new Set<string>([did]);
  for (let i = 0; i < chosen.length; i++) {
    const voucher = chosen[i] ? voucherOf(c.rules[i]!) : null;
    if (!voucher) continue;
    vouchOps.push((await identity(voucher)).ops);
    dids.add(voucher);
  }
  // Claims read each account's record in the registry, which has no "if it exists" check, so missing ones are opened first.
  const opens = async (): Promise<Instruction[]> => (await Promise.all([...dids].map(async (d) => ((await hasRegistryRecord(d, c.linkRegistry)) ? null : openAccountInstruction(d, c.linkRegistry))))).filter((x): x is Instruction => !!x);
  const ruleProofs = { did, ops: me.ops, proofs: chosen.map((r) => (r ? asProof(r) : null)), vouchOps, amount, path };
  const ruleBytes = chosen.reduce((n, r) => n + (r?.bytes ?? 0), 0);

  // A linked account's first claim needs no post: the link already says where it's paid. Later rounds still need one.
  if (!receipt && !ignoreLink) {
    const link = await readLink(did, c.epoch, c.linkRegistry);
    const linked = link?.active;
    if (linked) {
      // The contract only lets the linked wallet name a referrer, so nobody else can claim for an account and name themselves.
      const referrer = link.owner === walletKey ? await usableReferrer(c, did, ref, pay) : null;
      return {
        kind: "ready",
        instructions: [...(await opens()), claimLinkedInstruction(c.component, ruleProofs, referrer?.did ?? null)],
        inputs: await claimInputs(c, [...dids], null, referrer, linked),
        amount: pay, round: 0, bytes: ruleBytes, account: linked, referrer: referrer?.did ?? null, linked: true,
      };
    }
  }

  const round = receipt?.roundsPaid ?? 0;
  const code = await claimCode(c.component, did, fromHex(walletKey), round);
  const posted = await checkRule({ kind: 3, target: code }, me);
  if (posted.status !== "met") {
    return { kind: "post", code, round, receipt, text: `Claiming my Skydrop reward. ${code}` };
  }

  const proofs: ClaimProofs = { ...ruleProofs, code: asProof(posted) };
  // Only a first claim can name a referrer: later rounds have already been counted.
  const referrer = receipt ? null : await usableReferrer(c, did, ref, pay);
  const claim = receipt ? claimRoundInstruction(c.component, proofs, walletKey) : claimInstruction(c.component, proofs, walletKey, walletAccount, referrer?.did ?? null);
  // A later round pays the account on the receipt, which needn't be the connected wallet's, so it's named up front.
  const inputs = await claimInputs(c, [...dids], receipt ? did : null, referrer, receipt?.account ?? null);
  return { kind: "ready", instructions: [...(await opens()), claim], inputs, amount: pay, round, bytes: ruleBytes + (posted.bytes ?? 0), account: receipt?.account ?? walletAccount, referrer: referrer?.did ?? null, linked: false };
}

export type ReadyPlan = Extract<ClaimPlan, { kind: "ready" }>;

/**
 * How many claims go in one transaction. Run live with five, through a link. A claim post can carry this many codes
 * and stay under Bluesky's 300 characters.
 */
export const BATCH_MAX = 5;

/** Several claims as one transaction: the same accounts are opened once, and each substate is named once. */
export function mergePlans(plans: ReadyPlan[]): { instructions: Instruction[]; inputs: SubstateInput[]; amount: bigint } {
  const seen = new Set<string>();
  const instructions = plans.flatMap((p) => p.instructions).filter((ins) => {
    const key = JSON.stringify(ins);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { instructions, inputs: asInputs(plans.flatMap((p) => p.inputs.map((x) => x.substate_id))), amount: plans.reduce((n, p) => n + p.amount, 0n) };
}

/** One post can prove several claims: the contract only checks that it contains each campaign's code. */
export const batchPostText = (codes: string[]): string => `Claiming my Skydrop rewards. ${codes.join(" ")}`;

export type LinkPlan =
  | { kind: "post"; code: string; text: string }
  | { kind: "ready"; instructions: Instruction[]; inputs: SubstateInput[] };

/** What's needed to link `did` to this wallet: the post, then the transaction. Reads Bluesky and the chain; signs nothing. */
export async function planLink(did: string, walletKey: string, walletAccount: string, registry: string): Promise<LinkPlan> {
  const code = await bindCode(registry, did, walletAccount, fromHex(walletKey));
  const me = await identity(did);
  const posted = await checkRule({ kind: 3, target: code }, me);
  if (posted.status !== "met") return { kind: "post", code, text: `Linking my wallet for Skydrop rewards. ${code}` };
  const bind = bindInstruction(registry, did, walletAccount, walletKey, me.ops, asProof(posted));
  const open = (await hasRegistryRecord(did, registry)) ? [] : [openAccountInstruction(did, registry)];
  return { kind: "ready", instructions: [...open, bind], inputs: await linkInputs(registry, did, walletAccount) };
}

/** Upper limit on a claim's fee: the wallet is only charged what it really costs. A one-step claim measured 0.04 tTARI. */
export const CLAIM_MAX_FEE = 2_000_000n;
export const LINK_MAX_FEE = 1_000_000n;
/** Measured live: two links came to 0.0198 and 0.0199 tTARI. A claim through a link then costs about 0.012 less. */
export const LINK_FEE = 20_000n;
/** A linked claim proves one record fewer. Measured on a one-step claim: 0.0223 tTARI against 0.0337. Kept round, like the estimate it's taken from. */
export const LINKED_CLAIM_SAVING = 10_000n;
