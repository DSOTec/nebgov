// Define mocks with 'mock' prefix and use 'var' for hoisting support
var mockNativeToScVal = jest.fn();
var mockScValToNative = jest.fn();
var mockGetAccount = jest.fn();
var mockPrepareTransaction = jest.fn();
var mockSendTransaction = jest.fn();
var mockGetTransaction = jest.fn();
var mockSimulateTransaction = jest.fn();

import { ConvictionVotingClient } from "../convictionVoting";
import { Account, Keypair } from "@stellar/stellar-sdk";

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
        prepareTransaction: mockPrepareTransaction,
        sendTransaction: mockSendTransaction,
        getTransaction: mockGetTransaction,
        simulateTransaction: mockSimulateTransaction,
      })),
      Api: {
        GetTransactionStatus: {
          SUCCESS: "SUCCESS",
          FAILED: "FAILED",
          NOT_FOUND: "NOT_FOUND",
        },
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

const VALID_CADDR = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const VALID_GADDR = "GBFUUXATVOGXGD4KS3I423QFZSPE4ZFOQ3TCJVWFUYSIPULXIRVRE2DT";
const mockKeypair = Keypair.random();

function makeClient(extra: Record<string, unknown> = {}) {
  return new ConvictionVotingClient({
    governorAddress: VALID_CADDR,
    timelockAddress: VALID_CADDR,
    votesAddress: VALID_CADDR,
    network: "testnet",
    convictionVotingAddress: VALID_CADDR,
    simulationAccount: VALID_GADDR,
    maxAttempts: 1,
    ...extra,
  });
}

describe("ConvictionVotingClient", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAccount.mockResolvedValue(new Account(VALID_GADDR, "1"));
    mockNativeToScVal.mockReturnValue({} as any);
    mockPrepareTransaction.mockResolvedValue({
      toXDR: jest.fn().mockReturnValue("prepared_xdr"),
      sign: jest.fn(),
    });
    mockSendTransaction.mockResolvedValue({ status: "PENDING", hash: "mock_hash" });
    mockGetTransaction.mockResolvedValue({
      status: "SUCCESS",
      returnValue: {} as any,
    });
    mockSimulateTransaction.mockResolvedValue({ result: { retval: {} } });
  });

  describe("constructor", () => {
    it("throws when convictionVotingAddress is missing", () => {
      expect(
        () =>
          new ConvictionVotingClient({
            governorAddress: VALID_CADDR,
    timelockAddress: VALID_CADDR,
    votesAddress: VALID_CADDR,
            network: "testnet",
          }),
      ).toThrow("ConvictionVotingClient requires convictionVotingAddress");
    });
  });

  describe("submit-based mutations", () => {
    it("createProposal builds the call and returns the numeric id", async () => {
      mockScValToNative.mockReturnValue(7n);
      const client = makeClient();

      const id = await client.createProposal(
        mockKeypair,
        VALID_CADDR,
        "do_thing",
        Buffer.from([0x01, 0x02]),
        1000n,
      );

      expect(id).toBe(7);
      expect(mockNativeToScVal).toHaveBeenCalledWith(mockKeypair.publicKey(), { type: "address" });
      expect(mockNativeToScVal).toHaveBeenCalledWith(VALID_CADDR, { type: "address" });
      expect(mockNativeToScVal).toHaveBeenCalledWith("do_thing", { type: "symbol" });
      expect(mockNativeToScVal).toHaveBeenCalledWith(Buffer.from([0x01, 0x02]), { type: "bytes" });
      expect(mockNativeToScVal).toHaveBeenCalledWith(1000n, { type: "i128" });
    });

    it("stake submits a stake call and returns the tx hash", async () => {
      const client = makeClient();
      const hash = await client.stake(mockKeypair, 3, 50n);
      expect(hash).toBe("mock_hash");
      expect(mockNativeToScVal).toHaveBeenCalledWith(3, { type: "u64" });
      expect(mockNativeToScVal).toHaveBeenCalledWith(50n, { type: "i128" });
    });

    it("withdrawStake submits a withdraw_stake call and returns the tx hash", async () => {
      const client = makeClient();
      const hash = await client.withdrawStake(mockKeypair);
      expect(hash).toBe("mock_hash");
      expect(mockNativeToScVal).toHaveBeenCalledWith(mockKeypair.publicKey(), { type: "address" });
    });

    it("checkpointConviction returns conviction and execution status", async () => {
      mockScValToNative
        .mockReturnValueOnce(42n) // returnValue of checkpoint_conviction
        .mockReturnValueOnce({
          id: "5",
          proposer: VALID_GADDR,
          target: VALID_CADDR,
          fn_name: "fn",
          calldata: Buffer.from([]),
          requested_amount: "1000",
          created_ledger: 1,
          conviction: "42",
          last_updated_ledger: 2,
          executed: true,
          cancelled: false,
        }); // getProposal simulate result
      const client = makeClient();

      const result = await client.checkpointConviction(mockKeypair, 5);

      expect(result).toEqual({ conviction: 42n, executed: true });
      // getProposal (after the checkpoint submit) is the only simulateTransaction call
      expect(mockSimulateTransaction).toHaveBeenCalledTimes(1);
    });

    it("rejects when the submitted transaction fails", async () => {
      mockSendTransaction.mockResolvedValue({ status: "ERROR" });
      const client = makeClient();
      await expect(client.stake(mockKeypair, 3, 50n)).rejects.toThrow(
        "Transaction submission failed: stake",
      );
    });
  });

  describe("read methods", () => {
    it("getProposal decodes the proposal struct", async () => {
      mockScValToNative.mockReturnValue({
        id: "9",
        proposer: VALID_GADDR,
        target: VALID_CADDR,
        fn_name: "run",
        calldata: Buffer.from([0xaa]),
        requested_amount: "5000",
        created_ledger: 10,
        conviction: "123",
        last_updated_ledger: 11,
        executed: false,
        cancelled: true,
      });
      const client = makeClient();

      const proposal = await client.getProposal(9);

      expect(proposal).toMatchObject({
        id: 9n,
        proposer: VALID_GADDR,
        target: VALID_CADDR,
        fnName: "run",
        requestedAmount: 5000n,
        createdLedger: 10,
        conviction: 123n,
        executed: false,
        cancelled: true,
      });
      expect(mockSimulateTransaction).toHaveBeenCalled();
    });

    it("getRequiredThreshold returns the simulated threshold", async () => {
      mockScValToNative.mockReturnValue("750");
      const client = makeClient();

      const threshold = await client.getRequiredThreshold(1000n);

      expect(threshold).toBe(750n);
      expect(mockNativeToScVal).toHaveBeenCalledWith(1000n, { type: "i128" });
    });
  });

  describe("getConvictionHistory (indexer-backed)", () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it("fetches and maps the conviction history from the indexer", async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          data: [
            { proposal_id: "1", ledger: 100, conviction: "10" },
            { proposal_id: "1", ledger: 200, conviction: "25" },
          ],
        }),
      });
      global.fetch = mockFetch as unknown as typeof fetch;
      const client = makeClient({ indexerUrl: "https://indexer.example.com" });

      const history = await client.getConvictionHistory(1);

      expect(history).toEqual([
        { proposalId: 1n, ledger: 100, conviction: 10n },
        { proposalId: 1n, ledger: 200, conviction: 25n },
      ]);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://indexer.example.com/conviction/proposals/1/conviction-history",
      );
    });

    it("throws when indexerUrl is not configured", async () => {
      const client = makeClient();
      await expect(client.getConvictionHistory(1)).rejects.toThrow(
        "indexerUrl is required",
      );
    });
  });
});
