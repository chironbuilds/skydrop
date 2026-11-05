export type UseStatus = "campaign" | "policy" | "buildable" | "attested";
export interface UseCase {
  name: string;
  area: "Payments" | "Campaigns" | "Access" | "Identity" | "Governance" | "Services" | "Reputation";
  status: UseStatus;
  text: string;
  uses: string;
  playbook?: string;
}

export const STATUS_LABEL: Record<UseStatus, string> = {
  campaign: "Ready: Campaign",
  policy: "Ready: own policy",
  buildable: "Buildable",
  attested: "Needs an attester",
};

export const STATUS_TEXT: Record<UseStatus, string> = {
  campaign: "Configure it in the campaign builder. Covered by the Campaign template's tests.",
  policy: "A dedicated policy template exists, with engine tests on Ootle 0.49.2.",
  buildable: "Every primitive it needs exists and is provable, but nobody has written the policy yet.",
  attested: "Rests on a fact a contract can't verify alone, so someone has to attest to it.",
};

export const USE_CASES: UseCase[] = [
  { name: "Launch quest", area: "Campaigns", status: "campaign", text: "Like, repost, follow and post, all proven in one claim.", uses: "like · repost · follow · post contains", playbook: "launch-quest" },
  { name: "Weekly retention rewards", area: "Campaigns", status: "campaign", text: "Pay in rounds that each need a new post and fresh proofs, so people earn by staying.", uses: "rounds · receipts", playbook: "stay-and-earn" },
  { name: "Hashtag challenge", area: "Campaigns", status: "campaign", text: "Pay for any post containing a required string.", uses: "post contains", playbook: "hashtag" },
  { name: "Quote-post campaign", area: "Campaigns", status: "campaign", text: "Pay for quotes of a post, including quotes with media.", uses: "quote", playbook: "quote-storm" },
  { name: "AMA and thread participation", area: "Campaigns", status: "campaign", text: "Pay for replying in a specific thread.", uses: "reply", playbook: "ama" },
  { name: "Referral programme", area: "Campaigns", status: "campaign", text: "A claimant names who sent them, and that person earns a capped bonus.", uses: "referrals · receipts", playbook: "referrals" },
  { name: "Team or contributor airdrop", area: "Campaigns", status: "campaign", text: "An org's own signed list decides who can claim. The safe form of a handle allowlist.", uses: "list vouch · snapshot", playbook: "contributors" },
  { name: "Retroactive airdrop", area: "Campaigns", status: "campaign", text: "Different amounts per account from a list of any size. Only its Merkle root goes on-chain.", uses: "allocation list", playbook: "retro" },
  { name: "Bounty and grant payouts", area: "Campaigns", status: "campaign", text: "Pay named winners specific amounts in exchange for a public post.", uses: "allocation list · post contains", playbook: "grants" },
  { name: "Event attendance badge", area: "Reputation", status: "campaign", text: "A soulbound receipt NFT per attendee, minted once per account.", uses: "list vouch · receipts", playbook: "poap" },
  { name: "Ambassador seasons", area: "Campaigns", status: "campaign", text: "Vouched members paid over a season for continued activity.", uses: "list vouch · rounds", playbook: "ambassadors" },
  { name: "Followed-by gate", area: "Access", status: "campaign", text: "Anyone a given account follows qualifies. A lightweight vouch with no list to keep.", uses: "followed by", playbook: "org-vouched" },
  { name: "Verified-account campaign", area: "Access", status: "campaign", text: "Gate on a Bluesky verification record from a trusted verifier.", uses: "verified by", playbook: "verified" },
  { name: "Campaign in your own token", area: "Campaigns", status: "campaign", text: "A campaign's pool can be any fungible resource, not only TARI.", uses: "per-campaign vault" },
  { name: "Gift before a wallet exists", area: "Payments", status: "policy", text: "Send funds to a DID. The owner collects later by proving the account. This is Skydrop.", uses: "ClaimPolicy" },
  { name: "Tip by post", area: "Payments", status: "policy", text: "Mention a bot in a signed post and a budget pays. A relayer can't alter the amount or recipient.", uses: "TipPolicy" },
  { name: "Link a DID to a wallet", area: "Identity", status: "policy", text: "One signed post binds an account to a wallet that every policy can read.", uses: "LinkRegistry" },
  { name: "Metered pay-per-call", area: "Services", status: "policy", text: "A service-auth JWT redeems one call's price, once, to a provider fixed up front.", uses: "ServicePay" },
  { name: "Social recovery", area: "Identity", status: "policy", text: "Guardians named by DID recover a vault with posts. Threshold, delay, owner veto.", uses: "SocialRecovery" },
  { name: "Slot-based bounty pool", area: "Payments", status: "policy", text: "Equal slots on the shared Escrow, for small bounties that need its refund path. Limited to 64 slots.", uses: "EngagementBounty" },
  { name: "List-gated slot drop", area: "Payments", status: "policy", text: "The Escrow-based form of a list drop, limited to 64 slots. Prefer Campaign for anything larger.", uses: "ListDrop" },
  { name: "Conditional gift", area: "Payments", status: "policy", text: "A gift that pays only when the post contains a phrase the sender chose.", uses: "ClaimPolicy phrases" },
  { name: "Gift with a post that must stay up", area: "Payments", status: "policy", text: "Pays only after a later signed snapshot still shows the post.", uses: "ClaimPolicy holds" },
  { name: "Walletless first claim", area: "Payments", status: "policy", text: "The escrow's fee vault pays the network fee, repaid from the payout.", uses: "ClaimPolicy sponsored fees" },
  { name: "Tip to unlock a post", area: "Services", status: "policy", text: "Payment releases the key to locked content. Off-chain key service, on-chain receipt.", uses: "Escrow · key-release worker" },
  { name: "Sign in with Bluesky to a contract", area: "Identity", status: "buildable", text: "A session grant from a service-auth JWT. The verifier already reads iss, aud and lxm.", uses: "verify_service_auth" },
  { name: "DAO membership and voting rights", area: "Governance", status: "buildable", text: "A list item grants a role, with a challenge window for rotated keys.", uses: "prove_record · listitem · challenge" },
  { name: "Voting weighted by list or role", area: "Governance", status: "buildable", text: "Different lists map to different weights in a vote.", uses: "prove_record · listitem" },
  { name: "Creator subscriptions", area: "Services", status: "buildable", text: "A follower sets aside a budget that pays a creator per period while the follow stands.", uses: "rounds · follow · budget" },
  { name: "Crowdfund by pledge post", area: "Payments", status: "buildable", text: "A signed post pledges an amount from a budget, refunded if the goal is missed.", uses: "tip parser · budget · refund" },
  { name: "Prediction or bet settled by a named account", area: "Governance", status: "buildable", text: "Both sides name a DID whose signed post settles the outcome.", uses: "prove_record · field_contains" },
  { name: "Portable reputation attestations", area: "Reputation", status: "buildable", text: "Any account signs a custom-lexicon record about another, and a contract reads its fields.", uses: "prove_record_field · any lexicon" },
  { name: "Custom-lexicon apps", area: "Reputation", status: "buildable", text: "Read any app's records (a badge, a review, a score) from a signed repo.", uses: "prove_record_field" },
  { name: "Handle allowlist", area: "Access", status: "attested", text: "A contract sees only what an account asserts about itself, and anyone can assert any handle. Use an org list instead.", uses: "attester, or use a list" },
  { name: "Account age checks", area: "Reputation", status: "attested", text: "An account signs its own timestamps and PLC timestamps aren't signed, so age isn't provable. Use a vouch or an on-chain link made earlier.", uses: "attester, or use a vouch" },
  { name: "Follower-count gates", area: "Access", status: "attested", text: "Counts are computed by an indexer, not signed by anyone, and fake followers are free.", uses: "attester, or use a vouch" },
  { name: "Takedown or suspension checks", area: "Reputation", status: "attested", text: "Hosting state isn't in the signed repo, so a contract can't see it.", uses: "attester" },
  { name: "did:web accounts", area: "Identity", status: "attested", text: "Trust rests on TLS and DNS, which a contract can't reach. Only did:plc works trustlessly.", uses: "attester" },
];
