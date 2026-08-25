// Define mocks with 'mock' prefix and use 'var' for hoisting support
var mockNativeToScVal = jest.fn();
var mockScValToNative = jest.fn();
var mockGetAccount = jest.fn();
var mockPrepareTransaction = jest.fn();
var mockSendTransaction = jest.fn();
var mockGetTransaction = jest.fn();
var mockSimulateTransaction = jest.fn();
var mockIsSimulationError = jest.fn();
var mockFromXDR = jest.fn();

import { CoSponsorshipClient } from "../coSponsorship";
import { CoSponsorshipError, CoSponsorshipErrorCode } from "../errors";

jest.mock("@stellar/stellar-sdk", () => {
  const actual = jest.requireActual("@stellar/stellar-sdk");
  const TransactionBuilderMock: any = jest.fn().mockImplementation(() => ({
    addOperation: jest.fn().mockReturnThis(),
    setTimeout: jest.fn().mockReturnThis(),
    build: jest.fn().mockReturnValue({}),
  }));
  TransactionBuilderMock.fromXDR = mockFromXDR;
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
        isSimulationError: mockIsSimulationError,
      },
    },
    Contract: jest.fn().mockImplementation((addr) => ({
      call: jest.fn().mockReturnValue({}),
      address: () => addr,
    })),
    TransactionBuilder: TransactionBuilderMock,
  };
});

import { xdr, Account, Keypair } from "@stellar/stellar-sdk";

describe("CoSponsorshipClient", () => {
  let client: CoSponsorshipClient;
  const validCAddr = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
  const validGAddr = "GBFUUXATVOGXGD4KS3I423QFZSPE4ZFOQ3TCJVWFUYSIPULXIRVRE2DT";
  const mockKeypair = Keypair.random();

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockGetAccount.mockResolvedValue(new Account(validGAddr, "1"));
    mockNativeToScVal.mockReturnValue({} as xdr.ScVal);
    mockIsSimulationError.mockReturnValue(false);
    mockFromXDR.mockReturnValue({});

    client = new CoSponsorshipClient({
      governorAddress: validCAddr,
      timelockAddress: validCAddr,
      votesAddress: validCAddr,
      coSponsorshipAddress: validCAddr,
      network: "testnet",
      maxAttempts: 1,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /**
   * pollForConfirmation() waits real time (delayMs=2000) between retries;
   * advance fake timers past that wait so submit-based tests resolve
   * immediately instead of taking ~2s each.
   */
  async function flushPoll<T>(promise: Promise<T>): Promise<T> {
    await jest.advanceTimersByTimeAsync(2000);
    return promise;
  }

  describe("constructor", () => {
    it("throws CoSponsorshipError when coSponsorshipAddress is missing", () => {
      expect(
        () =>
          new CoSponsorshipClient({
            governorAddress: validCAddr,
            timelockAddress: validCAddr,
            votesAddress: validCAddr,
            network: "testnet",
          } as any),
      ).toThrow(CoSponsorshipError);
    });
  });

  describe("createDraft()", () => {
    it("submits create_draft and returns the new draft id", async () => {
      mockPrepareTransaction.mockResolvedValue({
        toXDR: jest.fn().mockReturnValue("prepared_xdr"),
        sign: jest.fn(),
      });
      mockSendTransaction.mockResolvedValue({ status: "PENDING", hash: "mock_hash" });
      mockGetTransaction.mockResolvedValue({
        status: "SUCCESS",
        returnValue: {} as xdr.ScVal,
      });
      mockScValToNative.mockReturnValue(7);

      const draftId = await flushPoll(
        client.createDraft(
          mockKeypair,
          "Fund grant #4",
          Buffer.from([0xab, 0xcd]),
          "ipfs://meta",
          [validCAddr],
          ["exec"],
          [Buffer.from([1, 2, 3])],
        ),
      );

      expect(draftId).toBe(7n);
      expect(mockNativeToScVal).toHaveBeenCalledWith("Fund grant #4", { type: "string" });
    });

    it("throws MissingReturnValue when the confirmed transaction has no return value", async () => {
      mockPrepareTransaction.mockResolvedValue({
        toXDR: jest.fn().mockReturnValue("prepared_xdr"),
        sign: jest.fn(),
      });
      mockSendTransaction.mockResolvedValue({ status: "PENDING", hash: "mock_hash" });
      mockGetTransaction.mockResolvedValue({ status: "SUCCESS", returnValue: undefined });

      const assertion = expect(
        client.createDraft(mockKeypair, "desc", Buffer.from([]), "", [], [], []),
      ).rejects.toMatchObject({
        constructor: CoSponsorshipError,
        code: CoSponsorshipErrorCode.MissingReturnValue,
      });
      await jest.advanceTimersByTimeAsync(2000);
      await assertion;
    });

    it("throws a CoSponsorshipError mapped from the contract error code on failure", async () => {
      mockPrepareTransaction.mockResolvedValue({
        toXDR: jest.fn().mockReturnValue("prepared_xdr"),
        sign: jest.fn(),
      });
      mockSendTransaction.mockResolvedValue({
        status: "ERROR",
        error: "Error(Contract, #12)", // CoSponsorshipErrorCode.NoTargets
      });

      await expect(
        client.createDraft(mockKeypair, "desc", Buffer.from([]), "", [], [], []),
      ).rejects.toMatchObject({
        constructor: CoSponsorshipError,
        code: CoSponsorshipErrorCode.NoTargets,
      });
    });
  });

  describe("coSponsor() / withdrawCoSponsorship()", () => {
    it("coSponsor returns the tx hash on success", async () => {
      mockPrepareTransaction.mockResolvedValue({
        toXDR: jest.fn().mockReturnValue("prepared_xdr"),
        sign: jest.fn(),
      });
      mockSendTransaction.mockResolvedValue({ status: "PENDING", hash: "co_sponsor_hash" });
      mockGetTransaction.mockResolvedValue({ status: "SUCCESS", returnValue: {} as xdr.ScVal });

      const hash = await flushPoll(client.coSponsor(mockKeypair, 1n));
      expect(hash).toBe("co_sponsor_hash");
    });

    it("withdrawCoSponsorship throws NotCoSponsored on the matching contract error", async () => {
      mockPrepareTransaction.mockResolvedValue({
        toXDR: jest.fn().mockReturnValue("prepared_xdr"),
        sign: jest.fn(),
      });
      mockSendTransaction.mockResolvedValue({ status: "ERROR", error: "Error(Contract, #6)" });

      await expect(client.withdrawCoSponsorship(mockKeypair, 1n)).rejects.toMatchObject({
        code: CoSponsorshipErrorCode.NotCoSponsored,
      });
    });
  });

  describe("finalizeDraft()", () => {
    it("returns the new governor proposal id on success", async () => {
      mockPrepareTransaction.mockResolvedValue({
        toXDR: jest.fn().mockReturnValue("prepared_xdr"),
        sign: jest.fn(),
      });
      mockSendTransaction.mockResolvedValue({ status: "PENDING", hash: "finalize_hash" });
      mockGetTransaction.mockResolvedValue({ status: "SUCCESS", returnValue: {} as xdr.ScVal });
      mockScValToNative.mockReturnValue(42);

      const proposalId = await flushPoll(client.finalizeDraft(mockKeypair, 1n));
      expect(proposalId).toBe(42n);
    });

    it("maps a rate-limited governor rejection to a TransactionFailed CoSponsorshipError", async () => {
      mockPrepareTransaction.mockResolvedValue({
        toXDR: jest.fn().mockReturnValue("prepared_xdr"),
        sign: jest.fn(),
      });
      mockSendTransaction.mockResolvedValue({
        status: "ERROR",
        error: "Error(Contract, #6)", // GovernorErrorCode.ProposalRateLimited — special-cased for finalize_draft
      });

      await expect(client.finalizeDraft(mockKeypair, 1n)).rejects.toMatchObject({
        code: CoSponsorshipErrorCode.TransactionFailed,
      });
      await expect(client.finalizeDraft(mockKeypair, 1n)).rejects.toThrow(
        /Governor rejected the underlying proposal/,
      );
    });
  });

  describe("cancelDraft()", () => {
    it("returns the tx hash on success", async () => {
      mockPrepareTransaction.mockResolvedValue({
        toXDR: jest.fn().mockReturnValue("prepared_xdr"),
        sign: jest.fn(),
      });
      mockSendTransaction.mockResolvedValue({ status: "PENDING", hash: "cancel_hash" });
      mockGetTransaction.mockResolvedValue({ status: "SUCCESS", returnValue: {} as xdr.ScVal });

      const hash = await flushPoll(client.cancelDraft(mockKeypair, 1n));
      expect(hash).toBe("cancel_hash");
    });
  });

  describe("coSponsorWithSign() (wallet-signing variant)", () => {
    it("signs the unsigned XDR via the callback and submits it", async () => {
      mockPrepareTransaction.mockResolvedValue({
        toXDR: jest.fn().mockReturnValue("unsigned-xdr"),
      });
      mockSendTransaction.mockResolvedValue({ status: "PENDING", hash: "ws_hash" });
      mockGetTransaction.mockResolvedValue({ status: "SUCCESS", returnValue: {} as xdr.ScVal });

      const signFn = jest.fn().mockResolvedValue("signed-xdr");
      const hash = await flushPoll(client.coSponsorWithSign(validGAddr, 1n, signFn));

      expect(signFn).toHaveBeenCalledWith("unsigned-xdr");
      expect(mockFromXDR).toHaveBeenCalledWith("signed-xdr", expect.any(String));
      expect(hash).toBe("ws_hash");
    });
  });

  describe("getDraft()", () => {
    it("parses a simulated get_draft response into camelCase", async () => {
      mockSimulateTransaction.mockResolvedValue({
        result: { retval: {} as xdr.ScVal },
      });
      mockScValToNative.mockReturnValue({
        id: 1n,
        creator: "GCREATOR",
        description: "Fund public goods",
        description_hash: new Uint8Array([0xab, 0xcd, 0x12, 0x34]),
        metadata_uri: "ipfs://draft",
        targets: [validCAddr],
        fn_names: ["execute"],
        calldatas: [new Uint8Array([1, 2, 3])],
        created_ledger: 1000,
        expiry_ledger: 2000,
        co_sponsors: ["GSPONSOR"],
        co_sponsor_power: [800n],
        total_power: 800n,
        finalized: false,
        cancelled: false,
      });

      const draft = await client.getDraft(1n);

      expect(draft.id).toBe(1n);
      expect(draft.descriptionHash).toBe("abcd1234");
      expect(draft.coSponsorPower).toEqual([800n]);
      expect(draft.totalPower).toBe(800n);
    });

    it("throws a CoSponsorshipError when the simulation reports an error", async () => {
      mockIsSimulationError.mockReturnValue(true);
      mockSimulateTransaction.mockResolvedValue({ error: "simulation blew up" });

      await expect(client.getDraft(1n)).rejects.toThrow(CoSponsorshipError);
    });
  });

  describe("getActiveDrafts()", () => {
    it("returns an empty array when the simulation fails", async () => {
      mockIsSimulationError.mockReturnValue(true);
      mockSimulateTransaction.mockResolvedValue({ error: "boom" });

      await expect(client.getActiveDrafts(0, 10)).resolves.toEqual([]);
    });

    it("maps every draft in a successful response", async () => {
      mockSimulateTransaction.mockResolvedValue({ result: { retval: {} as xdr.ScVal } });
      mockScValToNative.mockReturnValue([
        {
          id: 1n,
          creator: "GCREATOR",
          description: "d1",
          description_hash: new Uint8Array([1]),
          metadata_uri: "",
          targets: [],
          fn_names: [],
          calldatas: [],
          created_ledger: 1,
          expiry_ledger: 2,
          co_sponsors: [],
          co_sponsor_power: [],
          total_power: 0n,
          finalized: false,
          cancelled: false,
        },
      ]);

      const drafts = await client.getActiveDrafts(0, 10);
      expect(drafts).toHaveLength(1);
      expect(drafts[0].id).toBe(1n);
    });
  });

  describe("getCoSponsorPower()", () => {
    it("returns 0n when the simulation fails", async () => {
      mockIsSimulationError.mockReturnValue(true);
      mockSimulateTransaction.mockResolvedValue({ error: "boom" });

      await expect(client.getCoSponsorPower(1n, validGAddr)).resolves.toBe(0n);
    });

    it("decodes the pledged power", async () => {
      mockSimulateTransaction.mockResolvedValue({ result: { retval: {} as xdr.ScVal } });
      mockScValToNative.mockReturnValue(500);

      await expect(client.getCoSponsorPower(1n, validGAddr)).resolves.toBe(500n);
    });
  });

  describe("draftThresholdMet()", () => {
    it("returns false when the simulation fails", async () => {
      mockIsSimulationError.mockReturnValue(true);
      mockSimulateTransaction.mockResolvedValue({ error: "boom" });

      await expect(client.draftThresholdMet(1n)).resolves.toBe(false);
    });

    it("decodes the boolean result", async () => {
      mockSimulateTransaction.mockResolvedValue({ result: { retval: {} as xdr.ScVal } });
      mockScValToNative.mockReturnValue(true);

      await expect(client.draftThresholdMet(1n)).resolves.toBe(true);
    });
  });

  describe("indexer-backed query methods", () => {
    const originalFetch = global.fetch;
    let mockFetch: jest.Mock;

    beforeEach(() => {
      mockFetch = jest.fn();
      global.fetch = mockFetch as unknown as typeof fetch;
    });

    afterAll(() => {
      global.fetch = originalFetch;
    });

    it("throws when indexerUrl is not configured", async () => {
      await expect(client.listDrafts()).rejects.toThrow("requires config.indexerUrl to be set");
      await expect(client.getDraftsByCreator("GCREATOR")).rejects.toThrow(
        "requires config.indexerUrl to be set",
      );
      await expect(client.getDraftCoSponsorHistory(1n)).rejects.toThrow(
        "requires config.indexerUrl to be set",
      );
    });

    it("listDrafts queries the indexer and maps results", async () => {
      const indexedClient = new CoSponsorshipClient({
        governorAddress: validCAddr,
        timelockAddress: validCAddr,
        votesAddress: validCAddr,
        coSponsorshipAddress: validCAddr,
        network: "testnet",
        indexerUrl: "https://indexer.example.com",
        maxAttempts: 1,
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          data: [
            {
              id: 1,
              creator: "GCREATOR",
              description: "Draft 1",
              description_hash: "abcd",
              metadata_uri: "ipfs://1",
              targets: [],
              fn_names: [],
              calldatas: [],
              created_ledger: 100,
              expiry_ledger: 200,
              co_sponsors: [],
              co_sponsor_power: [],
              total_power: 0,
              finalized: false,
              cancelled: false,
            },
          ],
          pagination: { page: 1, limit: 20, has_more: false },
        }),
      });

      const res = await indexedClient.listDrafts({ status: "active", page: 2, limit: 10 });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://indexer.example.com/co-sponsorship/drafts?status=active&page=2&limit=10",
      );
      expect(res.data).toHaveLength(1);
      expect(res.data[0].id).toBe(1n);
      expect(res.pagination.hasMore).toBe(false);
    });

    it("getDraftsByCreator queries the indexer for a specific creator", async () => {
      const indexedClient = new CoSponsorshipClient({
        governorAddress: validCAddr,
        timelockAddress: validCAddr,
        votesAddress: validCAddr,
        coSponsorshipAddress: validCAddr,
        network: "testnet",
        indexerUrl: "https://indexer.example.com",
        maxAttempts: 1,
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          data: [
            {
              id: 2,
              creator: "GCREATOR",
              description: "Draft 2",
              description_hash: "efgh",
              metadata_uri: "ipfs://2",
              targets: [],
              fn_names: [],
              calldatas: [],
              created_ledger: 105,
              expiry_ledger: 205,
              co_sponsors: [],
              co_sponsor_power: [],
              total_power: 10,
              finalized: true,
              cancelled: false,
            },
          ],
        }),
      });

      const drafts = await indexedClient.getDraftsByCreator("GCREATOR");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://indexer.example.com/co-sponsorship/drafts?creator=GCREATOR",
      );
      expect(drafts[0].totalPower).toBe(10n);
      expect(drafts[0].finalized).toBe(true);
    });

    it("getDraftCoSponsorHistory queries co-sponsor history for a draft", async () => {
      const indexedClient = new CoSponsorshipClient({
        governorAddress: validCAddr,
        timelockAddress: validCAddr,
        votesAddress: validCAddr,
        coSponsorshipAddress: validCAddr,
        network: "testnet",
        indexerUrl: "https://indexer.example.com",
        maxAttempts: 1,
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          data: [
            { sponsor_address: "GSPONSOR1", pledged_power: 500, pledged_at_ledger: 100 },
            { sponsor_address: "GSPONSOR2", pledged_power: 1000, pledged_at_ledger: 110 },
          ],
        }),
      });

      const history = await indexedClient.getDraftCoSponsorHistory(1n);

      expect(history).toEqual([
        { sponsorAddress: "GSPONSOR1", pledgedPower: 500n, pledgedAtLedger: 100 },
        { sponsorAddress: "GSPONSOR2", pledgedPower: 1000n, pledgedAtLedger: 110 },
      ]);
    });
  });
});
