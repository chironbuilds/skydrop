/** Everything deployment-specific lives here. */
export const CONFIG = {
  network: "esmeralda" as const,
  /** The BskyClaim escrow component (per-deposit challenge windows and challenge phrases). */
  component: (typeof process !== "undefined" && process.env?.SKYDROP_COMPONENT) || "component_9075535254baad3451acbc951141c783f6c9f6e870518f931fd58a4154ca5b27",
  template: "template_744ffdcca6afdc6bbcdc682f5e9f13e54b04f5ac22ecae74a2e33329db5cc44d",
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
