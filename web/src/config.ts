/** Everything deployment-specific lives here. */
export const CONFIG = {
  network: "esmeralda" as const,
  /** The BskyClaim escrow component (per-deposit challenge windows and challenge phrases). */
  component: (typeof process !== "undefined" && process.env?.SKYDROP_COMPONENT) || "component_fa644838352c2101dcd6d541fd86eb69c6a5c83583e814b2a2256052f682bbca",
  template: "template_bec94d99246102295e5479427125e25b15c336eb84c9061354e283734bb871dc",
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
