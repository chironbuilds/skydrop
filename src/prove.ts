import { writeFileSync } from 'node:fs'
import { buildRecordProof } from './atproto.js'

const [handle, needle, out] = process.argv.slice(2)
const feed = await (await fetch(`https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${handle}&limit=30&filter=posts_no_replies`)).json() as any
const hit = feed.feed.map((f: any) => f.post).find((p: any) => (p.record?.text ?? '').includes(needle))
if (!hit) throw new Error('no post containing the claim code found')
const [, , did, , rkey] = (hit.uri as string).replace('at://', '//').split('/')
const proof = await buildRecordProof(did, 'app.bsky.feed.post', rkey)
writeFileSync(out, JSON.stringify(proof, null, 1))
console.log('post', hit.uri, '\nops', proof.plcOps.length, 'mst nodes', proof.mstNodes.length, '\ntext:', JSON.stringify(proof.text))
