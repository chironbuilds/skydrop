/** Everything deployment-specific lives here. */
const env = (k: string): string => (typeof process !== "undefined" && process.env?.[k]) || "";

declare const __SKYDROP_NETWORK__: "esmeralda" | "mainnet" | undefined;
// Pages get the network from the Vite define; the bot (run with tsx) from SKYDROP_NET.
const _net: "esmeralda" | "mainnet" =
  typeof __SKYDROP_NETWORK__ !== "undefined" ? __SKYDROP_NETWORK__ : env("SKYDROP_NET") === "mainnet" ? "mainnet" : "esmeralda";

export const CONFIG = {
  network: _net,
  indexer: _net === "mainnet" ? "https://indexer-a.ootle.tari.com" : "https://ootle-indexer-a.tari.com",
  /**
   * The Skydrop contract stack (see docs/REFACTOR-PLAN.md): the permanent Escrow that holds every gift, and
   * the policies that decide when it pays. Empty until the stack is deployed on the current network.
   */
  escrow: env("SKYDROP_ESCROW") || (_net === "mainnet" ? "component_b51d366c73d397f5c094039db95de00423a123af998d46d5a5f6a88fe69b14c5" : ""),
  /** ClaimPolicy: claim posts, challenge windows, phrases, holds, declines, sweeps, linked delivery. */
  claim: env("SKYDROP_CLAIM") || (_net === "mainnet" ? "component_9fe4d780b732ed626a623d78959119c32bd6176e4e8f0b96789aa1fc4d6636bd" : ""),
  /** TipPolicy: tip budgets spent by `@bot tip @someone 5` posts. */
  tip: env("SKYDROP_TIP") || (_net === "mainnet" ? "component_2a651c5accdfc5c27e3e8081ad90c759e451f62f875b7e403e0cedb2e2410c1b" : ""),
  /**
   * v2 (2026-11-12): ClaimPolicy and TipPolicy that read identity chains from the ChainBook instead of every proof, so
   * old accounts (many identity operations) can claim and fees stay low. New gifts and budgets use these; gifts and
   * budgets made under v1 (`claim`, `tip` above) keep working through v1 until they're claimed, refunded or closed.
   */
  claim2: env("SKYDROP_CLAIM2") || (_net === "mainnet" ? "component_78a6976c6e0487243df617c843d43a8894533a965422f812de854ba6c9c4f887" : ""),
  tip2: env("SKYDROP_TIP2") || (_net === "mainnet" ? "component_eec24fcf6e580fe8e6ffc8ff894b830082d82a8651718d067c4b014045e24cda" : ""),
  /** ChainBook: each account's verified identity chain, recorded once and read by the v2 contracts. */
  chainBook: env("SKYDROP_CHAIN_BOOK") || (_net === "mainnet" ? "component_3141639f2389e9f320fcc3e4ca491d599950c387a552f7f793e11f1c93f334e1" : ""),
  /** LinkRegistry: Bluesky account -> linked Ootle wallet. */
  link: env("SKYDROP_LINK") || (_net === "mainnet" ? "component_3ccfa2673b89234858a5b1c27d3efe2066953e1ea7cf001a018d3e3121912712" : ""),
  /** µT per TARI/tTARI. */
  unit: 1_000_000n,
  symbol: _net === "mainnet" ? "TARI" : "tTARI",
  /** Refund epoch offset: unclaimed deposits can be taken back by the sender after this many epochs. */
  refundAfterEpochs: 500,
  /** Smallest deposit the escrow accepts (µT). */
  minDeposit: 1000n,
  /** Largest challenge window, hold and phrase ClaimPolicy treats as valid (its MAX_WINDOW/MAX_HOLD/MAX_PHRASE). */
  maxWindow: 10,
  maxHold: 168,
  maxChallenge: 80,
  /** Epochs a new link waits before it takes effect (set when the LinkRegistry was created). */
  bindDelayEpochs: 0,
  /** The bot account that relays tip posts. */
  botHandle: "taridrop.bsky.social",
  botDid: "did:plc:lsdjnz7b7du3e3rkawynfsqd",
  claimDomain: "tari-bsky-claim:v1:",
  collection: "app.bsky.feed.post",
  publicApi: "https://public.api.bsky.app",
  plcDirectory: "https://plc.directory",
};

// Runtime address injection: the Worker reads KV and injects these into the HTML before the page loads.
// This fills empty mainnet addresses without a rebuild (window.__SD_ADDR__ set by the skydrop Worker).
if (typeof window !== "undefined") {
  const rt = (window as unknown as Record<string, unknown>).__SD_ADDR__;
  if (rt && typeof rt === "object") {
    const a = rt as Partial<Record<string, string>>;
    if (a.escrow) CONFIG.escrow = a.escrow;
    if (a.claim) CONFIG.claim = a.claim;
    if (a.tip) CONFIG.tip = a.tip;
    // KV stores the link registry as either "linkRegistry" (from deploy-campaigns) or "link"
    if (a.linkRegistry) CONFIG.link = a.linkRegistry;
    else if (a.link) CONFIG.link = a.link;
  }
}

/** Whether the contract stack has been deployed and configured. */
export const deployed = (): boolean => !!(CONFIG.escrow && CONFIG.claim && CONFIG.tip && CONFIG.link);
