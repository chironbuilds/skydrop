/**
 * What is live on the network. Empty means "not published yet", and the site says so instead of pretending.
 * Fill this in after running scripts/deploy-campaigns.mjs; nothing else needs to change.
 */
export interface LiveCampaign { component: string; name: string }

export const DEPLOYMENT = {
  network: "Esmeralda testnet",
  ootle: "0.49.2",
  indexer: "https://ootle-indexer-a.tari.com",
  campaignTemplate: "",
  linkRegistry: "",
  verifier: "",
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
