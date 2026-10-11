/** Everything deployment-specific lives here. */
export const CONFIG = {
  network: "esmeralda" as const,
  /** The BskyClaim escrow component (per-deposit challenge windows and challenge phrases). */
  component: (typeof process !== "undefined" && process.env?.SKYDROP_COMPONENT) || "component_a2a3281bea6ab6a06e2ad9a66db78e1e561639c9a9fcbdb5c418cdd9227c7004",
  template: "template_17de990c2218ff95bc05214b34d86184112f4ee5843f23c5381eced65060d9ec",
  /** µT per tTARI. */
  unit: 1_000_000n,
  symbol: "tTARI",
  /** Refund epoch offset: unclaimed deposits can be taken back by the sender after this many epochs. */
  refundAfterEpochs: 500,
  /** Smallest deposit the component accepts (µT). */
  minDeposit: 1000n,
  /** Largest challenge window the component accepts. */
  maxWindow: 10,
  /** Longest challenge phrase the component accepts (bytes). */
  maxChallenge: 80,
  /** The bot account that relays tip posts. */
  botHandle: "taridrop.bsky.social",
  botDid: "did:plc:lsdjnz7b7du3e3rkawynfsqd",
  claimDomain: "tari-bsky-claim:v1:",
  collection: "app.bsky.feed.post",
  publicApi: "https://public.api.bsky.app",
  plcDirectory: "https://plc.directory",
};
