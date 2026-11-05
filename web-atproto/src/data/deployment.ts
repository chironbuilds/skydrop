/**
 * What is live on the network. Empty means "not published yet", and the site says so instead of pretending.
 * Fill this in after running scripts/deploy-campaigns.mjs; nothing else needs to change.
 */
export interface LiveCampaign { component: string; name: string }

export const DEPLOYMENT = {
  network: "Esmeralda testnet",
  ootle: "0.49.2",
  indexer: "https://ootle-indexer-a.tari.com",
  campaignTemplate: "template_40d3f8b2cbb33fc5110ee8fe05c8a66d9238898f08c1a8ba96b3568809a93b72",
  linkRegistry: "component_bce8ed6d3479b8d84fb947c6dd634d4c192d899176ba64dea6e8dd7010c62da1",
  verifier: "template_1c0d23cd6b40ca2feaa098991f0746c3f88040c8b2d0bade227ee429168b923a",
  live: [] as LiveCampaign[],
};

/** Where participants track campaigns and claim. atproto.tari.mw is for creating them. */
export const SKYDROP = "https://skydrop.tari.mw";
export const participantLink = (encoded: string): string => `${SKYDROP}/quests#add=${encoded}`;

/** The contracts are on the network. */
export const contractsOnNetwork = (): boolean => !!DEPLOYMENT.campaignTemplate && !!DEPLOYMENT.linkRegistry;
/** Campaigns can actually be funded and claimed from these sites. Only turn on once that's built and tested live. */
const FUNDING_READY = false;
export const isPublished = (): boolean => contractsOnNetwork() && FUNDING_READY;
