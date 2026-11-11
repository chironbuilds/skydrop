/** Everything deployment-specific lives here. */
const env = (k: string): string => (typeof process !== "undefined" && process.env?.[k]) || "";

export const CONFIG = {
  network: "esmeralda" as const,
  /**
   * The Skydrop contract stack (see docs/REFACTOR-PLAN.md): the permanent Escrow that holds every gift, and
   * the policies that decide when it pays. Empty until the stack is deployed on the current network.
   */
  escrow: env("SKYDROP_ESCROW") || "",
  /** ClaimPolicy: claim posts, challenge windows, phrases, holds, declines, sweeps, linked delivery. */
  claim: env("SKYDROP_CLAIM") || "",
  /** TipPolicy: tip budgets spent by `@bot tip @someone 5` posts. */
  tip: env("SKYDROP_TIP") || "",
  /** LinkRegistry: Bluesky account -> linked Ootle wallet. */
  link: env("SKYDROP_LINK") || "",
  /** µT per tTARI. */
  unit: 1_000_000n,
  symbol: "tTARI",
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
