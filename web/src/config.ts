/** Everything deployment-specific lives here. */
export const CONFIG = {
  network: "esmeralda" as const,
  /** The BskyClaim escrow component (per-deposit challenge windows and challenge phrases). */
  component: (typeof process !== "undefined" && process.env?.SKYDROP_COMPONENT) || "component_dedb7b9bd6d22c6ce685031a89e3b896cee0b905a687c1bfedb30e30c5b6c12e",
  template: "template_166aa8df7e089a29b80333d41ee3ca2596314cc96fe7cf02a9869127cb6a19b6",
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
