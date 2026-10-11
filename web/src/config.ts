/** Everything deployment-specific lives here. */
export const CONFIG = {
  network: "esmeralda" as const,
  /** The BskyClaim escrow component (per-deposit challenge windows and challenge phrases). */
  component: (typeof process !== "undefined" && process.env?.SKYDROP_COMPONENT) || "component_2e5a47487f53be5ee6d795fc3d4b94b148c583713c3aed693da21eaf4b18b599",
  template: "template_ebf68e07b3583f61178369e7a4cd73b5c831752f15710f91c4ac143f8a03dee8",
  /** µT per tTARI. */
  unit: 1_000_000n,
  symbol: "tTARI",
  /** Refund epoch offset: unclaimed deposits can be taken back by the sender after this many epochs. */
  refundAfterEpochs: 500,
  /** Smallest deposit the component accepts (µT). */
  minDeposit: 1000n,
  /** Largest challenge window the component accepts. */
  maxWindow: 10,
  /** Epochs a new link waits before it takes effect (set when the component was created). */
  bindDelayEpochs: 0,
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
