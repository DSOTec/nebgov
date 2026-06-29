import { GovernorClient } from "../governor";
import { GovernorError, GovernorErrorCode } from "../errors";

var mockSimulate = jest.fn();
var mockAssemble = jest.fn();
var mockGetAccount = jest.fn();
var mockSendTransaction = jest.fn();
var mockGetTransaction = jest.fn();
var mockIsSimulationError = jest.fn();
var mockNativeToScVal = jest.fn();

jest.mock("@stellar/stellar-sdk", () => {
  const actual = jest.requireActual("@stellar/stellar-sdk");
  return {
    ...actual,
    nativeToScVal: (...args: unknown[]) => mockNativeToScVal(...args),
    SorobanRpc: {
      ...actual.SorobanRpc,
      Server: jest.fn().mockImplementation(() => ({
        simulateTransaction: (...args: unknown[]) => mockSimulate(...args),
        getAccount: (...args: unknown[]) => mockGetAccount(...args),
        sendTransaction: (...args: unknown[]) => mockSendTransaction(...args),
        getTransaction: (...args: unknown[]) => mockGetTransaction(...args),
        getLatestLedger: jest.fn().mockResolvedValue({ sequence: 123 }),
      })),
      Api: {
        ...actual.SorobanRpc.Api,
        isSimulationError: (...args: unknown[]) => mockIsSimulationError(...args),
      },
      assembleTransaction: (...args: unknown[]) => mockAssemble(...args),
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

import { xdr, Account } from "@stellar/stellar-sdk";

describe("GovernorClient.execute() — pre-submission simulation (#524)", () => {
  const validCAddr = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
  const validGAddr = "GBFUUXATVOGXGD4KS3I423QFZSPE4ZFOQ3TCJVWFUYSIPULXIRVRE2DT";
  const mockSigner = { sign: jest.fn(), publicKey: () => validGAddr } as any;
  const mockBuiltTx = { sign: jest.fn() };
  let client: GovernorClient;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAccount.mockResolvedValue(new Account(validGAddr, "1"));
    mockNativeToScVal.mockReturnValue({} as xdr.ScVal);

    mockIsSimulationError.mockReturnValue(false);
    mockSimulate.mockResolvedValue({
      id: "sim-1",
      latestLedger: 100,
      events: [],
      _parsed: true,
      transactionData: {},
      minResourceFee: "100",
      cost: { cpuInstructions: 125000, memBytes: 1200 },
      result: { retval: xdr.ScVal.scvVoid() },
    });

    mockAssemble.mockReturnValue({ build: () => mockBuiltTx });
    mockSendTransaction.mockResolvedValue({ status: "PENDING", hash: "exec-tx" });
    mockGetTransaction.mockResolvedValue({
      status: "SUCCESS",
      returnValue: xdr.ScVal.scvVoid(),
    });

    client = new GovernorClient({
      governorAddress: validCAddr,
      timelockAddress: validCAddr,
      votesAddress: validCAddr,
      network: "testnet",
      maxAttempts: 3,
      baseDelayMs: 1,
    });
  });

  it("simulates, assembles, signs, and submits on simulation success", async () => {
    await client.execute(mockSigner, 1n);

    expect(mockSimulate).toHaveBeenCalledTimes(1);
    expect(mockAssemble).toHaveBeenCalledTimes(1);
    expect(mockAssemble).toHaveBeenCalledWith(expect.anything(), expect.anything());
    expect(mockBuiltTx.sign).toHaveBeenCalledWith(mockSigner);
    expect(mockSendTransaction).toHaveBeenCalledTimes(1);
    expect(mockGetTransaction).toHaveBeenCalledWith("exec-tx");
  }, 10_000);

  it("throws a typed GovernorError and does not broadcast on a contract simulation error", async () => {
    mockIsSimulationError.mockReturnValue(true);
    mockSimulate.mockResolvedValue({
      id: "sim-err",
      latestLedger: 100,
      events: [],
      _parsed: true,
      error: "Error(Contract, #15)",
    });

    await expect(client.execute(mockSigner, 1n)).rejects.toThrow(GovernorError);

    try {
      await client.execute(mockSigner, 1n);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(GovernorError);
      expect((e as GovernorError).code).toBe(GovernorErrorCode.ProposalNotQueued);
      expect((e as GovernorError).message).toContain("not queued");
    }

    expect(mockAssemble).not.toHaveBeenCalled();
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });

  it("maps non-contract simulation failures to GovernorError(SimulationFailed)", async () => {
    mockIsSimulationError.mockReturnValue(true);
    mockSimulate.mockResolvedValue({
      id: "sim-err-2",
      latestLedger: 100,
      events: [],
      _parsed: true,
      error: "host memory limit exceeded",
    });

    await expect(client.execute(mockSigner, 1n)).rejects.toThrow(GovernorError);

    try {
      await client.execute(mockSigner, 1n);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(GovernorError);
      expect((e as GovernorError).code).toBe(GovernorErrorCode.SimulationFailed);
      expect((e as GovernorError).message).toContain("memory limit");
    }

    expect(mockSendTransaction).not.toHaveBeenCalled();
  });

  it("does not retry on a simulation (contract) error", async () => {
    mockIsSimulationError.mockReturnValue(true);
    mockSimulate.mockResolvedValue({
      id: "sim-err-3",
      latestLedger: 100,
      events: [],
      _parsed: true,
      error: "Error(Contract, #16)",
    });

    await expect(client.execute(mockSigner, 1n)).rejects.toThrow(GovernorError);

    expect(mockSimulate).toHaveBeenCalledTimes(1);
  });

  it("retries submission on a transient 503 error, then succeeds", async () => {
    mockSendTransaction
      .mockRejectedValueOnce(new Error("Service Unavailable 503"))
      .mockResolvedValue({ status: "PENDING", hash: "exec-retry" });

    await client.execute(mockSigner, 1n);

    expect(mockSendTransaction).toHaveBeenCalledTimes(2);
    expect(mockGetTransaction).toHaveBeenCalledWith("exec-retry");
  }, 10_000);

  it("stops retrying after exhausting maxAttempts and rethrows the last error", async () => {
    mockSendTransaction.mockRejectedValue(new Error("Service Unavailable 503"));

    await expect(client.execute(mockSigner, 1n)).rejects.toThrow("503");

    expect(mockSendTransaction).toHaveBeenCalledTimes(3);
  }, 10_000);
});
