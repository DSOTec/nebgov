import { AnalyticsClient } from "../analytics";
import { GovernorError, GovernorErrorCode } from "../errors";

describe("AnalyticsClient", () => {
  const originalFetch = global.fetch;
  let mockFetch: jest.Mock;

  const makeClient = (indexerUrl?: string) =>
    new AnalyticsClient({
      governorAddress: "CABC",
      timelockAddress: "CDEF",
      votesAddress: "CGHI",
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

  it("requires an indexer URL", async () => {
    await expect(makeClient().getLatestSnapshot()).rejects.toMatchObject({
      code: GovernorErrorCode.SimulationFailed,
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("maps a snapshot and returns null when it is absent", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue({ data: [{ ledger: "42", total_votes_cast: "9007199254740993" }] }),
      })
      .mockResolvedValueOnce({ ok: true, json: jest.fn().mockResolvedValue({ data: [] }) });

    await expect(makeClient("https://indexer.example").getSnapshot(42)).resolves.toEqual({
      ledger: 42,
      totalVotesCast: 9007199254740993n,
    });
    await expect(makeClient("https://indexer.example").getSnapshot(43)).resolves.toBeNull();
    expect(mockFetch).toHaveBeenNthCalledWith(1, "https://indexer.example/analytics/snapshots?ledger=42");
  });

  it("maps latest snapshot, snapshot list, and all-time statistics", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: jest.fn().mockResolvedValue({ ledger: 50, total_votes_cast: "8" }) })
      .mockResolvedValueOnce({ ok: true, json: jest.fn().mockResolvedValue({ data: [{ ledger: "50" }, { ledger: 40 }] }) })
      .mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue({
          total_proposals: "12",
          total_votes_cast: "34",
          unique_voters: "5",
          quorum_hit_count: "6",
          quorum_miss_count: "7",
          pass_rate_bps: "8000",
        }),
      });

    const client = makeClient("https://indexer.example");
    await expect(client.getLatestSnapshot()).resolves.toEqual({ ledger: 50, totalVotesCast: 8n });
    await expect(client.getSnapshotList(2)).resolves.toEqual([50, 40]);
    await expect(client.getAllTimeStats()).resolves.toEqual({
      totalProposals: 12n,
      totalVotesCast: 34n,
      uniqueVoters: 5n,
      quorumHitCount: 6n,
      quorumMissCount: 7n,
      passRateBps: 8000,
    });
  });

  it("maps voter history without losing large vote weight", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        voter: "GABC",
        proposals_voted: "4",
        proposals_eligible: "5",
        participation_rate_bps: "8000",
        total_weight_cast: "9007199254740993",
        for_count: "2",
        against_count: "1",
        abstain_count: "1",
        last_voted_ledger: "99",
      }),
    });

    await expect(makeClient("https://indexer.example").getVoterHistory("GABC")).resolves.toEqual({
      voter: "GABC",
      proposalsVoted: 4,
      proposalsEligible: 5,
      participationRateBps: 8000,
      totalWeightCast: 9007199254740993n,
      forCount: 2,
      againstCount: 1,
      abstainCount: 1,
      lastVotedLedger: 99,
    });
  });

  it("surfaces a non-success response as a typed error", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503 });
    await expect(makeClient("https://indexer.example").getAllTimeStats()).rejects.toBeInstanceOf(
      GovernorError,
    );
  });
});
