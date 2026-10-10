/** Everything deployment-specific lives here. */
export const CONFIG = {
  network: "esmeralda" as const,
  /** The BskyClaim escrow component (per-deposit challenge windows). */
  component: "component_0752fceb69628e0310315ece70ec11282d1b71e8532eb0fa23c1d3e1b2e3d1ce",
  template: "template_868f2f457194c84fcab14ef4d2b76888836549635a2a7fc048938b513e1f560f",
  /** µT per tTARI. */
  unit: 1_000_000n,
  symbol: "tTARI",
  /** Refund epoch offset: unclaimed deposits can be taken back by the sender after this many epochs. */
  refundAfterEpochs: 500,
  /** Smallest deposit the component accepts (µT). */
  minDeposit: 1000n,
  /** Largest challenge window the component accepts. */
  maxWindow: 10,
  /** The bot account that relays tip posts. */
  botHandle: "taridrop.bsky.social",
  botDid: "did:plc:lsdjnz7b7du3e3rkawynfsqd",
  claimDomain: "tari-bsky-claim:v1:",
  collection: "app.bsky.feed.post",
  publicApi: "https://public.api.bsky.app",
  plcDirectory: "https://plc.directory",
};
