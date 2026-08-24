import pool from "../db/pool";

/**
 * One row of the indexer's `votes` table — a single `VoteCast` /
 * `VoteCastWithReason` event, i.e. one voter on one proposal.
 */
export interface EpochVoteRow {
  voter: string;
  weight: bigint;
}

/** What one address earned in one epoch. */
export interface RewardAllocation {
  address: string;
  /** Total voting power this address cast during the epoch. */
  weight: bigint;
  /** Their floor-rounded proportional share of the epoch's budget. */
  amount: bigint;
}

export interface EpochEligibility {
  allocations: RewardAllocation[];
  /** `sum(allocations[].amount)` — what the epoch is actually published for. */
  totalRewardAmount: bigint;
  totalWeight: bigint;
  uniqueVoters: number;
}

/**
 * Split `budget` across the addresses that voted, proportional to the voting
 * power each of them cast.
 *
 * Voting *more than once* in an epoch (on different proposals) is credited
 * once per proposal, not deduplicated: the whole point of the program is to
 * reward turnout, and the `votes` table's `UNIQUE(proposal_id, voter)` already
 * makes double-voting on a single proposal impossible, so summing every row is
 * exactly "how much voting power did this address bring to bear this epoch".
 *
 * Shares are floor-rounded, so the allocations can sum to slightly less than
 * `budget`. That remainder is deliberately left in the pool rather than being
 * handed to an arbitrary "last" voter: the epoch is published on-chain for
 * `totalRewardAmount` (the real sum), not for `budget`, so nothing gets
 * stranded in the contract's allocated-but-unclaimable bucket and the dust
 * simply rolls into the next epoch's available pool.
 *
 * A zero-participation epoch (no votes, or a zero/negative budget) is a valid
 * empty result, not an error — see `EpochRootPublisher`, which still publishes
 * such an epoch so the on-chain epoch history stays contiguous.
 */
export function computeProportionalRewards(
  votes: EpochVoteRow[],
  budget: bigint,
): EpochEligibility {
  const weightByVoter = new Map<string, bigint>();
  for (const vote of votes) {
    // Defensive: the contract can't record a non-positive weight, but a
    // malformed indexer row must not be able to skew everyone else's share.
    if (vote.weight <= 0n) continue;
    weightByVoter.set(vote.voter, (weightByVoter.get(vote.voter) ?? 0n) + vote.weight);
  }

  const totalWeight = [...weightByVoter.values()].reduce((acc, w) => acc + w, 0n);
  if (totalWeight === 0n || budget <= 0n) {
    return {
      allocations: [],
      totalRewardAmount: 0n,
      totalWeight,
      uniqueVoters: weightByVoter.size,
    };
  }

  const allocations: RewardAllocation[] = [];
  for (const [address, weight] of weightByVoter) {
    const amount = (budget * weight) / totalWeight;
    // A share that floors to zero has no claimable leaf — `claim` rejects a
    // non-positive amount — so it would only ever be dead weight in the tree.
    if (amount > 0n) allocations.push({ address, weight, amount });
  }
  allocations.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));

  return {
    allocations,
    totalRewardAmount: allocations.reduce((acc, a) => acc + a.amount, 0n),
    totalWeight,
    uniqueVoters: weightByVoter.size,
  };
}

/**
 * Every vote cast in `[startLedger, endLedger)`.
 *
 * Half-open on purpose, deviating from the issue's `BETWEEN`: epochs are
 * contiguous on-chain (`start_next_epoch` opens the next epoch *at* the
 * previous one's `end_ledger`), so an inclusive upper bound would credit
 * every vote landing exactly on a boundary ledger to two different epochs.
 */
export async function fetchEpochVotes(
  startLedger: number,
  endLedger: number,
): Promise<EpochVoteRow[]> {
  const result = await pool.query<{ voter: string; weight: string }>(
    `SELECT voter, weight FROM votes WHERE ledger >= $1 AND ledger < $2`,
    [startLedger, endLedger],
  );
  return result.rows.map((row) => ({ voter: row.voter, weight: BigInt(row.weight) }));
}

/**
 * How far the indexer has actually caught up. An epoch's `end_ledger` passing
 * on-chain isn't enough to compute its voter set — the indexer has to have
 * ingested that far, or the tail of the epoch's votes would be silently
 * missing from a root that can never be republished.
 */
export async function getIndexedLedgerHeight(): Promise<number> {
  const result = await pool.query<{ last_ledger: number }>(
    `SELECT last_ledger FROM indexer_state WHERE id = 1`,
  );
  return result.rows[0]?.last_ledger ?? 0;
}

/** Compute one epoch's eligibility straight from the indexed vote history. */
export async function computeEpochEligibility(
  startLedger: number,
  endLedger: number,
  budget: bigint,
): Promise<EpochEligibility> {
  const votes = await fetchEpochVotes(startLedger, endLedger);
  return computeProportionalRewards(votes, budget);
}
