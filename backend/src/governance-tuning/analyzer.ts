import { logger } from "../logger";
import type { GovernanceTuningConfig } from "./config-store";
import type { TuningRecommendationRationale } from "./recommendation-store";

const INDEXER_URL = process.env.INDEXER_URL ?? "http://localhost:3002";

interface AllTimeStatsResponse {
  total_proposals: string;
  total_votes_cast: string;
  unique_voters: number;
  quorum_hit_count: string;
  quorum_miss_count: string;
  pass_rate_bps: number;
}

interface SnapshotRow {
  ledger: number;
  total_votes_cast: string;
  created_at: string;
}

interface SnapshotsResponse {
  data: SnapshotRow[];
}

interface ConfigHistoryRow {
  ledger: number;
  new_settings: { quorum_numerator: number; proposal_threshold: string | number };
}

interface ConfigHistoryResponse {
  data: ConfigHistoryRow[];
}

async function fetchJson<T>(path: string): Promise<T> {
  const resp = await fetch(`${INDEXER_URL}${path}`);
  if (!resp.ok) {
    throw new Error(`Indexer request to ${path} failed: ${resp.status}`);
  }
  return (await resp.json()) as T;
}

/** Everything the pure `computeRecommendation` formula needs, gathered from the indexer's existing analytics endpoints. */
export interface AnalyzerInputs {
  currentQuorumNumerator: number;
  currentProposalThreshold: bigint;
  quorumHitCount: bigint;
  quorumMissCount: bigint;
  /** `total_votes_cast` at each trailing snapshot, oldest first. */
  snapshotVotesCast: bigint[];
}

/**
 * Fetches everything `computeRecommendation` needs from the indexer's
 * already-existing `/analytics/*` and `/config-history` endpoints — no new
 * on-chain reads, per the issue's scope constraint.
 *
 * Current on-chain settings are sourced from `/config-history` (mirrors
 * `ConfigUpdated` events) rather than a fresh on-chain `get_settings()`
 * call, so this stays entirely indexer-backed. Returns `null` if the
 * governor has never had `update_config` called — the indexer has no way
 * to know the genesis settings in that case (same class of scope boundary
 * documented for `quorum_hit_count`/`quorum_miss_count` below).
 */
export async function gatherAnalyzerInputs(
  trailingWindow: number,
): Promise<AnalyzerInputs | null> {
  const [allTimeStats, snapshots, configHistory] = await Promise.all([
    fetchJson<AllTimeStatsResponse>("/analytics/all-time-stats"),
    fetchJson<SnapshotsResponse>(`/analytics/snapshots?limit=${trailingWindow * 2}`),
    fetchJson<ConfigHistoryResponse>("/config-history?limit=1"),
  ]);

  const latestConfig = configHistory.data[0];
  if (!latestConfig) {
    logger.warn(
      "governance-tuning: no config_updates rows yet — indexer doesn't know the governor's current settings, skipping cycle",
    );
    return null;
  }

  return {
    currentQuorumNumerator: Number(latestConfig.new_settings.quorum_numerator),
    currentProposalThreshold: BigInt(latestConfig.new_settings.proposal_threshold),
    quorumHitCount: BigInt(allTimeStats.quorum_hit_count),
    quorumMissCount: BigInt(allTimeStats.quorum_miss_count),
    // `/analytics/snapshots` is ordered ledger DESC; reverse to oldest-first for delta math.
    snapshotVotesCast: snapshots.data
      .slice()
      .reverse()
      .map((s) => BigInt(s.total_votes_cast)),
  };
}

export interface RecommendationResult {
  recommendedQuorumNumerator: number;
  recommendedProposalThreshold: bigint;
  rationale: TuningRecommendationRationale;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function clampBigint(value: bigint, min: bigint, max: bigint | null): bigint {
  if (value < min) return min;
  if (max !== null && value > max) return max;
  return value;
}

const TREND_EPSILON = 0.05; // 5% relative change before nudging quorum at all

function recommendQuorumNumerator(
  inputs: AnalyzerInputs,
  config: GovernanceTuningConfig,
): { value: number; rationale: TuningRecommendationRationale["quorumNumerator"] } {
  const deltas: number[] = [];
  for (let i = 1; i < inputs.snapshotVotesCast.length; i++) {
    // Converted to Number for trend math (relative change, not a settlement
    // amount) — same tradeoff the indexer's own bpsOf() participation helper
    // makes (packages/indexer/src/api.ts).
    deltas.push(Number(inputs.snapshotVotesCast[i] - inputs.snapshotVotesCast[i - 1]));
  }

  if (deltas.length < 2) {
    return {
      value: inputs.currentQuorumNumerator,
      rationale: { direction: "unchanged", reason: "insufficient snapshot history for a trend comparison (need at least 3 snapshots)" },
    };
  }

  const recentCount = Math.ceil(deltas.length / 2);
  const recent = deltas.slice(deltas.length - recentCount);
  const baseline = deltas.slice(0, deltas.length - recentCount);
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const recentAvg = avg(recent);
  const baselineAvg = avg(baseline);

  let relativeChange: number;
  if (baselineAvg === 0) {
    relativeChange = recentAvg > 0 ? 1 : 0;
  } else {
    relativeChange = (recentAvg - baselineAvg) / baselineAvg;
  }

  if (Math.abs(relativeChange) < TREND_EPSILON) {
    return {
      value: inputs.currentQuorumNumerator,
      rationale: {
        direction: "unchanged",
        reason: `trailing participation trend (${(relativeChange * 100).toFixed(1)}%) is within the ${TREND_EPSILON * 100}% no-op band`,
      },
    };
  }

  const direction = relativeChange > 0 ? "up" : "down";
  const deltaBps = Math.min(Math.round(Math.abs(relativeChange) * 10_000), config.maxQuorumDeltaBps);
  const unclamped = inputs.currentQuorumNumerator + (direction === "up" ? deltaBps : -deltaBps);
  const value = clamp(unclamped, config.minQuorumNumerator, config.maxQuorumNumerator);

  return {
    value,
    rationale: {
      direction,
      reason: `trailing participation is ${direction === "up" ? "up" : "down"} ${(Math.abs(relativeChange) * 100).toFixed(1)}% vs. the prior baseline window, nudging quorum ${direction} by ${Math.abs(value - inputs.currentQuorumNumerator)} bps (capped at ${config.maxQuorumDeltaBps} bps/cycle)`,
    },
  };
}

// Below this trailing quorum-hit rate, threshold nudges up (spam/noise reduction).
const LOW_HIT_RATE_BPS = 3_000;
// Above this trailing quorum-hit rate, threshold nudges down (participation isn't the bottleneck).
const HIGH_HIT_RATE_BPS = 8_000;

function recommendProposalThreshold(
  inputs: AnalyzerInputs,
  config: GovernanceTuningConfig,
): { value: bigint; rationale: TuningRecommendationRationale["proposalThreshold"] } {
  const totalSamples = inputs.quorumHitCount + inputs.quorumMissCount;

  // `/analytics/all-time-stats` documents quorum_hit_count/quorum_miss_count
  // as always "0" today — the indexer doesn't track eligible supply at each
  // proposal's start ledger yet (see the comment above that endpoint in
  // packages/indexer/src/api.ts). Rather than fabricate a hit rate, this
  // dimension is a documented no-op until that data exists — the formula
  // below is otherwise ready to use it the moment it's populated.
  if (totalSamples === 0n) {
    return {
      value: inputs.currentProposalThreshold,
      rationale: {
        direction: "unchanged",
        reason: "insufficient data: indexer's quorum_hit_count/quorum_miss_count are not yet populated (documented scope boundary on /analytics/all-time-stats)",
      },
    };
  }

  const hitRateBps = Number((inputs.quorumHitCount * 10_000n) / totalSamples);

  let direction: "up" | "down" | "unchanged" = "unchanged";
  let deltaBps = 0;
  if (hitRateBps >= HIGH_HIT_RATE_BPS) {
    direction = "down";
    deltaBps = Math.min(
      config.maxThresholdDeltaBps,
      Math.round(((hitRateBps - HIGH_HIT_RATE_BPS) * config.maxThresholdDeltaBps) / (10_000 - HIGH_HIT_RATE_BPS)),
    );
  } else if (hitRateBps <= LOW_HIT_RATE_BPS) {
    direction = "up";
    deltaBps = Math.min(
      config.maxThresholdDeltaBps,
      Math.round(((LOW_HIT_RATE_BPS - hitRateBps) * config.maxThresholdDeltaBps) / LOW_HIT_RATE_BPS),
    );
  }

  if (direction === "unchanged" || deltaBps === 0) {
    return {
      value: inputs.currentProposalThreshold,
      rationale: {
        direction: "unchanged",
        reason: `trailing quorum-hit rate (${(hitRateBps / 100).toFixed(1)}%) is within the healthy ${LOW_HIT_RATE_BPS / 100}%–${HIGH_HIT_RATE_BPS / 100}% band`,
      },
    };
  }

  const signedDeltaBps = BigInt(direction === "up" ? deltaBps : -deltaBps);
  const unclamped =
    inputs.currentProposalThreshold + (inputs.currentProposalThreshold * signedDeltaBps) / 10_000n;
  const value = clampBigint(unclamped, config.minProposalThreshold, config.maxProposalThreshold);

  return {
    value,
    rationale: {
      direction,
      reason: `trailing quorum-hit rate is ${(hitRateBps / 100).toFixed(1)}%, nudging proposal_threshold ${direction} by ${deltaBps} bps (capped at ${config.maxThresholdDeltaBps} bps/cycle)`,
    },
  };
}

/**
 * Pure recommendation formula — no I/O, so this is directly unit-testable
 * (see backend/src/__tests__/governance-tuning-analyzer.test.ts).
 *
 * `voting_period` is intentionally never adjusted: out of scope for
 * participation-based auto-tuning per the issue (timing changes interact
 * with active proposals in ways this formula doesn't model). The hook is
 * exposed via `rationale.votingPeriod` so a future config flag can turn it
 * on without changing this function's shape.
 */
export function computeRecommendation(
  inputs: AnalyzerInputs,
  config: GovernanceTuningConfig,
): RecommendationResult {
  const quorum = recommendQuorumNumerator(inputs, config);
  const threshold = recommendProposalThreshold(inputs, config);

  return {
    recommendedQuorumNumerator: quorum.value,
    recommendedProposalThreshold: threshold.value,
    rationale: {
      quorumNumerator: quorum.rationale,
      proposalThreshold: threshold.rationale,
      votingPeriod: {
        direction: "unchanged",
        reason: "voting_period auto-tuning is out of scope by default (timing changes interact with active proposals) — hook reserved for a future opt-in config flag",
      },
      inputs: {
        currentQuorumNumerator: inputs.currentQuorumNumerator,
        currentProposalThreshold: inputs.currentProposalThreshold.toString(),
        quorumHitCount: inputs.quorumHitCount.toString(),
        quorumMissCount: inputs.quorumMissCount.toString(),
        // Oldest-first cumulative total_votes_cast at each trailing
        // snapshot — the raw series behind the quorum_numerator trend
        // comparison above, for the frontend's participation trend chart.
        snapshotVotesCast: inputs.snapshotVotesCast.map((v) => v.toString()),
      },
    },
  };
}
