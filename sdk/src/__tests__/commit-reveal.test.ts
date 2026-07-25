// Define mocks with 'mock' prefix and use 'var' for hoisting support
var mockScValToNative = jest.fn();
var mockNativeToScVal = jest.fn();
var mockSimulate = jest.fn();
var mockGetAccount = jest.fn();
var mockPrepareTransaction = jest.fn();
var mockSendTransaction = jest.fn();
var mockGetTransaction = jest.fn();
var mockIsSimulationError = jest.fn();
var mockGetLatestLedger = jest.fn();

import { GovernorClient } from "../governor";
import { VoteSupport } from "../types";

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
        prepareTransaction: mockPrepareTransaction,
        sendTransaction: mockSendTransaction,
        getTransaction: mockGetTransaction,
        getLatestLedger: mockGetLatestLedger,
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

describe("commit-reveal voting (Issue #766)", () => {
  let client: GovernorClient;
  const validGAddr = "GBFUUXATVOGXGD4KS3I423QFZSPE4ZFOQ3TCJVWFUYSIPULXIRVRE2DT";
  const validCAddr = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
  const mockKeypair = Keypair.random();

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAccount.mockResolvedValue(new Account(validGAddr, "1"));
    mockSimulate.mockResolvedValue({
      result: { retval: xdr.ScVal.scvVoid(), cost: { cpuInstructions: 125000 }, footprint: [] },
    });
    mockIsSimulationError.mockReturnValue(false);
    mockNativeToScVal.mockReturnValue({} as xdr.ScVal);

    client = new GovernorClient({
      governorAddress: validCAddr,
      timelockAddress: validCAddr,
      votesAddress: validCAddr,
      network: "testnet",
    });
  });

  describe("generateCommitment()", () => {
    it("matches the on-chain sha256(proposal_id_le || support_u8 || weight_seed_le || salt) preimage", () => {
      // Golden vector captured from the contract's own `compute_commitment`
      // (contracts/governor/src/commit_reveal.rs) via a throwaway Rust test
      // for proposal_id=42, support=For, weight_seed=123456789, salt=[0xAB; 32].
      // Any divergence here means every commit/reveal pair built by this SDK
      // would be rejected on-chain with CommitmentMismatch.
      const result = client.generateCommitment({
        proposalId: 42n,
        support: VoteSupport.For,
        weightSeed: 123456789n,
        salt: Buffer.alloc(32, 0xab),
      });

      expect(result.commitment.toString("hex")).toBe(
        "ddc09c2c64223bb2cd359e5a6608c9b6ac1dfc95c40cc94cbd632fbe4d53188f",
      );
      expect(result.salt.toString("hex")).toBe("ab".repeat(32));
      expect(result.weightSeed).toBe(123456789n);
    });

    it("is deterministic for identical inputs", () => {
      const params = {
        proposalId: 7n,
        support: VoteSupport.Against,
        weightSeed: 999n,
        salt: Buffer.alloc(32, 3),
      };
      const a = client.generateCommitment(params);
      const b = client.generateCommitment(params);
      expect(a.commitment.equals(b.commitment)).toBe(true);
    });

    it("produces a different commitment for each support choice", () => {
      const base = { proposalId: 1n, weightSeed: 1n, salt: Buffer.alloc(32, 1) };
      const forCommit = client.generateCommitment({ ...base, support: VoteSupport.For });
      const againstCommit = client.generateCommitment({ ...base, support: VoteSupport.Against });
      const abstainCommit = client.generateCommitment({ ...base, support: VoteSupport.Abstain });

      expect(forCommit.commitment.equals(againstCommit.commitment)).toBe(false);
      expect(forCommit.commitment.equals(abstainCommit.commitment)).toBe(false);
      expect(againstCommit.commitment.equals(abstainCommit.commitment)).toBe(false);
    });

    it("generates random weightSeed and salt when omitted, and returns them", () => {
      const a = client.generateCommitment({ proposalId: 1n, support: VoteSupport.For });
      const b = client.generateCommitment({ proposalId: 1n, support: VoteSupport.For });

      expect(a.salt).toHaveLength(32);
      expect(a.commitment).toHaveLength(32);
      // Astronomically unlikely to collide if randomness is actually being used.
      expect(a.salt.equals(b.salt)).toBe(false);
      expect(a.weightSeed).not.toBe(b.weightSeed);
    });

    it("rejects a salt that isn't exactly 32 bytes", () => {
      expect(() =>
        client.generateCommitment({
          proposalId: 1n,
          support: VoteSupport.For,
          weightSeed: 1n,
          salt: Buffer.alloc(16),
        }),
      ).toThrow(RangeError);
    });
  });

  describe("full commit → reveal lifecycle", () => {
    const mockTxHash = "commit-reveal-tx";

    beforeEach(() => {
      const mockTx = { sign: jest.fn() };
      mockPrepareTransaction.mockResolvedValue(mockTx);
      mockSendTransaction.mockResolvedValue({ status: "PENDING", hash: mockTxHash });
      mockGetTransaction.mockResolvedValue({ status: "SUCCESS", returnValue: {} as xdr.ScVal });
    });

    it("commitVote submits the commitment and reports the tx hash", async () => {
      const { commitment } = client.generateCommitment({
        proposalId: 1n,
        support: VoteSupport.For,
        weightSeed: 1n,
        salt: Buffer.alloc(32, 9),
      });

      const hash = await client.commitVote(mockKeypair, 1n, commitment);

      expect(hash).toBe(mockTxHash);
      expect(mockSendTransaction).toHaveBeenCalled();
      expect(mockGetTransaction).toHaveBeenCalledWith(mockTxHash);
    }, 10_000);

    it("revealVote discloses the preimage and reports the tx hash", async () => {
      const { weightSeed, salt } = client.generateCommitment({
        proposalId: 1n,
        support: VoteSupport.For,
        weightSeed: 1n,
        salt: Buffer.alloc(32, 9),
      });

      const hash = await client.revealVote(mockKeypair, {
        proposalId: 1n,
        support: VoteSupport.For,
        weightSeed,
        salt,
      });

      expect(hash).toBe(mockTxHash);
      expect(mockSendTransaction).toHaveBeenCalled();
    }, 10_000);

    it("commitVote throws when the network rejects the submission", async () => {
      mockSendTransaction.mockResolvedValue({ status: "ERROR", error: "Already committed" });

      await expect(
        client.commitVote(mockKeypair, 1n, Buffer.alloc(32)),
      ).rejects.toThrow("commitVote failed");
    });

    it("revealVote throws when the network rejects the submission", async () => {
      mockSendTransaction.mockResolvedValue({ status: "ERROR", error: "Commitment mismatch" });

      await expect(
        client.revealVote(mockKeypair, {
          proposalId: 1n,
          support: VoteSupport.For,
          weightSeed: 1n,
          salt: Buffer.alloc(32),
        }),
      ).rejects.toThrow("revealVote failed");
    });
  });

  describe("hasCommitted()", () => {
    it("returns true when the simulation reports a commitment exists", async () => {
      mockScValToNative.mockReturnValue(true);
      mockSimulate.mockResolvedValue({ result: { retval: {} as xdr.ScVal } });

      expect(await client.hasCommitted(1n, validGAddr)).toBe(true);
    });

    it("returns false on a simulation error", async () => {
      mockIsSimulationError.mockReturnValue(true);
      expect(await client.hasCommitted(1n, validGAddr)).toBe(false);
    });
  });

  describe("getCommitRevealStatus()", () => {
    beforeEach(() => {
      mockGetLatestLedger.mockResolvedValue({ sequence: 0 });
    });

    it.each([
      { currentLedger: 30, expectedPhase: "commit" as const },
      { currentLedger: 61, expectedPhase: "commit" as const },
      { currentLedger: 62, expectedPhase: "reveal" as const },
      { currentLedger: 100, expectedPhase: "reveal" as const },
      { currentLedger: 101, expectedPhase: "ended" as const },
    ])(
      "reports phase=$expectedPhase at ledger $currentLedger (commitDeadline=61, revealDeadline=100)",
      async ({ currentLedger, expectedPhase }) => {
        mockGetLatestLedger.mockResolvedValue({ sequence: currentLedger });
        // getCommitDeadline / getRevealDeadline each decode one u32 return value.
        mockScValToNative
          .mockReturnValueOnce(61)
          .mockReturnValueOnce(100);
        mockSimulate.mockResolvedValue({ result: { retval: {} as xdr.ScVal } });

        const status = await client.getCommitRevealStatus(1n);

        expect(status.phase).toBe(expectedPhase);
        expect(status.commitDeadline).toBe(61);
        expect(status.revealDeadline).toBe(100);
      },
    );

    it("defaults commitCount/revealCount to 0 without an indexerUrl configured", async () => {
      mockScValToNative.mockReturnValueOnce(61).mockReturnValueOnce(100);
      mockSimulate.mockResolvedValue({ result: { retval: {} as xdr.ScVal } });

      const status = await client.getCommitRevealStatus(1n);

      expect(status.commitCount).toBe(0);
      expect(status.revealCount).toBe(0);
    });
  });
});
