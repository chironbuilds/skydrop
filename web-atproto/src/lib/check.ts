/** Runs a campaign's rules against a real account: finds each record, fetches its proof and verifies it with the
 * same code the contract runs. Read-only: nothing is signed or submitted. */
import { decodeRecord, encodeOps, fetchProof, findInRepo, followUri, parseAtUri, pdsOf, plcLog, type RepoProof } from "./atproto";
import { RULES, type Rule } from "./campaign";
import { explain, fieldStr, verifyChain, verifyRecord, type ChainResult } from "./verify";

export interface RuleResult {
  rule: Rule;
  status: "met" | "unmet" | "error";
  detail: string;
  uri?: string;
  proof?: RepoProof;
  /** Bytes the proof adds to a claim transaction. */
  bytes?: number;
}

export interface Identity { did: string; ops: Uint8Array[]; chain: ChainResult; pds: string }

const identities = new Map<string, Promise<Identity>>();

export function identity(did: string): Promise<Identity> {
  let p = identities.get(did);
  if (!p) {
    p = (async () => {
      const log = await plcLog(did);
      const ops = encodeOps(log);
      const chain = await verifyChain(did, ops);
      if (!chain.ok) throw new Error(`The identity log failed verification: ${explain(chain)}`);
      if (ops.length > 16) throw new Error(`This account has ${ops.length} identity operations; contracts accept at most 16.`);
      return { did, ops, chain, pds: pdsOf(log) };
    })();
    p.catch(() => identities.delete(did));
    identities.set(did, p);
  }
  return p;
}

const subjectUri = (v: Record<string, unknown>): string | undefined => (v.subject as { uri?: string } | undefined)?.uri;
const nested = (v: unknown, ...path: string[]): unknown => path.reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), v);

const says = (v: Record<string, unknown>, text?: string): boolean => !text || (typeof v.text === "string" && v.text.includes(text));

/** How each rule's record is found. Off-chain convenience only: the proof below is what counts. */
async function locate(rule: Rule, me: Identity): Promise<{ repo: Identity; uri: string } | null> {
  const def = RULES[rule.kind]!;
  const t = rule.target;
  const search = async (repo: Identity, match: (v: Record<string, unknown>) => boolean) => {
    const hit = await findInRepo(repo.pds, repo.did, def.collection, match);
    return hit ? { repo, uri: hit.uri } : null;
  };
  switch (rule.kind) {
    case 0:
    case 1:
      return search(me, (v) => subjectUri(v) === t);
    case 2: {
      const uri = await followUri(me.did, t);
      return uri ? { repo: me, uri } : search(me, (v) => v.subject === t);
    }
    case 3:
      return search(me, (v) => typeof v.text === "string" && v.text.includes(t));
    case 4:
      return search(me, (v) => (nested(v, "reply", "parent", "uri") === t || nested(v, "reply", "root", "uri") === t) && says(v, rule.text));
    case 5:
      return search(me, (v) => (nested(v, "embed", "record", "uri") === t || nested(v, "embed", "record", "record", "uri") === t) && says(v, rule.text));
    case 6: {
      const owner = parseAtUri(t)?.did;
      if (!owner) return null;
      const repo = await identity(owner);
      return search(repo, (v) => v.subject === me.did && v.list === t);
    }
    case 7: {
      const repo = await identity(t);
      const uri = await followUri(t, me.did);
      return uri ? { repo, uri } : search(repo, (v) => v.subject === me.did);
    }
    case 8: {
      const repo = await identity(t);
      return search(repo, (v) => v.subject === me.did);
    }
  }
}

/** The same field test verify_rules applies in the contract, run on the proven bytes. */
export async function satisfies(rule: Rule, record: Uint8Array, did: string): Promise<boolean> {
  const t = rule.target;
  const eq = async (...path: string[]) => (await fieldStr(record, path)) === t;
  const worded = async () => !rule.text || ((await fieldStr(record, ["text"])) ?? "").includes(rule.text);
  switch (rule.kind) {
    case 0:
    case 1:
      return eq("subject", "uri");
    case 2:
      return eq("subject");
    case 3:
      return ((await fieldStr(record, ["text"])) ?? "").includes(t);
    case 4:
      return ((await eq("reply", "parent", "uri")) || (await eq("reply", "root", "uri"))) && worded();
    case 5:
      return ((await eq("embed", "record", "uri")) || (await eq("embed", "record", "record", "uri"))) && worded();
    case 6:
      return (await fieldStr(record, ["subject"])) === did && (await eq("list"));
    case 7:
    case 8:
      return (await fieldStr(record, ["subject"])) === did;
  }
}

export async function checkRule(rule: Rule, me: Identity): Promise<RuleResult> {
  try {
    const found = await locate(rule, me);
    if (!found) return { rule, status: "unmet", detail: RULES[rule.kind]!.side === "voucher" ? "No such record in the voucher's repo." : "No matching record found in this account's recent activity." };
    const at = parseAtUri(found.uri);
    if (!at) return { rule, status: "error", detail: "The record has an unexpected address." };
    const proof = await fetchProof(found.repo.pds, found.repo.did, at.collection, at.rkey);
    const verified = await verifyRecord(found.repo.did, found.repo.chain, proof, at.collection, at.rkey);
    if (!verified.ok) return { rule, status: "error", detail: `The record failed verification: ${explain(verified)}` };
    if (!(await satisfies(rule, proof.record, me.did))) return { rule, status: "unmet", detail: "A record was found, but its signed bytes don't satisfy the rule." };
    if (rule.snapshot && RULES[rule.kind]!.side === "voucher" && verified.rev < rule.snapshot) return { rule, status: "unmet", detail: "The voucher's newest commit predates the campaign's snapshot." };
    const bytes = proof.commit.length + proof.record.length + proof.nodes.reduce((n, x) => n + x.length, 0);
    return { rule, status: "met", detail: "Verified against the signed repo.", uri: found.uri, proof, bytes };
  } catch (e) {
    return { rule, status: "error", detail: (e as Error).message };
  }
}

export const recordPreview = (bytes: Uint8Array): Record<string, unknown> => decodeRecord(bytes);
