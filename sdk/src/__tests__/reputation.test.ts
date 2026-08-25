import { ReputationClient } from "../reputation";
import { GovernorErrorCode } from "../errors";
import { StrKey } from "@stellar/stellar-sdk";

describe("ReputationClient", () => {
  const contractAddress = StrKey.encodeContract(Buffer.alloc(32, 1));
  const originalFetch = global.fetch;
  let mockFetch: jest.Mock;

  const makeClient = (indexerUrl?: string) =>
    new ReputationClient({
      governorAddress: contractAddress,
      timelockAddress: contractAddress,
      votesAddress: contractAddress,
      network: "testnet",
      indexerUrl,
      maxAttempts: 1,
    });

  beforeEach(() => {
    mockFetch = jest.fn();
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it("requires an indexer URL for indexer-backed methods", async () => {
    await expect(makeClient().getScore("GABC")).rejects.toMatchObject({
      code: GovernorErrorCode.SimulationFailed,
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("maps a proposer score summary", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        address: "GABC",
        reputation_score: "81",
        threshold_multiplier_bps: "9500",
        total_proposals: "9",
        consecutive_successful: "3",
        consecutive_failed: "1",
        last_updated_ledger: "77",
      }),
    });

    const score = await makeClient("https://indexer.example").getScore("GABC");
    expect(score).toEqual(expect.objectContaining({
      address: "GABC",
      reputationScore: 81,
      lastUpdatedLedger: 77,
    }));
    expect(mockFetch).toHaveBeenCalledWith("https://indexer.example/reputation/GABC");
  });

  it("maps paginated score history and leaderboard responses", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue({
          history: [{ ledger: "10", score: "70", change: "5", reason: "proposal_executed" }],
          pagination: { limit: 1, offset: 0, hasMore: true },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue({
          leaderboard: [{ address: "GABC", reputation_score: "70", last_updated_ledger: "10" }],
        }),
      });

    const client = makeClient("https://indexer.example");
    await expect(client.getScoreHistoryPage("GABC", 1, 0)).resolves.toEqual({
      history: [{ ledger: 10, score: 70, change: 5, reason: "proposal_executed" }],
      pagination: { limit: 1, offset: 0, hasMore: true },
    });
    await expect(client.getLeaderboardPage(1, 0)).resolves.toEqual({
      leaderboard: [{ rank: 1, proposer: "GABC", reputationScore: 70, lastUpdatedLedger: 10 }],
      pagination: { limit: 1, offset: 0 },
    });
  });

  it("preserves bigint threshold history values", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        history: [{ ledger: "12", old_threshold: "9007199254740993", new_threshold: "9007199254740994" }],
        pagination: { limit: 20, offset: 0, hasMore: false },
      }),
    });

    await expect(
      makeClient("https://indexer.example").getThresholdHistoryPage("GABC"),
    ).resolves.toEqual({
      history: [{ ledger: 12, oldThreshold: 9007199254740993n, newThreshold: 9007199254740994n }],
      pagination: { limit: 20, offset: 0, hasMore: false },
    });
  });

  it("surfaces non-success indexer responses as typed errors", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503 });
    await expect(makeClient("https://indexer.example").getLeaderboard()).rejects.toMatchObject({
      code: GovernorErrorCode.SimulationFailed,
    });
  });
});
