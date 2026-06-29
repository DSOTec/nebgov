var mockNativeToScVal = jest.fn();
var mockScValToNative = jest.fn();
var mockGetAccount = jest.fn();
var mockSimulateTransaction = jest.fn();

import { LiquidityClient } from "../liquidity";
import { TreasuryError } from "../errors";

jest.mock("@stellar/stellar-sdk", () => {
  const actual = jest.requireActual("@stellar/stellar-sdk");
  return {
    ...actual,
    nativeToScVal: mockNativeToScVal,
    scValToNative: mockScValToNative,
    SorobanRpc: {
      ...actual.SorobanRpc,
      Server: jest.fn().mockImplementation(() => ({
        getAccount: mockGetAccount,
        simulateTransaction: mockSimulateTransaction,
      })),
      Api: {
        isSimulationError: jest.fn().mockReturnValue(false),
      },
    },
    Contract: jest.fn().mockImplementation((addr) => ({
      call: jest.fn().mockReturnValue({}),
      address: () => addr,
    })),
    TransactionBuilder: jest.fn().mockImplementation(() => ({
      addOperation: jest.fn().mockReturnThis(),
      setTimeout: jest.fn().mockReturnThis(),
      build: jest.fn().mockReturnValue({
        toXDR: jest.fn().mockReturnValue(""),
      }),
    })),
  };
});

describe("LiquidityClient", () => {
  let client: LiquidityClient;
  const validCAddr = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
  const validGAddr = "GBFUUXATVOGXGD4KS3I423QFZSPE4ZFOQ3TCJVWFUYSIPULXIRVRE2DT";

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAccount.mockResolvedValue({ accountId: () => validGAddr, sequenceNumber: () => "1" });

    client = new LiquidityClient({
      liquidityAddress: validCAddr,
      network: "testnet",
      simulationAccount: validGAddr,
    });
  });

  describe("getPoolSafe()", () => {
    it("returns the decoded pool when one exists", async () => {
      mockScValToNative.mockReturnValue({
        reserve_a: "1000000",
        reserve_b: "1000000",
        total_lp_supply: "1000000",
        fee_bps: 30,
      });

      const pool = await client.getPoolSafe(0, 1);

      expect(pool).not.toBeNull();
      expect(pool?.reserveA).toBe(1000000n);
      expect(pool?.reserveB).toBe(1000000n);
      expect(pool?.totalLpSupply).toBe(1000000n);
      expect(pool?.feeBps).toBe(30);
      expect(mockNativeToScVal).toHaveBeenCalledWith(0, { type: "u32" });
      expect(mockNativeToScVal).toHaveBeenCalledWith(1, { type: "u32" });
    });

    it("returns null when the contract returns no value", async () => {
      mockScValToNative.mockReturnValue(null);

      const pool = await client.getPoolSafe(0, 1);

      expect(pool).toBeNull();
    });

    it("returns null on simulation error instead of throwing", async () => {
      const { SorobanRpc } = jest.requireMock("@stellar/stellar-sdk") as {
        SorobanRpc: { Api: { isSimulationError: jest.Mock } };
      };
      SorobanRpc.Api.isSimulationError.mockReturnValueOnce(true);

      const pool = await client.getPoolSafe(0, 1);

      expect(pool).toBeNull();
    });
  });

  describe("getPool()", () => {
    it("returns the pool when it exists", async () => {
      mockScValToNative.mockReturnValue({
        reserve_a: "500",
        reserve_b: "500",
        total_lp_supply: "500",
        fee_bps: 10,
      });

      const pool = await client.getPool(0, 1);
      expect(pool.feeBps).toBe(10);
    });

    it("throws a TreasuryError when the pool does not exist", async () => {
      const { SorobanRpc } = jest.requireMock("@stellar/stellar-sdk") as {
        SorobanRpc: { Api: { isSimulationError: jest.Mock } };
      };
      SorobanRpc.Api.isSimulationError.mockReturnValueOnce(true);

      await expect(client.getPool(0, 1)).rejects.toBeInstanceOf(TreasuryError);
    });
  });
});
