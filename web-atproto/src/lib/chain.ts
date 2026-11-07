/**
 * Talks to the Campaign contract: builds its transactions as plain instructions for a wallet to sign, and reads its
 * state straight from the indexer. No keys and no WASM SDK here. Argument and state layouts mirror campaigns/src/lib.rs.
 *
 * What a page shows about a live campaign comes from the chain, never from a link: a link only names the component, and
 * a component built from any other template is refused.
 */
import { DEPLOYMENT } from "../data/deployment";
import { createArgs, EPOCHS_PER_DAY, fromHex, toHex, type Rule, type Spec } from "./campaign";

export const TARI_RESOURCE = "resource_0101010101010101010101010101010101010101010101010101010101010101";

// ---- CBOR, as the engine encodes template arguments and substates -------------------------------------------

class Tagged {
  constructor(readonly tag: number, readonly value: unknown) {}
}

type Enc = null | number | bigint | string | Uint8Array | Tagged | Enc[];

function head(major: number, n: number | bigint, out: number[]): void {
  const v = BigInt(n);
  const m = major << 5;
  if (v < 24n) out.push(m | Number(v));
  else if (v < 0x100n) out.push(m | 24, Number(v));
  else if (v < 0x10000n) out.push(m | 25, Number(v >> 8n), Number(v & 0xffn));
  else if (v < 0x100000000n) out.push(m | 26, ...[24n, 16n, 8n, 0n].map((s) => Number((v >> s) & 0xffn)));
  else out.push(m | 27, ...[56n, 48n, 40n, 32n, 24n, 16n, 8n, 0n].map((s) => Number((v >> s) & 0xffn)));
}

function encodeInto(v: Enc, out: number[]): void {
  if (v === null) out.push(0xf6);
  else if (typeof v === "number" || typeof v === "bigint") head(0, v, out);
  else if (typeof v === "string") {
    const b = new TextEncoder().encode(v);
    head(3, b.length, out);
    for (const x of b) out.push(x);
  } else if (v instanceof Uint8Array) {
    head(2, v.length, out);
    for (const x of v) out.push(x);
  } else if (v instanceof Tagged) {
    head(6, v.tag, out);
    encodeInto(v.value as Enc, out);
  } else {
    head(4, v.length, out);
    for (const item of v) encodeInto(item, out);
  }
}

export function lit(v: Enc): { Literal: string } {
  const out: number[] = [];
  encodeInto(v, out);
  return { Literal: toHex(Uint8Array.from(out)) };
}

const TAG_COMPONENT = 128;

const hexOf = (address: string): string => address.slice(address.lastIndexOf("_") + 1);
const componentArg = (address: string): Tagged => new Tagged(TAG_COMPONENT, fromHex(hexOf(address)));

class Reader {
  off = 0;
  constructor(readonly b: Uint8Array) {}
  private uint(info: number): number | bigint {
    if (info < 24) return info;
    const n = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
    if (!n) throw new Error("Unsupported CBOR length");
    let v = 0n;
    for (let i = 0; i < n; i++) v = (v << 8n) | BigInt(this.b[this.off++]!);
    return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
  }
  read(): unknown {
    const first = this.b[this.off++];
    if (first === undefined) throw new Error("Truncated CBOR");
    const major = first >> 5;
    const info = first & 31;
    switch (major) {
      case 0:
        return this.uint(info);
      case 1: {
        const n = this.uint(info);
        return typeof n === "bigint" ? -1n - n : -1 - n;
      }
      case 2:
      case 3: {
        const n = Number(this.uint(info));
        const s = this.b.slice(this.off, this.off + n);
        this.off += n;
        return major === 2 ? s : new TextDecoder().decode(s);
      }
      case 4: {
        const n = Number(this.uint(info));
        return Array.from({ length: n }, () => this.read());
      }
      case 5: {
        const n = Number(this.uint(info));
        const m = new Map<unknown, unknown>();
        for (let i = 0; i < n; i++) {
          const k = this.read();
          m.set(k, this.read());
        }
        return m;
      }
      case 6: {
        const tag = Number(this.uint(info));
        return new Tagged(tag, this.read());
      }
      default:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22 || info === 23) return null;
        throw new Error("Unsupported CBOR value");
    }
  }
}

const decodeB64 = (s: string): unknown => new Reader(Uint8Array.from(atob(s), (c) => c.charCodeAt(0))).read();

const asHex = (v: unknown): string => {
  const x = v instanceof Tagged ? v.value : v;
  if (x instanceof Uint8Array) return toHex(x);
  if (Array.isArray(x)) return toHex(Uint8Array.from(x as number[]));
  throw new Error("Expected bytes in contract state");
};
const asBig = (v: unknown): bigint => (typeof v === "bigint" ? v : BigInt(v as number));
const asNum = (v: unknown): number => Number(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// ---- reads ---------------------------------------------------------------------------------------------------

async function getJson(path: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${DEPLOYMENT.indexer}${path}`, { signal: AbortSignal.timeout(20_000) });
  if (r.status === 404) return { status: 404, body: null };
  if (!r.ok) throw new Error(`The network answered ${r.status}`);
  return { status: r.status, body: await r.json() };
}

/** A substate's decoded value, or null if it doesn't exist or has been spent. */
export async function readSubstate(id: string): Promise<unknown | null> {
  const { body } = await getJson(`/substates/${id}`);
  const up = body?.state?.up?.substate;
  return typeof up === "string" ? decodeB64(up) : null;
}

export async function currentEpoch(): Promise<number> {
  const { body } = await getJson("/health");
  if (typeof body?.current_epoch !== "number") throw new Error("The network didn't report its epoch");
  return body.current_epoch;
}

const sha256 = async (data: Uint8Array): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.digest("SHA-256", data));
const nftId = async (resourceHex: string, did: string): Promise<string> => `nft_${resourceHex}_uuid_${toHex(await sha256(new TextEncoder().encode(did)))}`;

/** A component as [template hex, state fields]. Null if there is no such component. */
async function readComponent(address: string): Promise<{ template: string; state: unknown[] } | null> {
  const v = await readSubstate(address);
  if (!v) return null;
  const comp = list(list(v)[1])[0];
  const [header, body] = list(comp);
  const state = list(list(body)[0]);
  return { template: asHex(list(header)[0]), state };
}

/** What a fungible vault holds, and how much of it is spendable. Revealed funds are the only kind the Campaign contract holds. */
async function readVault(vault: string): Promise<{ resource: string; balance: bigint }> {
  const v = await readSubstate(vault);
  if (!v) throw new Error("The campaign's vault couldn't be read");
  const container = list(list(list(v)[1])[0])[0];
  const fields = list(list(container)[1]);
  return { resource: `resource_${asHex(fields[0])}`, balance: asBig(fields[1]) };
}

export const vaultBalance = async (vault: string): Promise<bigint> => (await readVault(vault)).balance;

export interface ChainCampaign {
  component: string;
  name: string;
  info: string;
  funder: string;
  vault: string;
  receipts: string;
  linkRegistry: string;
  /** Made with a contract from before the 2026-11-07 security fixes. */
  legacy: boolean;
  rules: Rule[];
  groups: number[];
  reward: bigint;
  root: string;
  rounds: number;
  roundEpochs: number;
  bonus: bigint;
  maxReferrals: number;
  openEpoch: number;
  closeEpoch: number;
  claimants: number;
  payments: number;
  paid: bigint;
  balance: bigint;
  epoch: number;
}

export type CampaignPhase = "upcoming" | "open" | "closed";
export const phaseOf = (c: ChainCampaign): CampaignPhase => (c.epoch < c.openEpoch ? "upcoming" : c.epoch < c.closeEpoch ? "open" : "closed");

export const isComponent = (s: string): boolean => /^component_[0-9a-f]{64}$/.test(s);

/**
 * Reads a live campaign, refusing anything that wasn't built from the published Campaign template. It also refuses two
 * things the contract itself allows. A campaign can be funded with any token, and these sites call every reward tTARI.
 * Its creator also picks the registry it calls, so a registry of their own could send linked claims anywhere or fail them.
 */
export async function readCampaign(component: string): Promise<ChainCampaign> {
  if (!isComponent(component)) throw new Error("That isn't a campaign address.");
  const comp = await readComponent(component);
  if (!comp) throw new Error("There's no campaign at that address.");
  const legacy = DEPLOYMENT.legacy.find((x) => hexOf(x.campaignTemplate) === comp.template);
  if (comp.template !== hexOf(DEPLOYMENT.campaignTemplate) && !legacy) throw new Error("That address isn't a campaign made with this contract, so it isn't shown.");
  const s = comp.state;
  const kinds = list(s[7]).map(asNum);
  const targets = list(s[8]) as string[];
  const snapshots = list(s[9]).map(asNum);
  const texts = list(s[10]) as string[];
  const groups = list(s[11]).map(asNum);
  const rules: Rule[] = kinds.map((kind, i) => ({
    kind: kind as Rule["kind"],
    target: targets[i]!,
    ...(snapshots[i] ? { snapshot: snapshots[i] } : {}),
    ...(texts[i] ? { text: texts[i] } : {}),
    ...(i > 0 && groups[i] !== 0 && groups[i] === groups[i - 1] ? { or: true } : {}),
  }));
  const vault = `vault_${asHex(s[3])}`;
  const linkRegistry = `component_${asHex(s[6])}`;
  if (linkRegistry !== (legacy?.linkRegistry ?? DEPLOYMENT.linkRegistry)) throw new Error("That campaign uses a different link registry from these sites, so it isn't shown.");
  const [{ resource, balance }, epoch] = await Promise.all([readVault(vault), currentEpoch()]);
  if (resource !== TARI_RESOURCE) throw new Error("That campaign pays in a token other than tTARI, so it isn't shown.");
  return {
    component,
    name: s[0] as string,
    info: s[1] as string,
    funder: asHex(s[2]),
    vault,
    receipts: asHex(s[4]),
    linkRegistry,
    legacy: !!legacy,
    rules,
    groups,
    reward: asBig(s[12]),
    root: asHex(s[13]),
    rounds: asNum(s[14]),
    roundEpochs: asNum(s[15]),
    bonus: asBig(s[16]),
    maxReferrals: asNum(s[17]),
    openEpoch: asNum(s[18]),
    closeEpoch: asNum(s[19]),
    claimants: asNum(s[20]),
    payments: asNum(s[21]),
    paid: asBig(s[22]),
    balance,
    epoch,
  };
}

/** A live campaign as a Spec, so the pages that show specs can show it. Terms come from the chain; only an allocation
 * list, which the chain holds just the root of, can come from elsewhere. */
export function specOf(c: ChainCampaign, allocations?: Spec["allocations"]): Spec {
  return {
    v: 1,
    name: c.name,
    about: c.info,
    rules: c.rules,
    reward: c.reward.toString(),
    budget: (c.balance + c.paid).toString(),
    rounds: c.rounds,
    roundDays: c.roundEpochs / EPOCHS_PER_DAY,
    bonus: c.bonus.toString(),
    maxReferrals: c.maxReferrals,
    startsInDays: 0,
    days: (c.closeEpoch - c.openEpoch) / EPOCHS_PER_DAY,
    ...(c.root ? { root: c.root, allocations } : {}),
    component: c.component,
  };
}

export interface Receipt {
  account: string;
  roundsPaid: number;
  lastEpoch: number;
  lastRev: bigint;
  referrals: number;
}

/** What `did` has been paid by a campaign so far, or null if it hasn't claimed. */
export async function readReceipt(c: Pick<ChainCampaign, "receipts">, did: string): Promise<Receipt | null> {
  const v = await readSubstate(await nftId(c.receipts, did));
  if (!v) return null;
  const nft = list(list(v)[1])[0];
  const [data, mutable] = list(nft);
  const immutable = list(data);
  const state = list(mutable);
  return { account: `component_${asHex(immutable[1])}`, roundsPaid: asNum(state[0]), lastEpoch: asNum(state[1]), lastRev: asBig(state[2]), referrals: asNum(state[3]) };
}

/** Whether a DID already has its record in the LinkRegistry. Claims read it, so one must exist first. */
export async function hasRegistryRecord(did: string, registry: string = DEPLOYMENT.linkRegistry): Promise<boolean> {
  const reg = await readComponent(registry);
  if (!reg) throw new Error("The link registry couldn't be read.");
  return (await readSubstate(await nftId(asHex(reg.state[1]), did))) !== null;
}

export interface WalletLink {
  /** Where payouts go now, if anywhere. */
  active: string | null;
  /** The key that owns that wallet. Only it can name a referrer on a claim made through the link. */
  owner: string | null;
  /** The wallet taking over, and the epoch it does, if a change is waiting. */
  next: { account: string; since: number } | null;
}

/** The wallet `did` has linked, as the registry would answer at `epoch`. Null if it has no record or no link. */
export async function readLink(did: string, epoch: number, registry: string = DEPLOYMENT.linkRegistry): Promise<WalletLink | null> {
  const reg = await readComponent(registry);
  if (!reg) throw new Error("The link registry couldn't be read.");
  const v = await readSubstate(await nftId(asHex(reg.state[1]), did));
  if (!v) return null;
  const [, mutable] = list(list(list(v)[1])[0]);
  const binding = list(mutable)[0];
  if (!Array.isArray(binding)) return null;
  const account = `component_${asHex(binding[0])}`;
  const since = asNum(binding[1]);
  const old = `component_${asHex(binding[2])}`;
  if (epoch >= since) return { active: account, owner: asHex(binding[3]), next: null };
  return { active: old === registry ? null : old, owner: old === registry ? null : asHex(binding[4]), next: { account, since } };
}

const REASONS: [RegExp, string][] = [
  [/uses the V1 layout|Failed to load template/i, "This campaign was made before the Ootle 0.50 network upgrade. Its contract no longer runs, so it can't pay out."],
  [/does not contain the bind code/i, "That post doesn't contain this wallet's link code."],
  [/already used to bind/i, "That post has already been used. Write a new one."],
  [/standard Tari account can be linked/i, "Only a standard Tari account can be linked."],
  [/has not linked a wallet/i, "This account hasn't linked a wallet."],
  [/does not contain the claim code/i, "That post doesn't contain this claim's code."],
  [/campaign has closed/i, "This campaign has closed."],
  [/has not opened yet/i, "This campaign hasn't opened yet. If it's due now, try again in a minute or two: the network can lag behind for a moment."],
  [/pool is exhausted/i, "This campaign's pool has run out."],
  [/used all its referrals/i, "Whoever invited you has used all their invites."],
  [/cannot refer itself/i, "You can't invite yourself."],
  [/round is not open yet/i, "The next round hasn't opened yet. If it's due now, try again in a minute or two: the network can lag behind for a moment."],
  [/every round has been paid/i, "Every round has already been paid."],
  [/not newer than the last round/i, "These proofs aren't newer than your last round. Post the new code, then try again."],
  [/does not satisfy its campaign rule/i, "One of your records doesn't meet its step any more."],
  [/required step has no proof|either\/or step has no proof/i, "A step is missing its proof."],
  [/stale operation chain/i, "This account's identity log doesn't match the one already seen on the network. Refresh and try again. If it keeps happening, the account's keys may have been misused."],
  [/not newer than the last round/i, "A voucher hasn't posted anything since your last round, so their vouch can't be shown to still stand. Try again once they have."],
  [/not on the allocation list/i, "This account isn't on the allocation list for that amount."],
  [/predates the campaign's snapshot/i, "A voucher's record predates this campaign's snapshot."],
  [/has not closed yet/i, "This campaign hasn't closed yet, so its funds can't be taken back. If it's due now, try again in a minute or two: the network can lag behind for a moment."],
  [/close epoch can only move later/i, "The close date can only move later."],
  [/close epoch too far/i, "That's further ahead than the contract allows, which is about 833 days from now."],
  [/insufficient|not enough|exceeds/i, "Your wallet doesn't have enough tTARI for this."],
  [/already exists|duplicate|non.?fungible.*exist/i, "This account has already claimed this."],
];

/** The contract's words, or the network's, in plain language. */
export function explainChainError(raw: string): string {
  // A refused transaction comes as a long dump of state, with the contract's own words at the end.
  const said = [...raw.matchAll(/"message":"(?:At instruction #\d+: )?(?:Template error: )?((?:[^"\\]|\\.)*)"/g)].at(-1)?.[1];
  const text = said ?? raw;
  for (const [re, plain] of REASONS) if (re.test(text)) return plain;
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

/** The resource a vault holds. Contracts' badge resources are only named here, not in their own state. */
async function vaultResource(vault: string): Promise<string> {
  const v = await readSubstate(vault);
  if (!v) throw new Error("A vault couldn't be read");
  const container = list(list(list(v)[1])[0])[0];
  return `resource_${asHex(list(list(container)[1])[0])}`;
}

export interface SubstateInput { substate_id: string; version: null }
export const asInputs = (ids: string[]): SubstateInput[] => [...new Set(ids)].map((substate_id) => ({ substate_id, version: null }));

/**
 * Everything a claim touches. A wallet otherwise finds these one at a time by failing a real transaction, and each
 * failure costs a fee: measured live, about ten failures added 0.157 tTARI to a 0.04 tTARI claim.
 */
export async function claimInputs(c: ChainCampaign, dids: string[], receiptDid: string | null, referrer: Referrer | null = null, payTo: string | null = null): Promise<SubstateInput[]> {
  const campaign = await readComponent(c.component);
  if (!campaign) throw new Error("The campaign couldn't be read.");
  const mintBadge = `vault_${asHex(campaign.state[5])}`;
  return asInputs([
    c.component, c.vault, `resource_${c.receipts}`, mintBadge, await vaultResource(mintBadge),
    ...(await registryInputs(c.linkRegistry, dids)),
    ...(receiptDid ? [await nftId(c.receipts, receiptDid)] : []),
    ...(referrer ? [await nftId(c.receipts, referrer.did), ...(await accountInputs(referrer.account))] : []),
    ...(payTo ? await accountInputs(payTo, [TARI_RESOURCE, c.receipts]) : []),
  ]);
}

/** The registry and the records of each account that already has one. */
async function registryInputs(registry: string, dids: string[]): Promise<string[]> {
  const reg = await readComponent(registry);
  if (!reg) throw new Error("The link registry couldn't be read.");
  const records = asHex(reg.state[1]);
  const badge = `vault_${asHex(reg.state[2])}`;
  const vault = `vault_${asHex(reg.state[3])}`;
  const existing = await Promise.all(dids.map(async (d) => {
    const id = await nftId(records, d);
    return (await readSubstate(id)) ? id : null;
  }));
  return [registry, badge, vault, `resource_${records}`, await vaultResource(badge), ...existing.filter((x): x is string => !!x)];
}

/** Everything a link touches, including the account being linked, which the contract checks is a standard one. */
export async function linkInputs(registry: string, did: string, account: string): Promise<SubstateInput[]> {
  return asInputs([...(await registryInputs(registry, [did])), account]);
}

/** An account and its vaults for these resources, where it has them yet. A payment into another account has to name them up front. */
async function accountInputs(account: string, resources: string[] = [TARI_RESOURCE]): Promise<string[]> {
  const a = await readComponent(account);
  if (!a) throw new Error("A payout account couldn't be read.");
  const vaults = a.state[0];
  const wanted = new Set(resources.map(hexOf));
  const found: string[] = [];
  if (vaults instanceof Map) {
    for (const [resource, vault] of vaults) if (wanted.has(asHex(resource))) found.push(`vault_${asHex(vault)}`);
  }
  return [account, ...found];
}

export interface Referrer { did: string; account: string }

/**
 * The account to name as referrer, or null if naming it wouldn't work. The contract fails the whole claim on a bad
 * referrer, and a link can name anyone, so a link that can't pay must never cost the person following it their reward.
 */
export async function usableReferrer(c: ChainCampaign, did: string, ref: string | null | undefined, pay: bigint): Promise<Referrer | null> {
  if (!ref || ref === did || c.bonus <= 0n || c.balance < pay + c.bonus) return null;
  const receipt = await readReceipt(c, ref).catch(() => null);
  if (!receipt || receipt.referrals >= c.maxReferrals) return null;
  return { did: ref, account: receipt.account };
}

export type TxOutcome = { state: "accepted"; components: string[] } | { state: "rejected"; reason: string } | { state: "pending" };

const collectComponents = (v: unknown, out: Set<string>): void => {
  if (v instanceof Tagged) {
    if (v.tag === TAG_COMPONENT && v.value instanceof Uint8Array && v.value.length === 32) out.add(`component_${toHex(v.value)}`);
    else collectComponents(v.value, out);
  } else if (Array.isArray(v)) v.forEach((x) => collectComponents(x, out));
  else if (v instanceof Map) v.forEach((x) => collectComponents(x, out));
};

/** Whether a transaction landed, and which components it touched. */
export async function readOutcome(transactionId: string): Promise<TxOutcome> {
  const id = transactionId.replace(/^0x/, "");
  const { body } = await getJson(`/transactions/${id}/result`);
  const fin = body?.result?.Finalized;
  if (!fin) return { state: "pending" };
  // A transaction can be final ("Commit") and still have failed: it paid its fee and did nothing else. abort_details says so.
  if (fin.abort_details || fin.final_decision !== "Commit") return { state: "rejected", reason: explainChainError(JSON.stringify(fin.abort_details ?? fin.final_decision)) };
  const exec = typeof fin.execution_result === "string" ? decodeB64(fin.execution_result) : null;
  const found = new Set<string>();
  collectComponents(exec, found);
  return { state: "accepted", components: [...found] };
}

export async function waitForOutcome(transactionId: string, timeoutMs = 90_000): Promise<TxOutcome> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const o = await readOutcome(transactionId).catch((): TxOutcome => ({ state: "pending" }));
    if (o.state !== "pending" || Date.now() > end) return o;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

// ---- events ------------------------------------------------------------------------------------------------

interface ChainEvent { tx: string; template: string; fields: Map<string, string>; components: string[] }

/** Events by topic, newest first. A topic only names a module, which anyone can reuse, so callers check the template. */
async function readEvents(query: string): Promise<ChainEvent[]> {
  const { body } = await getJson(`/transactions/events?${query}`);
  const out: ChainEvent[] = [];
  for (const row of (body?.events ?? []) as [string, string][]) {
    try {
      const [substate, template, , payload] = list(decodeB64(row[1]));
      const map = payload instanceof Tagged ? payload.value : payload;
      const components = new Set<string>();
      collectComponents(substate, components);
      out.push({ tx: row[0], template: asHex(template), fields: map instanceof Map ? (map as Map<string, string>) : new Map(), components: [...components] });
    } catch {
      /* not an event this code understands */
    }
  }
  return out;
}

const fromCampaignTemplate = (e: ChainEvent): boolean => e.template === hexOf(DEPLOYMENT.campaignTemplate) || DEPLOYMENT.legacy.some((x) => hexOf(x.campaignTemplate) === e.template);

/**
 * Live campaigns, newest first, each read back from its contract. They're found from the creation events the engine
 * emits, which name the component and its template. Transaction results can't be used: the indexer stops serving them
 * within hours. The search looks through recent events only, so a very old campaign can drop out of it.
 */
export async function listCampaigns(limit = 1000, max = 30): Promise<ChainCampaign[]> {
  const events = await readEvents(`topic=${encodeURIComponent("std.component.created")}&limit=${limit}`);
  const found = [...new Set(events.filter(fromCampaignTemplate).flatMap((e) => e.components))].slice(0, max);
  const read = await Promise.all(found.map((c) => readCampaign(c).catch(() => null)));
  return read.filter((c): c is ChainCampaign => !!c);
}

/** The campaign a creating transaction made, read back from the chain. Null if it can't be found. */
export async function campaignFromTx(tx: string): Promise<ChainCampaign | null> {
  const o = await readOutcome(tx);
  if (o.state === "rejected") return null;
  const candidates = o.state === "accepted"
    ? o.components
    : (await readEvents(`topic=${encodeURIComponent("std.component.created")}&limit=200`)).filter((e) => e.tx === tx.replace(/^0x/, "") && fromCampaignTemplate(e)).flatMap((e) => e.components);
  for (const c of candidates) {
    const read = await readCampaign(c).catch(() => null);
    if (read) return read;
  }
  return null;
}

export interface ClaimEvent { tx: string; did: string; round: number; amount: bigint }

/** Recent claims on one campaign, newest first. */
export async function listClaims(component: string, limit = 50): Promise<ClaimEvent[]> {
  const events = await readEvents(`substate_id=${component}&limit=${limit}`);
  return events
    .filter((e) => fromCampaignTemplate(e) && e.fields.has("did"))
    .map((e) => ({ tx: e.tx, did: e.fields.get("did") ?? "", round: Number(e.fields.get("round") ?? 0), amount: BigInt(e.fields.get("amount") ?? 0) }));
}

export interface MyClaim { component: string; tx: string; round: number; amount: bigint }

/** What a DID has been paid, newest first, from recent claim events. It only looks back so far, so it can miss old ones. */
export async function listMyClaims(did: string, limit = 1000): Promise<MyClaim[]> {
  const events = await readEvents(`topic=${encodeURIComponent("Campaign.campaign.claim")}&limit=${limit}`);
  return events
    .filter((e) => fromCampaignTemplate(e) && e.fields.get("did") === did && !!e.components[0])
    .map((e) => ({ component: e.components[0]!, tx: e.tx, round: Number(e.fields.get("round") ?? 0), amount: BigInt(e.fields.get("amount") ?? 0) }));
}

/** Campaigns a DID has been paid by. */
export async function listParticipated(did: string, limit = 1000): Promise<string[]> {
  return [...new Set((await listMyClaims(did, limit)).map((c) => c.component))];
}

// ---- transactions --------------------------------------------------------------------------------------------

export type Instruction = Record<string, unknown>;

const call = (component: string, method: string, args: unknown[]): Instruction => ({ CallMethod: { call: { Address: component }, method, args } });
const fn = (template: string, name: string, args: unknown[]): Instruction => ({ CallFunction: { address: hexOf(template), function: name, args } });

/**
 * Where a funded call finds its money: the wallet's reveal step keeps its own withdrawal in slot 0 and leaves the
 * bucket for the follow-up instructions in slot 1.
 */
export const FUNDS_WORKSPACE = "campaign_funds";
const fundsBucket = { Workspace: { id: 1, offset: null } };

/** The follow-up instruction of a funded create: the funds come from the wallet's reveal step. */
export function createInstruction(spec: Spec, epoch: number, funderKey: string): Instruction {
  const a = createArgs(spec, epoch, funderKey, DEPLOYMENT.linkRegistry);
  return fn(DEPLOYMENT.campaignTemplate, "create", [
    lit(a.name as string),
    lit(a.info as string),
    lit(fromHex(funderKey)),
    lit(componentArg(DEPLOYMENT.linkRegistry)),
    lit(a.kinds as number[]),
    lit(a.targets as string[]),
    lit(a.snapshots as number[]),
    lit(a.texts as string[]),
    lit(a.groups as number[]),
    lit(BigInt(a.reward as string)),
    lit(fromHex((a.allocation_root as string) || "")),
    lit(a.rounds as number),
    lit(a.round_epochs as number),
    lit(BigInt(a.referral_bonus as string)),
    lit(a.max_referrals as number),
    lit(a.open_epoch as number),
    lit(a.close_epoch as number),
    fundsBucket,
  ]);
}

export const topUpInstruction = (component: string): Instruction => call(component, "top_up", [fundsBucket]);
export const extendInstruction = (component: string, closeEpoch: number): Instruction => call(component, "extend", [lit(closeEpoch)]);

/** Takes back what's left after the close epoch, into the funder's own account. */
export const closeInstructions = (component: string, account: string): Instruction[] => [
  call(component, "close", []),
  { PutLastInstructionOutputOnWorkspace: { key: 0 } },
  call(account, "deposit", [{ Workspace: { id: 0, offset: null } }]),
];

export const openAccountInstruction = (did: string, registry: string = DEPLOYMENT.linkRegistry): Instruction => call(registry, "open_account", [lit(did)]);

export interface RecordProof {
  commit: Uint8Array;
  nodes: Uint8Array[];
  record: Uint8Array;
  rkey: string;
}

/** One proof per rule in rule order, with empty entries for skipped either/or members. */
export interface ClaimProofs {
  did: string;
  ops: Uint8Array[];
  proofs: (RecordProof | null)[];
  /** One identity log per proven vouch rule, in rule order. */
  vouchOps: Uint8Array[][];
  code: RecordProof;
  amount: bigint;
  path: string[];
}

const ruleArgs = (p: Omit<ClaimProofs, "code">): unknown[] => [
  lit(p.ops),
  lit(p.proofs.map((x) => x?.commit ?? new Uint8Array())),
  lit(p.proofs.map((x) => x?.nodes ?? [])),
  lit(p.proofs.map((x) => x?.record ?? new Uint8Array())),
  lit(p.proofs.map((x) => x?.rkey ?? "")),
  lit(p.vouchOps),
];

function proofArgs(p: ClaimProofs): unknown[] {
  return [
    ...ruleArgs(p),
    lit(p.code.commit),
    lit(p.code.nodes),
    lit(p.code.record),
    lit(p.code.rkey),
    lit(p.amount),
    lit(p.path.map((s) => fromHex(s))),
  ];
}

export const claimInstruction = (component: string, p: ClaimProofs, walletKey: string, account: string, referrer: string | null = null): Instruction => {
  const a = proofArgs(p);
  return call(component, "claim", [lit(p.did), lit(fromHex(walletKey)), lit(componentArg(account)), ...a, lit(referrer)]);
};

/** A first claim paid to the wallet the account has linked. It needs no claim post, and any wallet may submit it. */
export const claimLinkedInstruction = (component: string, p: Omit<ClaimProofs, "code">, referrer: string | null = null): Instruction =>
  call(component, "claim_linked", [lit(p.did), ...ruleArgs(p), lit(p.amount), lit(p.path.map((s) => fromHex(s))), lit(referrer)]);

/** Links an account to a wallet. The authority is the post, so any wallet may submit it. */
export const bindInstruction = (registry: string, did: string, address: string, ownerKey: string, ops: Uint8Array[], post: RecordProof): Instruction =>
  call(registry, "bind", [lit(did), lit(componentArg(address)), lit(fromHex(ownerKey)), lit(ops), lit(post.commit), lit(post.nodes), lit(post.record), lit(post.rkey)]);

export const claimRoundInstruction = (component: string, p: ClaimProofs, walletKey: string): Instruction =>
  call(component, "claim_round", [lit(p.did), lit(fromHex(walletKey)), ...proofArgs(p)]);
