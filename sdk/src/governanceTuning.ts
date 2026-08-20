import { GovernorError, GovernorErrorCode } from "./errors";
import { withRetry, isNetworkError } from "./utils";
import type {
  GovernorConfig,
  TuningConfig,
  TuningRecommendation,
  TuningRecommendationPage,
} from "./types";

function mapRecommendation(raw: any): TuningRecommendation {
  return {
    id: Number(raw.id),
    computedAt: raw.computed_at,
    currentQuorumNumerator: Number(raw.current_quorum_numerator),
    recommendedQuorumNumerator: Number(raw.recommended_quorum_numerator),
    currentProposalThreshold: BigInt(raw.current_proposal_threshold),
    recommendedProposalThreshold: BigInt(raw.recommended_proposal_threshold),
    rationale: raw.rationale,
    autoProposed: Boolean(raw.auto_proposed),
    proposalId: raw.proposal_id === null || raw.proposal_id === undefined ? null : BigInt(raw.proposal_id),
  };
}

function mapConfig(raw: any): TuningConfig {
  return {
    minQuorumNumerator: Number(raw.min_quorum_numerator),
    maxQuorumNumerator: Number(raw.max_quorum_numerator),
    maxQuorumDeltaBps: Number(raw.max_quorum_delta_bps),
    minProposalThreshold: BigInt(raw.min_proposal_threshold),
    maxProposalThreshold: raw.max_proposal_threshold === null ? null : BigInt(raw.max_proposal_threshold),
    maxThresholdDeltaBps: Number(raw.max_threshold_delta_bps),
    trailingWindow: Number(raw.trailing_window),
    intervalMs: Number(raw.interval_ms),
    autoPropose: Boolean(raw.auto_propose),
    updatedAt: raw.updated_at,
  };
}

/**
 * Client for the governance tuning recommender (issue #998).
 *
 * Unlike every other indexer-backed client in this SDK (e.g.
 * {@link ReputationClient}'s `getScore`/`getLeaderboard`), this one talks
 * to the **backend** (`backend/src/routes/governance-tuning.ts`), not the
 * indexer or Soroban RPC — the recommender's state (recommendations,
 * tunable config) lives in the backend's Postgres schema, not the
 * indexer's. Requires `config.backendUrl` to be set.
 *
 * @example
 * const client = new GovernanceTuningClient({ ...config, backendUrl: "https://api.nebgov.dev" });
 * const latest = await client.getLatestRecommendation();
 */
export class GovernanceTuningClient {
  private readonly config: GovernorConfig;

  constructor(config: GovernorConfig) {
    this.config = config;
  }

  private async retry<T>(fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, {
      maxAttempts: this.config.maxAttempts,
      baseDelayMs: this.config.baseDelayMs,
      retryOn: isNetworkError,
    });
  }

  private async backendRequest<T>(path: string, init?: RequestInit): Promise<T> {
    if (!this.config.backendUrl) {
      throw new GovernorError(
        GovernorErrorCode.SimulationFailed,
        `GovernanceTuningClient requires config.backendUrl to be set`,
      );
    }
    return this.retry(async () => {
      const resp = await fetch(`${this.config.backendUrl}${path}`, init);
      if (!resp.ok) {
        throw new GovernorError(
          GovernorErrorCode.SimulationFailed,
          `Backend request failed: ${resp.status}`,
        );
      }
      return resp.json() as Promise<T>;
    });
  }

  /**
   * Fetch the most recently computed recommendation.
   *
   * Hits `GET /governance-tuning/recommendations/latest`. Returns `null`
   * if the analyzer hasn't completed a cycle yet.
   */
  async getLatestRecommendation(): Promise<TuningRecommendation | null> {
    const raw = await this.backendRequest<any>("/governance-tuning/recommendations/latest");
    return raw === null ? null : mapRecommendation(raw);
  }

  /**
   * Fetch past recommendations as a flat array, newest first.
   *
   * Hits `GET /governance-tuning/recommendations`. For pagination metadata
   * (e.g. "load more" UI), use {@link getRecommendationHistoryPage} instead.
   *
   * @param limit  - Maximum number of entries to return (default 20, max 100 per the backend)
   * @param offset - Number of entries to skip for pagination (default 0)
   */
  async getRecommendationHistory(limit = 20, offset = 0): Promise<TuningRecommendation[]> {
    const { recommendations } = await this.getRecommendationHistoryPage(limit, offset);
    return recommendations;
  }

  /**
   * Fetch a single page of recommendations with pagination metadata.
   *
   * Hits `GET /governance-tuning/recommendations`.
   *
   * @param limit  - Page size (default 20, max 100 per the backend)
   * @param offset - Page offset (default 0)
   */
  async getRecommendationHistoryPage(limit = 20, offset = 0): Promise<TuningRecommendationPage> {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    const raw = await this.backendRequest<any>(`/governance-tuning/recommendations?${params}`);
    return {
      recommendations: (raw.data as any[]).map(mapRecommendation),
      pagination: raw.pagination,
    };
  }

  /**
   * Fetch the recommender's current tunable config (bands, per-cycle delta
   * caps, interval, auto-propose toggle).
   *
   * Hits `GET /governance-tuning/config`.
   */
  async getConfig(): Promise<TuningConfig> {
    const raw = await this.backendRequest<any>("/governance-tuning/config");
    return mapConfig(raw);
  }
}
