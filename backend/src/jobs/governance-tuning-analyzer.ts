import pool from "../db/pool";
import { logger } from "../logger";
import { computeRecommendation, gatherAnalyzerInputs } from "../governance-tuning/analyzer";
import { getGovernanceTuningConfig } from "../governance-tuning/config-store";
import {
  insertRecommendation,
  getLatestRecommendation,
  touchLatestRecommendation,
  pruneUnchangedRecommendations,
} from "../governance-tuning/recommendation-store";
import { findUnresolvedAutoProposal, maybeAutoPropose } from "../governance-tuning/auto-propose";

const GOVERNANCE_TUNING_LOCK_KEY = "governance_tuning_analyzer_cycle";

/**
 * Governance tuning recommender (issue #998, #1125, #1126).
 *
 * Runs as a scheduled background service. Protected against race conditions
 * across horizontally-scaled backend replicas via a distributed Postgres
 * advisory lock (`pg_try_advisory_lock`).
 *
 * Implements a deduplication and retention policy: when recommendations are
 * unchanged across consecutive cycles, it updates the timestamp on the existing
 * latest record rather than inserting redundant rows, and prunes stale unchanged
 * records.
 */
export class GovernanceTuningAnalyzerService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  start() {
    const config = getGovernanceTuningConfig();
    config
      .then((c) => {
        logger.info({ intervalMs: c.intervalMs }, "Starting governance tuning analyzer");
        this.schedule(c.intervalMs);
      })
      .catch((err) => {
        logger.error({ err }, "Failed to start governance tuning analyzer");
      });
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
      // Re-read the config each cycle so an admin's PUT /governance-tuning/config
      // interval change takes effect on the next tick without a restart.
      const c = await getGovernanceTuningConfig().catch(() => null);
      this.schedule(c?.intervalMs ?? intervalMs);
    }, intervalMs);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runCycleWithLock();
    } catch (err) {
      logger.error({ err }, "Governance tuning analyzer cycle failed");
    } finally {
      this.running = false;
    }
  }

  /**
   * Acquires a Postgres advisory lock before running the cycle to guard
   * against concurrent executions from horizontally-scaled backend replicas.
   */
  async runCycleWithLock(): Promise<void> {
    const client = await pool.connect();
    try {
      const { rows } = await client.query(
        `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired`,
        [GOVERNANCE_TUNING_LOCK_KEY],
      );
      if (!rows[0]?.acquired) {
        logger.info(
          "Governance tuning: another replica is currently executing the tuning cycle — skipping",
        );
        return;
      }

      try {
        await this.runCycle();
      } finally {
        await client.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [
          GOVERNANCE_TUNING_LOCK_KEY,
        ]);
      }
    } finally {
      client.release();
    }
  }

  async runCycle(): Promise<void> {
    const config = await getGovernanceTuningConfig();
    const inputs = await gatherAnalyzerInputs(config.trailingWindow);
    if (!inputs) return;

    const result = computeRecommendation(inputs, config);

    const unchanged =
      result.recommendedQuorumNumerator === inputs.currentQuorumNumerator &&
      result.recommendedProposalThreshold === inputs.currentProposalThreshold;

    let proposalId: bigint | null = null;
    let autoProposed = false;
    if (!unchanged && config.autoPropose) {
      const pendingProposalId = await findUnresolvedAutoProposal();
      if (pendingProposalId !== null) {
        logger.info(
          { pendingProposalId: pendingProposalId.toString() },
          "Governance tuning: skipping auto-propose — a prior auto-proposed update_config hasn't resolved yet",
        );
      } else {
        proposalId = await maybeAutoPropose(inputs, result).catch((err) => {
          logger.error({ err }, "Governance tuning auto-propose failed");
          return null;
        });
        autoProposed = proposalId !== null;
      }
    }

    // De-duplication: when consecutive cycles produce unchanged recommendations,
    // update the timestamp on the existing latest record to avoid unbounded table bloat.
    const latest = await getLatestRecommendation();
    const isConsecutiveUnchanged =
      unchanged &&
      latest !== null &&
      latest.recommendedQuorumNumerator === result.recommendedQuorumNumerator &&
      latest.recommendedProposalThreshold === result.recommendedProposalThreshold &&
      !latest.autoProposed;

    if (isConsecutiveUnchanged) {
      await touchLatestRecommendation(latest.id);
      logger.info(
        { id: latest.id, unchanged: true, autoProposed: false },
        "Governance tuning: recommendation unchanged — updated last checked timestamp on latest row",
      );
      // Prune old unchanged rows periodically
      await pruneUnchangedRecommendations().catch((err) => {
        logger.warn({ err }, "Failed to prune old unchanged recommendations");
      });
      return;
    }

    const stored = await insertRecommendation({
      currentQuorumNumerator: inputs.currentQuorumNumerator,
      recommendedQuorumNumerator: result.recommendedQuorumNumerator,
      currentProposalThreshold: inputs.currentProposalThreshold,
      recommendedProposalThreshold: result.recommendedProposalThreshold,
      rationale: result.rationale,
      autoProposed,
      proposalId,
    });

    // Prune old unchanged rows on new insertion
    await pruneUnchangedRecommendations().catch((err) => {
      logger.warn({ err }, "Failed to prune old unchanged recommendations");
    });

    logger.info(
      { id: stored.id, unchanged, autoProposed },
      "Governance tuning recommendation computed",
    );
  }
}

export const governanceTuningAnalyzer = new GovernanceTuningAnalyzerService();
