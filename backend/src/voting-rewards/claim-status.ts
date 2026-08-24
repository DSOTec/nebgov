import { logger } from "../logger";
import { buildVotingRewardsClient } from "./publisher";
import { markClaimed, type StoredClaim } from "./store";

/**
 * The stored `claimed` flag is a cache, not the truth — a voter claims by
 * submitting a transaction straight to the contract, which this backend never
 * sees. So before answering "what can I still claim?", reconcile the rows
 * that still look unclaimed against the contract's own `has_claimed`, and
 * write back anything that has since been paid out.
 *
 * When no voting-rewards contract is configured (tests, an indexer-only
 * deployment) the stored flags stand as-is rather than the endpoint failing.
 */
export async function refreshClaimStatuses(claims: StoredClaim[]): Promise<StoredClaim[]> {
  const outstanding = claims.filter((claim) => !claim.claimed);
  if (outstanding.length === 0) return claims;

  const client = buildVotingRewardsClient();
  if (!client) return claims;

  const nowClaimed = new Set<string>();
  await Promise.all(
    outstanding.map(async (claim) => {
      try {
        if (await client.hasClaimed(claim.epochId, claim.claimantAddress)) {
          await markClaimed(claim.epochId, claim.claimantAddress);
          nowClaimed.add(claim.epochId.toString());
        }
      } catch (err) {
        // A single unreachable RPC read must not fail the whole response —
        // the stored flag is then simply stale, and a claim the voter has
        // already made is rejected on-chain rather than silently double-paid.
        logger.warn(
          { err, epochId: claim.epochId.toString(), address: claim.claimantAddress },
          "voting-rewards: could not refresh on-chain claim status",
        );
      }
    }),
  );

  if (nowClaimed.size === 0) return claims;
  return claims.map((claim) =>
    nowClaimed.has(claim.epochId.toString()) ? { ...claim, claimed: true } : claim,
  );
}
