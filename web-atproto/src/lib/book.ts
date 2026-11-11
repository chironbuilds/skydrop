/**
 * Brings the ChainBook up to date for the accounts a campaign claim reads (the claimant and any vouchers): the calls
 * that open a missing record and record the operations it doesn't hold yet, each with the hint naming its signer.
 * Anyone may record operations: the signatures are the authority.
 */
import * as dagCbor from "@ipld/dag-cbor";
import { BOOK_MAX_ADVANCE, opHashHex, signerHints, type PlcOp } from "../../../web/src/chainbook";
import { lit, readBookRecord, type Instruction } from "./chain";

/** Operations a paid claim records in its own transaction; more are recorded first (one transaction may use 250M points). */
export const INLINE_BOOK_OPS = 12;
/** Operations a sponsored claim's fee phase can record (32M points of credit; ~8M an operation). */
export const FEE_PHASE_BOOK_OPS = 1;
/** What recording one operation can cost in fees (uT). */
export const FEE_PER_BOOK_OP = 9_000n;

const call = (component: string, method: string, args: unknown[]): Instruction => ({ CallMethod: { call: { Address: component }, method, args } });

/** How many of `did`'s operations (`ops`, DAG-CBOR, genesis first) the book still lacks, and the calls that record them. */
export async function bookInstructions(book: string, did: string, ops: Uint8Array[]): Promise<{ missing: number; instructions: Instruction[] }> {
  const rec = await readBookRecord(book, did);
  const n = rec?.len ?? 0;
  const log = ops.map((o) => dagCbor.decode(o) as PlcOp);
  if (n > log.length) throw new Error("The identity history recorded on-chain is longer than the one the directory shows. Try again later.");
  if (n > 0 && (await opHashHex(log[n - 1]!)) !== rec!.hashes[n - 1]) {
    throw new Error("This account's identity history recorded on-chain differs from the directory's. It can't be extended until that's resolved.");
  }
  const open = rec ? [] : [call(book, "open_account", [lit(did)])];
  if (n >= log.length) return { missing: 0, instructions: open };
  const hints = signerHints(log);
  const steps: Instruction[] = [...open];
  for (let at = n; at < log.length; at += BOOK_MAX_ADVANCE) {
    const end = Math.min(log.length, at + BOOK_MAX_ADVANCE);
    steps.push(call(book, "advance", [lit(did), lit(at === 0 ? null : ops[at - 1]!), lit(ops.slice(at, end)), lit(Uint8Array.from(hints.slice(at, end)))]));
  }
  return { missing: log.length - n, instructions: steps };
}
