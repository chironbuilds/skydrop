/** Test results, copied from real runs. Update together with a release; don't estimate. */
export const TESTED_AT = "2026-11-05 on Ootle 0.49.2";

export const TESTS: { name: string; covers: string; passed: number }[] = [
  { name: "campaigns", covers: "All nine rules, payout binding, vouches, allocations, rounds, referrals, linked claims, funder limits, receipts, either/or steps, required wording, website cross-check", passed: 20 },
  { name: "atp-verify", covers: "Identity chains, repo proofs, record fields, service-auth tokens", passed: 18 },
  { name: "verifier", covers: "The shared Verifier component's public methods", passed: 3 },
  { name: "escrow", covers: "Custody, refunds, per-account ledgers, vault rotation, deposit lanes, policy approval", passed: 8 },
  { name: "escrowprobe", covers: "The Escrow's rules against approved policies that misbehave", passed: 5 },
  { name: "claim", covers: "Gifts: windows, phrases, holds, sponsored fees, rotated keys", passed: 10 },
  { name: "linkclaim", covers: "Linked wallets: delivery, code-free claims, declines", passed: 3 },
  { name: "linkreg", covers: "Per-DID records, vault rotation, links, floors, challenges, delays", passed: 7 },
  { name: "tippolicy", covers: "Tips authorized by a signed post", passed: 1 },
  { name: "engbounty", covers: "Slot-based like, repost, follow and post bounties", passed: 2 },
  { name: "listdrop", covers: "Slot-based drops to an org's list", passed: 2 },
  { name: "servicepay", covers: "Metered payments from service-auth tokens", passed: 2 },
  { name: "recovery", covers: "Guardian-based vault recovery", passed: 2 },
];
