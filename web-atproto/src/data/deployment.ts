/**
 * What is live on the network. Empty means "not published yet", and the site says so instead of pretending.
 * Fill this in after running scripts/deploy-campaigns.mjs; nothing else needs to change.
 */
import { encodeLive, LINK_LIST_MAX, type Allocation } from "../lib/campaign";

export interface LiveCampaign { component: string; name: string }

export const DEPLOYMENT = {
  network: "Esmeralda testnet",
  ootle: "0.49.2",
  indexer: "https://ootle-indexer-a.tari.com",
  campaignTemplate: "template_d911cfc348ffb30eb046776e4746d3880898f059bae997c2735447a4f0866060",
  linkRegistry: "component_5825a4a3f5c5703a051f46e3c390b62165e8b3029e9148f39f2a54ebe12c2918",
  verifier: "template_1c0d23cd6b40ca2feaa098991f0746c3f88040c8b2d0bade227ee429168b923a",
  live: [] as LiveCampaign[],
  /** Campaigns made before the 2026-11-07 fixes. They still read and pay, on the registry they were made with. New ones can't be created. */
  legacy: [{ campaignTemplate: "template_40d3f8b2cbb33fc5110ee8fe05c8a66d9238898f08c1a8ba96b3568809a93b72", linkRegistry: "component_aba7f01482dfc95a2c84ca120a96959923f34e95e7715bb96dd805e2c3726371" }],
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
