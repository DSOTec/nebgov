// Unit tests for GovernorClient.queue/execute lifecycle methods (issue #362).
// Lives in its own file because governor.test.ts is excluded from the CI run.
// Define mocks with 'mock' prefix and 'var' for hoisting support.
var mockNativeToScVal = jest.fn();
var mockGetAccount = jest.fn();
var mockPrepareTransaction = jest.fn();
var mockSendTransaction = jest.fn();
var mockGetTransaction = jest.fn();
var mockIsSimulationError = jest.fn();

import { GovernorClient } from "../governor";

jest.mock("@stellar/stellar-sdk", () => {
  const actual = jest.requireActual("@stellar/stellar-sdk");
  return {
    ...actual,
    nativeToScVal: mockNativeToScVal,
    SorobanRpc: {
      ...actual.SorobanRpc,
      Server: jest.fn().mockImplementation(() => ({
        getAccount: mockGetAccount,
        prepareTransaction: mockPrepareTransaction,
        sendTransaction: mockSendTransaction,
        getTransaction: mockGetTransaction,
      })),
      Api: {
        isSimulationError: mockIsSimulationError,
        GetTransactionStatus: {
          SUCCESS: "SUCCESS",
          FAILED: "FAILED",
          NOT_FOUND: "NOT_FOUND",
        },
      },
    },
    Contract: jest.fn().mockImplementation((addr) => ({
      call: jest.fn().mockReturnValue({}),
      address: () => addr,
    })),
    TransactionBuilder: jest.fn().mockImplementation(() => ({
      addOperation: jest.fn().mockReturnThis(),
      setTimeout: jest.fn().mockReturnThis(),
      build: jest.fn().mockReturnValue({}),
    })),
  };
});

import { xdr, Account, Keypair } from "@stellar/stellar-sdk";

describe("GovernorClient lifecycle (queue/execute)", () => {
  let client: GovernorClient;
  const validGAddr = "GBFUUXATVOGXGD4KS3I423QFZSPE4ZFOQ3TCJVWFUYSIPULXIRVRE2DT";
  const validCAddr = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
  const mockKeypair = Keypair.random();

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockGetAccount.mockResolvedValue(new Account(validGAddr, "1"));
    mockIsSimulationError.mockReturnValue(false);
    mockNativeToScVal.mockReturnValue({} as xdr.ScVal);
    mockGetTransaction.mockResolvedValue({
      status: "SUCCESS",
      returnValue: {} as xdr.ScVal,
    });

    client = new GovernorClient({
      governorAddress: validCAddr,
      timelockAddress: validCAddr,
      votesAddress: validCAddr,
      network: "testnet",
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("queue()", () => {
    const mockTxHash = "queue-hash";

    beforeEach(() => {
      mockPrepareTransaction.mockResolvedValue({ sign: jest.fn() });
      mockSendTransaction.mockResolvedValue({
        status: "PENDING",
        hash: mockTxHash,
      });
    });

    it("calls queue on the contract and returns the tx hash", async () => {
      const promise = client.queue(mockKeypair, 1n);
      await jest.advanceTimersByTimeAsync(2000);
      const hash = await promise;

      expect(hash).toBe(mockTxHash);
      const { Contract } = require("@stellar/stellar-sdk");
      const contractInstance = Contract.mock.results[0].value;
      expect(contractInstance.call).toHaveBeenCalledWith(
        "queue",
        expect.anything(),
      );
      expect(mockSendTransaction).toHaveBeenCalled();
    });

    it("throws when the transaction fails", async () => {
      mockSendTransaction.mockResolvedValue({
        status: "ERROR",
        error: "not succeeded",
      });
      await expect(client.queue(mockKeypair, 1n)).rejects.toThrow("queue failed");
    });
  });

  describe("queueWithSign()", () => {
    const mockTxHash = "queue-sign-hash";

    beforeEach(() => {
      mockPrepareTransaction.mockResolvedValue({
        toXDR: jest.fn().mockReturnValue("unsigned-xdr"),
      });
      mockSendTransaction.mockResolvedValue({
        status: "PENDING",
        hash: mockTxHash,
      });
      const { TransactionBuilder } = require("@stellar/stellar-sdk");
      TransactionBuilder.fromXDR = jest.fn().mockReturnValue({});
    });

    it("queues via the wallet sign callback and returns the tx hash", async () => {
      const signFn = jest.fn().mockResolvedValue("signed-xdr");
      const promise = client.queueWithSign(validGAddr, 1n, signFn);
      await jest.advanceTimersByTimeAsync(2000);
      const hash = await promise;

      expect(signFn).toHaveBeenCalledWith("unsigned-xdr");
      expect(hash).toBe(mockTxHash);
    });

    it("throws when the transaction fails", async () => {
      mockSendTransaction.mockResolvedValue({ status: "ERROR", error: "boom" });
      await expect(
        client.queueWithSign(
          validGAddr,
          1n,
          jest.fn().mockResolvedValue("signed-xdr"),
        ),
      ).rejects.toThrow("queueWithSign failed");
    });
  });

  describe("execute()", () => {
    const mockTxHash = "execute-hash";

    beforeEach(() => {
      mockPrepareTransaction.mockResolvedValue({ sign: jest.fn() });
      mockSendTransaction.mockResolvedValue({
        status: "PENDING",
        hash: mockTxHash,
      });
    });

    it("calls execute on the contract and returns the tx hash", async () => {
      const promise = client.execute(mockKeypair, 1n);
      await jest.advanceTimersByTimeAsync(2000);
      const hash = await promise;

      expect(hash).toBe(mockTxHash);
      const { Contract } = require("@stellar/stellar-sdk");
      const contractInstance = Contract.mock.results[0].value;
      expect(contractInstance.call).toHaveBeenCalledWith(
        "execute",
        expect.anything(),
      );
      expect(mockSendTransaction).toHaveBeenCalled();
    });

    it("throws when the transaction fails", async () => {
      mockSendTransaction.mockResolvedValue({
        status: "ERROR",
        error: "not ready",
      });
      await expect(client.execute(mockKeypair, 1n)).rejects.toThrow(
        "execute failed",
      );
    });
  });

  describe("executeWithSign()", () => {
    const mockTxHash = "execute-sign-hash";

    beforeEach(() => {
      mockPrepareTransaction.mockResolvedValue({
        toXDR: jest.fn().mockReturnValue("unsigned-xdr"),
      });
      mockSendTransaction.mockResolvedValue({
        status: "PENDING",
        hash: mockTxHash,
      });
      const { TransactionBuilder } = require("@stellar/stellar-sdk");
      TransactionBuilder.fromXDR = jest.fn().mockReturnValue({});
    });

    it("executes via the wallet sign callback and returns the tx hash", async () => {
      const signFn = jest.fn().mockResolvedValue("signed-xdr");
      const promise = client.executeWithSign(validGAddr, 1n, signFn);
      await jest.advanceTimersByTimeAsync(2000);
      const hash = await promise;

      expect(signFn).toHaveBeenCalledWith("unsigned-xdr");
      expect(hash).toBe(mockTxHash);
    });

    it("throws when the transaction fails", async () => {
      mockSendTransaction.mockResolvedValue({ status: "ERROR", error: "boom" });
      await expect(
        client.executeWithSign(
          validGAddr,
          1n,
          jest.fn().mockResolvedValue("signed-xdr"),
        ),
      ).rejects.toThrow("executeWithSign failed");
    });
  });
});
