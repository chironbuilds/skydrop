# Browser tests

These drive the built sites in Chrome through `puppeteer-core`, against real chain and Bluesky data. Nothing here signs or spends: a fake wallet stands in for Sapient.

```
cd scripts/e2e && npm install && mkdir -p shots prod-shots
```

Serve the builds first (`npx vite preview` in `web-atproto` on 5196 and in `web` on 5199), or point the tests at the live sites.

| Test | Run with | Covers |
|---|---|---|
| `quests.mjs` | `node quests.mjs <skydrop quests url>` | The participant page |
| `flow.mjs` | `node flow.mjs <creator url> <skydrop quests url>` | Launching, claiming, linking and invites through to the transaction |
| `invites.mjs` | `node invites.mjs` | Invite links against the referral test campaign |
| `run.mjs` | `node run.mjs <creator url>` | The creator site |
| `lists.mjs` | `node lists.mjs <list campaign>` | Allocation lists. Needs `wrangler dev --port 5201 --local` in `web`, with a clean store |
| `skydrop.mjs` | `node skydrop.mjs <second list campaign>` | Share links, open campaigns, collecting together and history. Needs the same worker |
| `prodcheck.mjs` | `node prodcheck.mjs` | List storage at real sizes and the contract address on the live sites |

Some tests use test campaigns on Esmeralda, which close, so `lists.mjs`, `skydrop.mjs` and `invites.mjs` may need new ones from `scripts/live-campaign.ts`.
