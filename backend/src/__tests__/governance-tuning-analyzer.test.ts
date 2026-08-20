import { computeRecommendation, type AnalyzerInputs } from "../governance-tuning/analyzer";
import type { GovernanceTuningConfig } from "../governance-tuning/config-store";

function makeConfig(overrides: Partial<GovernanceTuningConfig> = {}): GovernanceTuningConfig {
  return {
    minQuorumNumerator: 100,
    maxQuorumNumerator: 5_000,
    maxQuorumDeltaBps: 200,
    minProposalThreshold: 0n,
    maxProposalThreshold: null,
    maxThresholdDeltaBps: 1_000,
    trailingWindow: 10,
    intervalMs: 3_600_000,
    autoPropose: false,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeInputs(overrides: Partial<AnalyzerInputs> = {}): AnalyzerInputs {
  return {
    currentQuorumNumerator: 1_000,
    currentProposalThreshold: 1_000_000n,
    quorumHitCount: 0n,
    quorumMissCount: 0n,
    snapshotVotesCast: [],
    ...overrides,
  };
}

describe("computeRecommendation — quorum_numerator", () => {
  it("leaves quorum unchanged with fewer than 3 snapshots (no baseline to compare against)", () => {
    const result = computeRecommendation(
      makeInputs({ snapshotVotesCast: [100n, 200n] }),
      makeConfig(),
    );
    expect(result.recommendedQuorumNumerator).toBe(1_000);
    expect(result.rationale.quorumNumerator.direction).toBe("unchanged");
  });

  it("nudges quorum up when trailing participation is rising well past the no-op band", () => {
    // baseline deltas: [10, 10] avg 10; recent deltas: [10, 100] avg 55 -> +450%
    const result = computeRecommendation(
      makeInputs({ snapshotVotesCast: [0n, 10n, 20n, 30n, 130n] }),
      makeConfig(),
    );
    expect(result.rationale.quorumNumerator.direction).toBe("up");
    expect(result.recommendedQuorumNumerator).toBeGreaterThan(1_000);
  });

  it("nudges quorum down when trailing participation is falling well past the no-op band", () => {
    const result = computeRecommendation(
      makeInputs({ snapshotVotesCast: [0n, 100n, 200n, 210n, 215n] }),
      makeConfig(),
    );
    expect(result.rationale.quorumNumerator.direction).toBe("down");
    expect(result.recommendedQuorumNumerator).toBeLessThan(1_000);
  });

  it("stays unchanged when trailing participation is within the no-op band", () => {
    const result = computeRecommendation(
      makeInputs({ snapshotVotesCast: [0n, 100n, 200n, 300n, 402n] }),
      makeConfig(),
    );
    expect(result.rationale.quorumNumerator.direction).toBe("unchanged");
    expect(result.recommendedQuorumNumerator).toBe(1_000);
  });

  it("never recommends a step larger than max_quorum_delta_bps in one cycle", () => {
    const result = computeRecommendation(
      makeInputs({ snapshotVotesCast: [0n, 1n, 1n, 100_000n] }),
      makeConfig({ maxQuorumDeltaBps: 50 }),
    );
    expect(
      Math.abs(result.recommendedQuorumNumerator - 1_000),
    ).toBeLessThanOrEqual(50);
  });

  it("clamps the recommendation to [min_quorum_numerator, max_quorum_numerator]", () => {
    const result = computeRecommendation(
      makeInputs({ currentQuorumNumerator: 4_950, snapshotVotesCast: [0n, 10n, 20n, 30n, 200n] }),
      makeConfig({ maxQuorumNumerator: 5_000, maxQuorumDeltaBps: 500 }),
    );
    expect(result.recommendedQuorumNumerator).toBeLessThanOrEqual(5_000);
  });
});

describe("computeRecommendation — proposal_threshold", () => {
  it("stays unchanged when quorum_hit_count and quorum_miss_count are both zero (documented indexer gap)", () => {
    const result = computeRecommendation(
      makeInputs({ quorumHitCount: 0n, quorumMissCount: 0n }),
      makeConfig(),
    );
    expect(result.rationale.proposalThreshold.direction).toBe("unchanged");
    expect(result.rationale.proposalThreshold.reason).toMatch(/insufficient data/i);
    expect(result.recommendedProposalThreshold).toBe(1_000_000n);
  });

  it("nudges threshold down when the trailing quorum-hit rate is high (quorum isn't the bottleneck)", () => {
    const result = computeRecommendation(
      makeInputs({ quorumHitCount: 95n, quorumMissCount: 5n }),
      makeConfig(),
    );
    expect(result.rationale.proposalThreshold.direction).toBe("down");
    expect(result.recommendedProposalThreshold).toBeLessThan(1_000_000n);
  });

  it("nudges threshold up when the trailing quorum-hit rate is low (spam/noise reduction)", () => {
    const result = computeRecommendation(
      makeInputs({ quorumHitCount: 5n, quorumMissCount: 95n }),
      makeConfig(),
    );
    expect(result.rationale.proposalThreshold.direction).toBe("up");
    expect(result.recommendedProposalThreshold).toBeGreaterThan(1_000_000n);
  });

  it("stays unchanged when the trailing hit rate is within the healthy band", () => {
    const result = computeRecommendation(
      makeInputs({ quorumHitCount: 55n, quorumMissCount: 45n }),
      makeConfig(),
    );
    expect(result.rationale.proposalThreshold.direction).toBe("unchanged");
    expect(result.recommendedProposalThreshold).toBe(1_000_000n);
  });

  it("never moves the threshold by more than max_threshold_delta_bps in one cycle", () => {
    const result = computeRecommendation(
      makeInputs({ currentProposalThreshold: 1_000_000n, quorumHitCount: 100n, quorumMissCount: 0n }),
      makeConfig({ maxThresholdDeltaBps: 100 }),
    );
    const delta = result.recommendedProposalThreshold - 1_000_000n;
    expect(delta < 0n ? -delta : delta).toBeLessThanOrEqual(10_000n); // 100 bps of 1_000_000
  });

  it("clamps the recommendation to min_proposal_threshold", () => {
    const result = computeRecommendation(
      makeInputs({ currentProposalThreshold: 100n, quorumHitCount: 100n, quorumMissCount: 0n }),
      makeConfig({ minProposalThreshold: 90n, maxThresholdDeltaBps: 10_000 }),
    );
    expect(result.recommendedProposalThreshold).toBeGreaterThanOrEqual(90n);
  });
});

describe("computeRecommendation — voting_period", () => {
  it("is always left untouched (out of scope for participation-based auto-tuning)", () => {
    const result = computeRecommendation(
      makeInputs({ snapshotVotesCast: [0n, 10n, 20n, 30n, 130n], quorumHitCount: 95n, quorumMissCount: 5n }),
      makeConfig(),
    );
    expect(result.rationale.votingPeriod.direction).toBe("unchanged");
  });
});
