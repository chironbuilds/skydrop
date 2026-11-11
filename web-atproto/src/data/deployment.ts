/**
 * What is live on each network. An empty address means "not published yet", and the site says so instead of pretending.
 * Fill in MAINNET after running scripts/deploy-campaigns.mjs and scripts/deploy-gifts.mjs on mainnet.
 *
 * Pages are built once per network. The Workers carry both builds and start on the testnet, moving to mainnet by
 * themselves at launch: see web-atproto/worker/network.ts.
 */
import { encodeLive, LINK_LIST_MAX, type Allocation } from "../lib/campaign";

export interface LiveCampaign { component: string; name: string }

declare const __SKYDROP_NETWORK__: "esmeralda" | "mainnet" | "auto" | undefined;

/** Fixed for a page build and the testnet Worker; "auto" for the Workers on the main domains. */
export const BUILD_NETWORK = typeof __SKYDROP_NETWORK__ === "undefined" ? "esmeralda" : __SKYDROP_NETWORK__;

/** Ootle mainnet launch: 2026-11-11 05:00:00 UTC. */
export const MAINNET_LAUNCH_MS = Date.UTC(2026, 10, 11, 5, 0, 0);

export const isTestnetHost = (host: string): boolean => host.startsWith("testnet-");
/** Until launch the testnet build is still served from the main domains, and should keep linking to them. */
const onTestnetHost = typeof location !== "undefined" && isTestnetHost(location.hostname);

const MAINNET = {
  network: "Ootle mainnet",
  isMainnet: true,
  /** What the wallet calls this network, and what to call it when asking someone to switch. */
  walletNetwork: "mainnet",
  walletLabel: "Mainnet",
  unit: "TARI",
  ootle: "0.50.1",
  indexer: "https://indexer-a.ootle.tari.com",
  campaignTemplate: "",
  linkRegistry: "",
  verifier: "",
  /** Gift stack. Fill in after running scripts/deploy-gifts.mjs. */
  escrow: "",
  claim: "",
  tip: "",
  live: [] as LiveCampaign[],
  legacy: [] as { campaignTemplate: string; linkRegistry: string }[],
  skydrop: "https://skydrop.tari.mw",
  creator: "https://atproto.tari.mw",
  explorer: "https://explorer.tari.mw",
  /** Where links from the other network still work. */
  otherSkydrop: "https://testnet-skydrop.tari.mw",
};

const TESTNET: typeof MAINNET = {
  network: "Esmeralda testnet",
  isMainnet: false,
  walletNetwork: "esmeralda",
  walletLabel: "Esmeralda",
  unit: "tTARI",
  ootle: "0.50.1",
  indexer: "https://ootle-indexer-a.tari.com",
  campaignTemplate: "template_458f453db349adef15c5ed113f5df6291f8b74c7f5ece155c38575e49600b36f",
  linkRegistry: "component_c69b5699aeeb7292468b988a34bfd0947694d19514a1fb0762cd0542bcc21dce",
  verifier: "template_17c2c32b010972b85f8822509b1e921910a54e63bd9b4a9b29b6af78d0681824",
  escrow: "",
  claim: "",
  tip: "",
  live: [],
  /** Campaigns made before Ootle 0.50. Their state can still be read, but the engine no longer loads their code, so they can't pay out or be closed. */
  legacy: [
    { campaignTemplate: "template_40d3f8b2cbb33fc5110ee8fe05c8a66d9238898f08c1a8ba96b3568809a93b72", linkRegistry: "component_aba7f01482dfc95a2c84ca120a96959923f34e95e7715bb96dd805e2c3726371" },
    { campaignTemplate: "template_d911cfc348ffb30eb046776e4746d3880898f059bae997c2735447a4f0866060", linkRegistry: "component_5825a4a3f5c5703a051f46e3c390b62165e8b3029e9148f39f2a54ebe12c2918" },
  ],
  skydrop: onTestnetHost ? "https://testnet-skydrop.tari.mw" : "https://skydrop.tari.mw",
  creator: onTestnetHost ? "https://testnet-atproto.tari.mw" : "https://atproto.tari.mw",
  explorer: "https://testnet-explorer.tari.mw",
  otherSkydrop: "https://skydrop.tari.mw",
};

// Runtime address injection: the Worker reads KV and injects these before the page loads.
// Applies only when mainnet addresses aren't compiled in yet (window.__SD_ADDR__ set by Worker).
if (typeof window !== "undefined") {
  const rt = (window as unknown as Record<string, unknown>).__SD_ADDR__;
  if (rt && typeof rt === "object") {
    const a = rt as Partial<Record<string, string>>;
    if (a.campaignTemplate) MAINNET.campaignTemplate = a.campaignTemplate;
    if (a.linkRegistry) MAINNET.linkRegistry = a.linkRegistry;
    if (a.verifier) MAINNET.verifier = a.verifier;
    if (a.escrow) MAINNET.escrow = a.escrow;
    if (a.claim) MAINNET.claim = a.claim;
    if (a.tip) MAINNET.tip = a.tip;
  }
}

export const DEPLOYMENT = { ...(BUILD_NETWORK === "mainnet" ? MAINNET : TESTNET) };

/** One-way, for a Worker on a main domain once launch has happened. Only Workers call this; a page is built for its network. */
export const useMainnet = (): void => void Object.assign(DEPLOYMENT, MAINNET);

/** Where participants track campaigns and claim. atproto.tari.mw is for creating them. */
export const SKYDROP = DEPLOYMENT.skydrop;
export const participantLink = (encoded: string): string => `${DEPLOYMENT.skydrop}/quests#add=${encoded}`;

/**
 * The link to share for a live campaign. It's short and shows a preview card when posted. A list small enough to travel
 * in the link still does, so it works even if the list was never stored.
 */
export function campaignLink(component: string, { allocations, ref, origin = DEPLOYMENT.skydrop }: { allocations?: Allocation[]; ref?: string | null; origin?: string } = {}): string {
  if (allocations?.length && allocations.length <= LINK_LIST_MAX) return `${origin}/quests#add=${encodeLive(component, allocations)}${ref ? `&ref=${ref}` : ""}`;
  return `${origin}/q/${component}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;
}

/** The contracts are on the network. */
export const contractsOnNetwork = (): boolean => !!DEPLOYMENT.campaignTemplate && !!DEPLOYMENT.linkRegistry;
/** Gift stack (Escrow + ClaimPolicy) is deployed and can send/claim gifts. */
export const giftsDeployed = (): boolean => !!DEPLOYMENT.escrow && !!DEPLOYMENT.claim;

/** Share link for a gift sent to a Bluesky handle. */
export const giftLink = (handle: string, { note, amount }: { note?: string; amount?: string } = {}): string => {
  const u = new URL(`${DEPLOYMENT.skydrop}/e/${encodeURIComponent(handle)}`);
  if (note) u.searchParams.set("m", note);
  if (amount) u.searchParams.set("a", amount);
  return u.toString();
};
/** Campaigns can be funded and claimed from these sites. Run live on 2026-11-06 with scripts/live-campaign.ts. */
const FUNDING_READY = true;
export const isPublished = (): boolean => contractsOnNetwork() && FUNDING_READY;
/** Whether the mainnet contracts are in this build. Once they are, the Workers need no live check to know launch happened. */
export const mainnetPublished = (): boolean => !!MAINNET.campaignTemplate && !!MAINNET.linkRegistry;
