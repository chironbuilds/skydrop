import { writeFileSync } from 'node:fs'
import { buildRecordProof } from './atproto.js'

const actor = process.argv[2] ?? 'bsky.app'
const feed = await (await fetch(`https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${actor}&limit=1&filter=posts_no_replies`)).json() as any
const rec = { uri: feed.feed[0].post.uri as string }
const did = rec.uri.split('/')[2]
const rkey = rec.uri.split('/').pop()
const proof = await buildRecordProof(did, 'app.bsky.feed.post', rkey)
writeFileSync(`fixtures/${actor.replace(/\W/g, '_')}.json`, JSON.stringify(proof, null, 1))
console.log(did, rkey, 'ops', proof.plcOps.length, 'mst nodes', proof.mstNodes.length, 'text:', JSON.stringify(proof.text.slice(0, 80)))
