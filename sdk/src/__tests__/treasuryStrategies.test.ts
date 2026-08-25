import { StrKey } from "@stellar/stellar-sdk";
import { TreasuryStrategiesClient } from "../treasuryStrategies";
import {
  TreasuryStrategiesError,
  TreasuryStrategiesErrorCode,
} from "../errors";

describe("TreasuryStrategiesClient", () => {
  const contractAddress = StrKey.encodeContract(Buffer.alloc(32, 1));
  const baseConfig = {
    governorAddress: contractAddress,
    timelockAddress: contractAddress,
    votesAddress: contractAddress,
    treasuryStrategiesAddress: contractAddress,
    network: "testnet" as const,
    maxAttempts: 1,
  };

  const originalFetch = global.fetch;
  let mockFetch: jest.Mock;

  beforeEach(() => {
    mockFetch = jest.fn();
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it("requires a treasuryStrategiesAddress", () => {
    expect(
      () =>
        new TreasuryStrategiesClient({
          ...baseConfig,
          treasuryStrategiesAddress: undefined,
        }),
    ).toThrow(
      expect.objectContaining({
        name: "TreasuryStrategiesError",
        code: TreasuryStrategiesErrorCode.SimulationFailed,
      }),
    );
  });

  it("listStrategies maps indexed rows and clamps pagination options", async () => {
    const client = new TreasuryStrategiesClient({
      ...baseConfig,
      indexerUrl: "https://indexer.example.com",
    });
    mockFetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        strategies: [
          {
            strategy_id: "7",
            adapter: "CADAPTER",
            token: "CTOKEN",
            active: true,
            current_allocation: "2500",
            registered_ledger: 123,
          },
        ],
      }),
    });

    const strategies = await client.listStrategies({
      token: "CTOKEN",
      active: true,
      limit: 500,
      offset: -10,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://indexer.example.com/treasury-strategies?limit=100&offset=0&token=CTOKEN&active=true",
    );
    expect(strategies).toEqual([
      {
        strategyId: 7,
        adapter: "CADAPTER",
        token: "CTOKEN",
        active: true,
        currentAllocation: 2500n,
        registeredLedger: 123,
      },
    ]);
  });

  it("getPerformanceHistoryPage maps rows and preserves pagination metadata", async () => {
    const client = new TreasuryStrategiesClient({
      ...baseConfig,
      indexerUrl: "https://indexer.example.com",
    });
    mockFetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        principal_history: [
          {
            amount: "1000",
            ledger: 200,
            created_at: "2026-01-01T00:00:00.000Z",
          },
        ],
        pagination: { limit: 25, offset: 50, hasMore: true },
      }),
    });

    const page = await client.getPerformanceHistoryPage(7, 25, 50);

    expect(mockFetch).toHaveBeenCalledWith(
      "https://indexer.example.com/treasury-strategies/7/performance?limit=25&offset=50",
    );
    expect(page).toEqual({
      history: [
        {
          amount: 1000n,
          ledger: 200,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      pagination: { limit: 25, offset: 50, hasMore: true },
    });
  });

  it("throws a typed error when indexer-backed methods lack indexerUrl", async () => {
    const client = new TreasuryStrategiesClient(baseConfig);

    await expect(client.listStrategies()).rejects.toBeInstanceOf(
      TreasuryStrategiesError,
    );
    await expect(client.listStrategies()).rejects.toMatchObject({
      code: TreasuryStrategiesErrorCode.SimulationFailed,
    });
  });
});
