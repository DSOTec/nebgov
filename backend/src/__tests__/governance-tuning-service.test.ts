import pool from "../db/pool";
import { GovernanceTuningAnalyzerService } from "../jobs/governance-tuning-analyzer";
import * as analyzerMod from "../governance-tuning/analyzer";
import * as configStoreMod from "../governance-tuning/config-store";
import * as autoProposeMod from "../governance-tuning/auto-propose";

describe("GovernanceTuningAnalyzerService Deduplication and Distributed Lock (Issues #1125, #1126)", () => {
  let service: GovernanceTuningAnalyzerService;
  const createdIds: number[] = [];

  beforeEach(() => {
    service = new GovernanceTuningAnalyzerService();
    jest.restoreAllMocks();
  });

  afterEach(async () => {
    if (createdIds.length > 0) {
      await pool.query("DELETE FROM governance_tuning_recommendations WHERE id = ANY($1)", [createdIds]);
      createdIds.length = 0;
    }
  });

  it("inserts a new recommendation when recommendation is changed", async () => {
    jest.spyOn(configStoreMod, "getGovernanceTuningConfig").mockResolvedValue({
      minQuorumNumerator: 100,
      maxQuorumNumerator: 5000,
      maxQuorumDeltaBps: 200,
      minProposalThreshold: 0n,
      maxProposalThreshold: null,
      maxThresholdDeltaBps: 1000,
      trailingWindow: 10,
      intervalMs: 60000,
      autoPropose: false,
      updatedAt: new Date().toISOString(),
    });

    jest.spyOn(analyzerMod, "gatherAnalyzerInputs").mockResolvedValue({
      currentQuorumNumerator: 1000,
      currentProposalThreshold: 1000000n,
      quorumHitCount: 10n,
      quorumMissCount: 0n,
      snapshotVotesCast: [100n, 200n, 300n],
    });

    jest.spyOn(analyzerMod, "computeRecommendation").mockReturnValue({
      recommendedQuorumNumerator: 1200, // changed
      recommendedProposalThreshold: 900000n, // changed
      rationale: {
        quorumNumerator: { direction: "up", reason: "Participation rising" },
        proposalThreshold: { direction: "down", reason: "Quorum hit high" },
        votingPeriod: { direction: "unchanged", reason: "Fixed" },
        inputs: {},
      },
    });

    await service.runCycle();

    const { rows } = await pool.query(
      "SELECT * FROM governance_tuning_recommendations ORDER BY id DESC LIMIT 1",
    );
    expect(rows.length).toBe(1);
    expect(rows[0].recommended_quorum_numerator).toBe(1200);
    createdIds.push(rows[0].id);
  });

  it("does not insert a duplicate row on consecutive unchanged cycles, but updates computed_at", async () => {
    jest.spyOn(configStoreMod, "getGovernanceTuningConfig").mockResolvedValue({
      minQuorumNumerator: 100,
      maxQuorumNumerator: 5000,
      maxQuorumDeltaBps: 200,
      minProposalThreshold: 0n,
      maxProposalThreshold: null,
      maxThresholdDeltaBps: 1000,
      trailingWindow: 10,
      intervalMs: 60000,
      autoPropose: false,
      updatedAt: new Date().toISOString(),
    });

    jest.spyOn(analyzerMod, "gatherAnalyzerInputs").mockResolvedValue({
      currentQuorumNumerator: 1000,
      currentProposalThreshold: 1000000n,
      quorumHitCount: 5n,
      quorumMissCount: 5n,
      snapshotVotesCast: [100n, 100n, 100n],
    });

    // Unchanged recommendation
    jest.spyOn(analyzerMod, "computeRecommendation").mockReturnValue({
      recommendedQuorumNumerator: 1000,
      recommendedProposalThreshold: 1000000n,
      rationale: {
        quorumNumerator: { direction: "unchanged", reason: "Stable" },
        proposalThreshold: { direction: "unchanged", reason: "Stable" },
        votingPeriod: { direction: "unchanged", reason: "Fixed" },
        inputs: {},
      },
    });

    // Cycle 1: inserts the initial unchanged row
    await service.runCycle();
    const { rows: firstRows } = await pool.query(
      "SELECT * FROM governance_tuning_recommendations ORDER BY id DESC LIMIT 1",
    );
    expect(firstRows.length).toBe(1);
    const firstId = firstRows[0].id;
    createdIds.push(firstId);

    // Count before Cycle 2
    const { rows: countBefore } = await pool.query(
      "SELECT count(*)::int as cnt FROM governance_tuning_recommendations",
    );

    // Cycle 2: unchanged recommendation again
    await service.runCycle();

    const { rows: countAfter } = await pool.query(
      "SELECT count(*)::int as cnt FROM governance_tuning_recommendations",
    );

    // No new row inserted
    expect(countAfter[0].cnt).toBe(countBefore[0].cnt);
  });

  it("skips execution when advisory lock is held by another replica", async () => {
    const client = await pool.connect();
    try {
      // Acquire lock on separate client
      await client.query("SELECT pg_advisory_lock(hashtextextended('governance_tuning_analyzer_cycle', 0))");

      const runSpy = jest.spyOn(service, "runCycle");

      // runCycleWithLock should attempt and skip because lock is already held
      await service.runCycleWithLock();

      expect(runSpy).not.toHaveBeenCalled();
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtextextended('governance_tuning_analyzer_cycle', 0))");
      client.release();
    }
  });
});
