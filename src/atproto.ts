// Assembles the self-contained proof the on-chain verifier checks:
//  - the DID's PLC operation chain (signed DAG-CBOR bytes, genesis first)
//  - the repo commit block + the Merkle-search-tree nodes on the path to the record + the record block
import * as dagCbor from '@ipld/dag-cbor'
import { CarReader } from '@ipld/car'
import { CID } from 'multiformats/cid'

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')

export interface PlcOp { [k: string]: unknown }

export async function fetchPlcLog(did: string): Promise<PlcOp[]> {
  const r = await fetch(`https://plc.directory/${did}/log`)
  if (!r.ok) throw new Error(`plc log ${did}: ${r.status}`)
  return (await r.json()) as PlcOp[]
}

/** Signed operation bytes exactly as hashed to form the DID / `prev` CIDs. */
export const encodeOp = (op: PlcOp): Uint8Array => dagCbor.encode(op)

export function pdsOf(op: PlcOp): string {
  const s = op.services as Record<string, { endpoint: string }>
  return s.atproto_pds.endpoint
}

export interface RecordProof {
  did: string
  collection: string
  rkey: string
  plcOps: string[]
  commit: string
  mstNodes: string[]
  record: string
  text: string
}

export async function buildRecordProof(did: string, collection: string, rkey: string): Promise<RecordProof> {
  const log = await fetchPlcLog(did)
  const pds = pdsOf(log[log.length - 1])
  const url = `${pds}/xrpc/com.atproto.sync.getRecord?did=${encodeURIComponent(did)}&collection=${collection}&rkey=${rkey}`
  const r = await fetch(url)
  if (!r.ok) throw new Error(`getRecord: ${r.status} ${await r.text()}`)
  const car = await CarReader.fromBytes(new Uint8Array(await r.arrayBuffer()))
  const [root] = await car.getRoots()
  const commitBlock = await car.get(root as CID)
  if (!commitBlock) throw new Error('commit block missing')
  const commit = dagCbor.decode(commitBlock.bytes) as { data: CID }
  const nodes: Uint8Array[] = []
  let record: Uint8Array | null = null
  for await (const b of car.blocks()) {
    if (b.cid.equals(root as CID)) continue
    const v = dagCbor.decode(b.bytes) as Record<string, unknown>
    if (v && typeof v === 'object' && 'e' in v && Array.isArray(v.e)) nodes.push(b.bytes)
    else record = b.bytes
  }
  if (!record) throw new Error('record block missing')
  const text = ((dagCbor.decode(record) as { text?: string }).text) ?? ''
  void commit
  return {
    did, collection, rkey,
    plcOps: log.map((o) => hex(encodeOp(o))),
    commit: hex(commitBlock.bytes),
    mstNodes: nodes.map(hex),
    record: hex(record),
    text,
  }
}
