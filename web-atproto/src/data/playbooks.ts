import type { Rule } from "../lib/campaign";

export interface Playbook {
  id: string;
  name: string;
  tag: "Growth" | "Community" | "Allocation" | "Retention" | "Events";
  goal: string;
  how: string;
  rules: (Pick<Rule, "kind"> & { hint: string; text?: string })[];
  reward: string;
  budget: string;
  rounds?: number;
  roundDays?: number;
  bonus?: string;
  maxReferrals?: number;
  days: number;
  usesAllocation?: boolean;
  caution: string;
}

/** Starting points for the builder. Rewards are placeholders in tTARI, to be set by whoever runs the campaign. */
export const PLAYBOOKS: Playbook[] = [
  { id: "launch-quest", name: "Launch quest", tag: "Growth", goal: "Spread one announcement as far as it can go in a short window.", how: "Like and repost the announcement, follow the account, then post the launch hashtag.", rules: [{ kind: 0, hint: "The announcement post" }, { kind: 1, hint: "The announcement post" }, { kind: 2, hint: "The project's account" }, { kind: 3, hint: "Launch hashtag", text: "#OotleLaunch" }], reward: "1", budget: "500", days: 7, caution: "Open to anyone, so farmable. Keep the reward small and the window short." },
  { id: "stay-and-earn", name: "Follow and stay", tag: "Retention", goal: "Pay for people who are still around in a month, not for a click.", how: "Follow the account and post once a week. Each week's payment needs a new post and a fresh proof.", rules: [{ kind: 2, hint: "The project's account" }, { kind: 3, hint: "Community tag", text: "#TariWeekly" }], reward: "1", budget: "1000", rounds: 4, roundDays: 7, days: 35, caution: "A proof shows a follow exists at a commit, and fresh commits are required, but a determined account could unfollow between rounds." },
  { id: "hashtag", name: "Hashtag challenge", tag: "Growth", goal: "Get people posting about a topic in their own words.", how: "Post anything containing the tag.", rules: [{ kind: 3, hint: "Required tag", text: "#BuiltOnOotle" }], reward: "0.5", budget: "250", days: 14, caution: "Any text counts, so spam counts. Review results and pair with a vouch rule if quality matters." },
  { id: "quote-storm", name: "Quote amplification", tag: "Growth", goal: "Get a post quoted with commentary, which reaches further than a repost.", how: "Quote the post. Quotes with images or video count too.", rules: [{ kind: 5, hint: "The post to quote" }], reward: "1", budget: "200", days: 5, caution: "A contract can't judge commentary, so an empty quote pays too." },
  { id: "ama", name: "AMA participation", tag: "Community", goal: "Bring people into a live thread.", how: "Reply anywhere in the thread and follow the host.", rules: [{ kind: 4, hint: "The AMA post" }, { kind: 2, hint: "The host" }], reward: "0.5", budget: "100", days: 2, caution: "A reply's quality isn't checked. Short windows keep this honest." },
  { id: "referrals", name: "Referral sprint", tag: "Growth", goal: "Have existing supporters bring their friends.", how: "Complete the quest and name who sent you. Your referrer earns a bonus up to a cap.", rules: [{ kind: 2, hint: "The project's account" }, { kind: 1, hint: "The announcement post" }], reward: "1", budget: "400", bonus: "0.25", maxReferrals: 5, days: 10, caution: "The easiest campaign type to farm: one person can refer their own fake accounts. Use a vouch rule when the bonus is worth anything." },
  { id: "contributors", name: "Contributor drop", tag: "Allocation", goal: "Reward the people who actually did the work.", how: "Curate a Bluesky list of contributors. Each one on it can claim once.", rules: [{ kind: 6, hint: "Your contributor list" }], reward: "25", budget: "1000", days: 60, caution: "Set the snapshot once the list is final. Someone removed afterwards can still prove an older commit." },
  { id: "org-vouched", name: "Followed by the project", tag: "Community", goal: "Reward people the project has already noticed.", how: "Anyone the project's account follows can claim, with no list to maintain.", rules: [{ kind: 7, hint: "The project's account" }, { kind: 3, hint: "Claim line", text: "#TariCommunity" }], reward: "5", budget: "500", days: 30, caution: "Whoever controls the account controls eligibility, and a follow can be asked for." },
  { id: "verified", name: "Verified voices", tag: "Community", goal: "Reach accounts a trusted verifier has already vouched for.", how: "Claimants need a Bluesky verification record from the verifier you name.", rules: [{ kind: 8, hint: "A trusted verifier" }, { kind: 1, hint: "The post to share" }], reward: "10", budget: "500", days: 21, caution: "Few accounts qualify, so check the verifier has actually verified people." },
  { id: "retro", name: "Retroactive airdrop", tag: "Allocation", goal: "Pay each person a different amount for what they already did.", how: "Upload who gets what. Only the list's fingerprint goes on-chain, and each person proves their own line.", rules: [], reward: "0", budget: "5000", days: 90, usesAllocation: true, caution: "You are trusted to get the list right. Publish it so anyone can check it." },
  { id: "grants", name: "Bounties and grants", tag: "Allocation", goal: "Pay winners of bug hunts or grants, and have them say so publicly.", how: "Put winners and amounts on the list, and require a post naming the programme.", rules: [{ kind: 3, hint: "Programme tag", text: "#TariGrants" }], reward: "0", budget: "10000", days: 120, usesAllocation: true, caution: "Winners need a Bluesky account. Check their DIDs before you publish the list." },
  { id: "poap", name: "Event badge", tag: "Events", goal: "Give attendees a permanent, non-transferable record they were there.", how: "Add attendees to a list. They claim a tiny reward plus a soulbound receipt.", rules: [{ kind: 6, hint: "The attendee list" }], reward: "0.1", budget: "50", days: 30, caution: "The receipt can't be moved, but the reward can. It proves the claim, not attendance itself: the list owner vouches for that." },
  { id: "ambassadors", name: "Ambassador seasons", tag: "Retention", goal: "Pay a named group for steady activity over months.", how: "Ambassadors on your list post with the tag every two weeks for a season.", rules: [{ kind: 6, hint: "The ambassador list" }, { kind: 3, hint: "Season tag", text: "#TariSeason1" }], reward: "10", budget: "2000", rounds: 6, roundDays: 14, days: 90, caution: "The contract checks a post exists, not whether it's any good." },
  { id: "testnet", name: "Testnet onboarding", tag: "Growth", goal: "Get people to try Ootle and leave a public trace.", how: "Post about trying the testnet. Linked wallets can be paid by a relayer with no fee of their own.", rules: [{ kind: 3, hint: "Campaign tag", text: "#TriedOotle" }, { kind: 2, hint: "The project's account" }], reward: "2", budget: "500", days: 21, caution: "Testnet tokens have no value, so this is good for dry runs of any other playbook." },
];
