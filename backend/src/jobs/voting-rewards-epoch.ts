import type { VotingRewardsClient, VotingRewardsEpoch } from "@nebgov/sdk";
import { logger } from "../logger";
import { computeEpochEligibility, getIndexedLedgerHeight } from "../voting-rewards/eligibility";
import { buildMerkleTree } from "../voting-rewards/merkle";
import {
  EMPTY_EPOCH_ROOT,
  buildVotingRewardsClient,
  getRelayerKeypair,
  publishEpochRoot,
} from "../voting-rewards/publisher";
import {
  getEpoch,
  getHighestPublishedEpochId,
  markEpochPublished,
  saveComputedEpoch,
  type StoredEpoch,
} from "../voting-rewards/store";

const DEFAULT_INTERVAL_MS = 3_600_000;

function getEpochBudget(): bigint | null {
  const raw = process.env.VOTING_REWARDS_EPOCH_BUDGET;
  if (!raw) return null;
  try {
    const budget = BigInt(raw);
    return budget > 0n ? budget : null;
  } catch {
    logger.error(
      { value: raw },
      "voting-rewards: VOTING_REWARDS_EPOCH_BUDGET is not an integer — the epoch job will not run",
    );
    return null;
  }
}

function getIntervalMs(): number {
  const raw = Number(process.env.VOTING_REWARDS_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 60_000 ? raw : DEFAULT_INTERVAL_MS;
}

/**
 * Voting participation rewards epoch service (issue #1011).
 *
 * Same footing as `GovernanceTuningAnalyzerService`: a background job started
 * from `bootstrap()`, not a one-off script. Each cycle it walks the epochs
 * that have closed on-chain and that the indexer has fully caught up to,
 * computes each one's `(address, amount)` set from the indexed vote history,
 * builds the Merkle tree, stores every claimant's proof, and hands the root
 * to `publishEpochRoot` to get on-chain.
 *
 * It only starts when `VOTING_REWARDS_CONTRACT_ID` (plus the governor
 * addresses) and `VOTING_REWARDS_EPOCH_BUDGET` are configured — an operator
 * has to say how much of the pool an epoch may pay out before anything is
 * committed on-chain.
 */
export class VotingRewardsEpochService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  start() {
    const client = buildVotingRewardsClient();
    if (!client) {
      logger.info(
        "voting-rewards: VOTING_REWARDS_CONTRACT_ID / governor addresses not configured — epoch job disabled",
      );
      return;
    }
    if (getEpochBudget() === null) {
      logger.info(
        "voting-rewards: VOTING_REWARDS_EPOCH_BUDGET not set — epoch job disabled",
      );
      return;
    }

    const intervalMs = getIntervalMs();
    logger.info({ intervalMs }, "Starting voting rewards epoch service");
    this.schedule(intervalMs);
    // Kick off an immediate first cycle rather than waiting a full interval.
    void this.tick();
  }

  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(intervalMs: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      await this.tick();
      this.schedule(getIntervalMs());
    }, intervalMs);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runCycle();
    } catch (err) {
      logger.error({ err }, "Voting rewards epoch cycle failed");
    } finally {
      this.running = false;
    }
  }

  async runCycle(): Promise<void> {
    const client = buildVotingRewardsClient();
    const budget = getEpochBudget();
    if (!client || budget === null) return;

    const [currentEpochId, indexedHeight, highestPublished] = await Promise.all([
      client.getCurrentEpochId(),
      getIndexedLedgerHeight(),
      getHighestPublishedEpochId(),
    ]);

    let epochId = highestPublished === null ? 0n : highestPublished + 1n;
    for (; epochId <= currentEpochId; epochId++) {
      const onchain = await client.getEpoch(epochId);

      // The epoch's end ledger passing on-chain is not enough: the indexer
      // has to have ingested that far, or the tail of the epoch's votes
      // would be missing from a root that can never be republished.
      if (indexedHeight < onchain.endLedger) break;

      const stored =
        (await getEpoch(epochId)) ?? (await this.computeEpoch(client, onchain, budget));

      if (onchain.finalized) {
        const publishedRoot = onchain.merkleRoot ?? EMPTY_EPOCH_ROOT;
        if ((stored.merkleRoot ?? EMPTY_EPOCH_ROOT) !== publishedRoot) {
          // Every proof we would serve for this epoch belongs to a different
          // tree than the one the contract verifies against, so they would
          // all be rejected. Loud, because it means the indexed vote history
          // this backend recomputed from no longer matches what was
          // published — a manual reconciliation, not something to paper over.
          logger.error(
            {
              epochId: epochId.toString(),
              computedRoot: stored.merkleRoot,
              publishedRoot,
            },
            "voting-rewards: computed epoch root does not match the root published on-chain",
          );
        }
        await markEpochPublished(epochId);
        continue;
      }

      const outcome = await publishEpochRoot(client, stored);
      if (outcome.kind === "skipped") {
        logger.info(
          { epochId: epochId.toString(), reason: outcome.reason },
          "voting-rewards: epoch root not published this cycle",
        );
        // Later epochs can't be published before this one is either, and
        // re-proposing down the chain would only pile up governance noise.
        break;
      }
    }

    await this.maybeRollEpoch(client, currentEpochId, indexedHeight);
  }

  /** Compute one epoch's allocations and proofs, and persist them. */
  private async computeEpoch(
    client: VotingRewardsClient,
    onchain: VotingRewardsEpoch,
    budget: bigint,
  ): Promise<StoredEpoch> {
    // Never commit more than the contract could actually pay: the available
    // pool already nets out every earlier epoch's unclaimed allocation.
    const available = await client.getAvailablePool();
    const effectiveBudget = budget < available ? budget : available;

    const { allocations, totalRewardAmount, uniqueVoters } = await computeEpochEligibility(
      onchain.startLedger,
      onchain.endLedger,
      effectiveBudget,
    );

    const tree = buildMerkleTree(
      allocations.map((a) => ({ address: a.address, amount: a.amount })),
      onchain.id,
    );

    await saveComputedEpoch(
      {
        epochId: onchain.id,
        startLedger: onchain.startLedger,
        endLedger: onchain.endLedger,
        merkleRoot: tree.root,
        totalRewardAmount,
      },
      tree.entries.map((entry, index) => ({
        epochId: onchain.id,
        claimantAddress: entry.address,
        amount: entry.amount,
        merkleProof: tree.proofFor(index),
      })),
    );

    logger.info(
      {
        epochId: onchain.id.toString(),
        uniqueVoters,
        rewardedAddresses: allocations.length,
        totalRewardAmount: totalRewardAmount.toString(),
      },
      "voting-rewards: computed epoch eligibility",
    );

    const stored = await getEpoch(onchain.id);
    if (!stored) {
      throw new Error(`voting-rewards: epoch ${onchain.id} vanished right after being saved`);
    }
    return stored;
  }

  /**
   * Roll the program into its next epoch once the current one has closed.
   *
   * `start_next_epoch` is permissionless, so this is a convenience rather
   * than a privileged action — but it still costs a transaction fee, so it
   * needs a funded relayer key and is opt-in via `VOTING_REWARDS_AUTO_ROLL`.
   */
  private async maybeRollEpoch(
    client: VotingRewardsClient,
    currentEpochId: bigint,
    indexedHeight: number,
  ): Promise<void> {
    if (process.env.VOTING_REWARDS_AUTO_ROLL !== "true") return;

    const relayer = getRelayerKeypair();
    if (!relayer) return;

    const current = await client.getEpoch(currentEpochId);
    if (indexedHeight < current.endLedger) return;

    try {
      const hash = await client.startNextEpoch(
        relayer as unknown as Parameters<typeof client.startNextEpoch>[0],
      );
      logger.info(
        { previousEpochId: currentEpochId.toString(), hash },
        "voting-rewards: rolled into the next epoch",
      );
    } catch (err) {
      logger.warn({ err }, "voting-rewards: failed to roll into the next epoch");
    }
  }
}

export const votingRewardsEpochService = new VotingRewardsEpochService();
