import { GovernanceTuningClient } from "../governanceTuning";
import { GovernorError, GovernorErrorCode } from "../errors";

const BACKEND = "https://backend.example.com";

function makeClient(extra: Record<string, unknown> = {}) {
  return new GovernanceTuningClient({
    governorAddress: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
    timelockAddress: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
    votesAddress: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
    network: "testnet",
    backendUrl: BACKEND,
    maxAttempts: 1,
    baseDelayMs: 1,
    ...extra,
  });
}

const RAW_RECOMMENDATION = {
  id: 3,
  computed_at: "2026-01-01T00:00:00Z",
  current_quorum_numerator: 10,
  recommended_quorum_numerator: 12,
  current_proposal_threshold: 100,
  recommended_proposal_threshold: 80,
  rationale: "participation dropped",
  auto_proposed: true,
  proposal_id: 42,
};

const RAW_CONFIG = {
  min_quorum_numerator: 5,
  max_quorum_numerator: 20,
  max_quorum_delta_bps: 200,
  min_proposal_threshold: 50,
  max_proposal_threshold: 500,
  max_threshold_delta_bps: 300,
  trailing_window: 1000,
  interval_ms: 60000,
  auto_propose: true,
  updated_at: "2026-01-01T00:00:00Z",
};

describe("GovernanceTuningClient", () => {
  const originalFetch = global.fetch;
  let mockFetch: jest.Mock;

  beforeEach(() => {
    mockFetch = jest.fn();
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("constructor / backendUrl", () => {
    it("throws a GovernorError when backendUrl is missing", async () => {
      const client = new GovernanceTuningClient({
        governorAddress: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
        timelockAddress: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
        votesAddress: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
        network: "testnet",
        maxAttempts: 1,
      });
      await expect(client.getLatestRecommendation()).rejects.toBeInstanceOf(GovernorError);
      try {
        await client.getLatestRecommendation();
      } catch (e) {
        if (e instanceof GovernorError) {
          expect(e.code).toBe(GovernorErrorCode.SimulationFailed);
        }
      }
    });
  });

  describe("getLatestRecommendation", () => {
    it("maps the latest recommendation from the backend", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(RAW_RECOMMENDATION),
      });
      const client = makeClient();

      const rec = await client.getLatestRecommendation();

      expect(rec).toMatchObject({
        id: 3,
        currentQuorumNumerator: 10,
        recommendedQuorumNumerator: 12,
        currentProposalThreshold: 100n,
        recommendedProposalThreshold: 80n,
        rationale: "participation dropped",
        autoProposed: true,
        proposalId: 42n,
      });
      expect(mockFetch).toHaveBeenCalledWith(
        "https://backend.example.com/governance-tuning/recommendations/latest",
        undefined,
      );
    });

    it("returns null when the backend reports no recommendation yet", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(null),
      });
      const client = makeClient();

      expect(await client.getLatestRecommendation()).toBeNull();
    });
  });

  describe("getRecommendationHistory / getRecommendationHistoryPage", () => {
    it("returns a flat array of mapped recommendations", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          data: [RAW_RECOMMENDATION, { ...RAW_RECOMMENDATION, id: 4, proposal_id: null }],
        }),
      });
      const client = makeClient();

      const history = await client.getRecommendationHistory(2, 0);

      expect(history).toHaveLength(2);
      expect(history[0].id).toBe(3);
      expect(history[1].id).toBe(4);
      expect(history[1].proposalId).toBeNull();
      expect(mockFetch).toHaveBeenCalledWith(
        "https://backend.example.com/governance-tuning/recommendations?limit=2&offset=0",
        undefined,
      );
    });

    it("returns the page wrapper with pagination metadata", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          data: [RAW_RECOMMENDATION],
          pagination: { page: 1, limit: 20, hasMore: false },
        }),
      });
      const client = makeClient();

      const page = await client.getRecommendationHistoryPage(20, 0);

      expect(page.recommendations).toHaveLength(1);
      expect(page.pagination).toEqual({ page: 1, limit: 20, hasMore: false });
    });
  });

  describe("getConfig", () => {
    it("maps the tunable config from the backend", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(RAW_CONFIG),
      });
      const client = makeClient();

      const config = await client.getConfig();

      expect(config).toMatchObject({
        minQuorumNumerator: 5,
        maxQuorumNumerator: 20,
        maxQuorumDeltaBps: 200,
        minProposalThreshold: 50n,
        maxProposalThreshold: 500n,
        maxThresholdDeltaBps: 300,
        trailingWindow: 1000,
        intervalMs: 60000,
        autoPropose: true,
      });
      expect(mockFetch).toHaveBeenCalledWith(
        "https://backend.example.com/governance-tuning/config",
        undefined,
      );
    });
  });

  describe("error handling", () => {
    it("wraps a non-ok backend response in a GovernorError", async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500, json: jest.fn() });
      const client = makeClient();

      await expect(client.getConfig()).rejects.toBeInstanceOf(GovernorError);
      try {
        await client.getConfig();
      } catch (e) {
        if (e instanceof GovernorError) {
          expect(e.code).toBe(GovernorErrorCode.SimulationFailed);
        }
      }
    });
  });
});
