/** Everything deployment-specific lives here. */
export const CONFIG = {
  network: "esmeralda" as const,
  /** The BskyClaim escrow component (per-deposit challenge windows). */
  component: "component_e416eb50720a70921c8454e6357e8a702c73770f3a26e04bd50b96265d4893fe",
  template: "template_9553b808139ab9a679786bd162ed147205e0b80532eac9581fcd3350982e3537",
  /** µT per tTARI. */
  unit: 1_000_000n,
  symbol: "tTARI",
  /** Refund epoch offset: unclaimed deposits can be taken back by the sender after this many epochs. */
  refundAfterEpochs: 500,
  /** Smallest deposit the component accepts (µT). */
  minDeposit: 1000n,
  /** Largest challenge window the component accepts. */
  maxWindow: 10,
  claimDomain: "tari-bsky-claim:v1:",
  collection: "app.bsky.feed.post",
  publicApi: "https://public.api.bsky.app",
  plcDirectory: "https://plc.directory",
};
