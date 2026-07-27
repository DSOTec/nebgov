// Define mocks with 'mock' prefix and use 'var' for hoisting support
var mockScValToNative = jest.fn();
var mockNativeToScVal = jest.fn();
var mockSimulate = jest.fn();
var mockGetAccount = jest.fn();
var mockIsSimulationError = jest.fn();
var mockGetLatestLedger = jest.fn();

import { DelegationSigClient } from "../delegation-sig";
import { VotesError, VotesErrorCode } from "../errors";

jest.mock("@stellar/stellar-sdk", () => {
  const actual = jest.requireActual("@stellar/stellar-sdk");
  return {
    ...actual,
    scValToNative: mockScValToNative,
    nativeToScVal: mockNativeToScVal,
    SorobanRpc: {
      ...actual.SorobanRpc,
      Server: jest.fn().mockImplementation(() => ({
        simulateTransaction: mockSimulate,
        getAccount: mockGetAccount,
        getLatestLedger: mockGetLatestLedger,
      })),
      Api: {
        isSimulationError: mockIsSimulationError,
      },
    },
    Contract: jest.fn().mockImplementation((addr) => ({
      call: jest.fn().mockReturnValue({}),
      address: () => addr,
      contractId: () => addr,
    })),
    TransactionBuilder: jest.fn().mockImplementation(() => ({
      addOperation: jest.fn().mockReturnThis(),
      setTimeout: jest.fn().mockReturnThis(),
      build: jest.fn().mockReturnValue({}),
    })),
  };
});

import { xdr, Account } from "@stellar/stellar-sdk";

describe("DelegationSigClient", () => {
  let client: DelegationSigClient;
  const validGAddr = "GBFUUXATVOGXGD4KS3I423QFZSPE4ZFOQ3TCJVWFUYSIPULXIRVRE2DT";
  const validCAddr = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAccount.mockResolvedValue(new Account(validGAddr, "1"));
    mockNativeToScVal.mockReturnValue({} as xdr.ScVal);

    client = new DelegationSigClient({
      votesAddress: validCAddr,
      network: "testnet",
      maxAttempts: 1,
    });
  });

  describe("getNonce()", () => {
    it("returns the decoded nonce on a successful simulation", async () => {
      mockIsSimulationError.mockReturnValue(false);
      mockSimulate.mockResolvedValue({ result: { retval: {} as xdr.ScVal } });
      mockScValToNative.mockReturnValue(5);

      await expect(client.getNonce(validGAddr)).resolves.toBe(5n);
    });

    it("returns 0n when simulation succeeds with no retval", async () => {
      mockIsSimulationError.mockReturnValue(false);
      mockSimulate.mockResolvedValue({ result: undefined });

      await expect(client.getNonce(validGAddr)).resolves.toBe(0n);
    });

    it("throws a VotesError instead of returning a fallback when simulation fails", async () => {
      mockIsSimulationError.mockReturnValue(true);
      mockSimulate.mockResolvedValue({ error: "HostError: Value(HostError(...))" });

      await expect(client.getNonce(validGAddr)).rejects.toMatchObject({
        constructor: VotesError,
        code: VotesErrorCode.SimulationFailed,
      });
    });
  });

  describe("isRelayerAllowed()", () => {
    it("throws instead of defaulting to true when simulation fails", async () => {
      mockIsSimulationError.mockReturnValue(true);
      mockSimulate.mockResolvedValue({ error: "RPC unavailable" });

      await expect(client.isRelayerAllowed(validGAddr)).rejects.toThrow(VotesError);
    });
  });
});
