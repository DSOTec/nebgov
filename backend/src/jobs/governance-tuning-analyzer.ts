import { logger } from "../logger";
import { computeRecommendation, gatherAnalyzerInputs } from "../governance-tuning/analyzer";
import { getGovernanceTuningConfig } from "../governance-tuning/config-store";
import { insertRecommendation } from "../governance-tuning/recommendation-store";
import { findUnresolvedAutoProposal, maybeAutoPropose } from "../governance-tuning/auto-propose";

/**
 * Governance tuning recommender (issue #998). Same footing as
 * `NotificationProcessorService`: a standalone background job started from
 * `bootstrap()`, not a one-off script.
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
      await this.runCycle();
    } catch (err) {
      logger.error({ err }, "Governance tuning analyzer cycle failed");
    } finally {
      this.running = false;
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

    const stored = await insertRecommendation({
      currentQuorumNumerator: inputs.currentQuorumNumerator,
      recommendedQuorumNumerator: result.recommendedQuorumNumerator,
      currentProposalThreshold: inputs.currentProposalThreshold,
      recommendedProposalThreshold: result.recommendedProposalThreshold,
      rationale: result.rationale,
      autoProposed,
      proposalId,
    });

    logger.info(
      { id: stored.id, unchanged, autoProposed },
      "Governance tuning recommendation computed",
    );
  }
}

export const governanceTuningAnalyzer = new GovernanceTuningAnalyzerService();
