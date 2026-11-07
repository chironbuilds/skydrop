/**
 * What is live on the network. Empty means "not published yet", and the site says so instead of pretending.
 * Fill this in after running scripts/deploy-campaigns.mjs; nothing else needs to change.
 */
import { encodeLive, LINK_LIST_MAX, type Allocation } from "../lib/campaign";

export interface LiveCampaign { component: string; name: string }

export const DEPLOYMENT = {
  network: "Esmeralda testnet",
  ootle: "0.50.1",
  indexer: "https://ootle-indexer-a.tari.com",
  campaignTemplate: "template_458f453db349adef15c5ed113f5df6291f8b74c7f5ece155c38575e49600b36f",
  linkRegistry: "component_c69b5699aeeb7292468b988a34bfd0947694d19514a1fb0762cd0542bcc21dce",
  verifier: "template_17c2c32b010972b85f8822509b1e921910a54e63bd9b4a9b29b6af78d0681824",
  live: [] as LiveCampaign[],
  /** Campaigns made before Ootle 0.50. Their state can still be read, but the engine no longer loads their code, so they can't pay out or be closed. */
  legacy: [
    { campaignTemplate: "template_40d3f8b2cbb33fc5110ee8fe05c8a66d9238898f08c1a8ba96b3568809a93b72", linkRegistry: "component_aba7f01482dfc95a2c84ca120a96959923f34e95e7715bb96dd805e2c3726371" },
    { campaignTemplate: "template_d911cfc348ffb30eb046776e4746d3880898f059bae997c2735447a4f0866060", linkRegistry: "component_5825a4a3f5c5703a051f46e3c390b62165e8b3029e9148f39f2a54ebe12c2918" },
  ],
};

/** Where participants track campaigns and claim. atproto.tari.mw is for creating them. */
export const SKYDROP = "https://skydrop.tari.mw";
export const participantLink = (encoded: string): string => `${SKYDROP}/quests#add=${encoded}`;

/**
 * The link to share for a live campaign. It's short and shows a preview card when posted. A list small enough to travel
 * in the link still does, so it works even if the list was never stored.
 */
export function campaignLink(component: string, { allocations, ref, origin = SKYDROP }: { allocations?: Allocation[]; ref?: string | null; origin?: string } = {}): string {
  if (allocations?.length && allocations.length <= LINK_LIST_MAX) return `${origin}/quests#add=${encodeLive(component, allocations)}${ref ? `&ref=${ref}` : ""}`;
  return `${origin}/q/${component}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;
}

/** The contracts are on the network. */
export const contractsOnNetwork = (): boolean => !!DEPLOYMENT.campaignTemplate && !!DEPLOYMENT.linkRegistry;
/** Campaigns can be funded and claimed from these sites. Run live on 2026-11-06 with scripts/live-campaign.ts. */
const FUNDING_READY = true;
export const isPublished = (): boolean => contractsOnNetwork() && FUNDING_READY;
