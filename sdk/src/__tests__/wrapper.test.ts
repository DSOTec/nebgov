var mockScValToNative = jest.fn();
var mockNativeToScVal = jest.fn();
var mockGetAccount = jest.fn();
var mockPrepareTransaction = jest.fn();
var mockSendTransaction = jest.fn();
var mockSimulationSuccess = jest.fn();

import { WrapperClient } from "../wrapper";

jest.mock("@stellar/stellar-sdk", () => {
  const actual = jest.requireActual("@stellar/stellar-sdk");
  return {
    ...actual,
    scValToNative: mockScValToNative,
    nativeToScVal: mockNativeToScVal,
    SorobanRpc: {
      ...actual.SorobanRpc,
      Server: jest.fn().mockImplementation(() => ({
        getAccount: mockGetAccount,
        prepareTransaction: mockPrepareTransaction,
        sendTransaction: mockSendTransaction,
        simulateTransaction: jest.fn(),
      })),
      Api: {
        isSimulationSuccess: mockSimulationSuccess,
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

import { Account, Keypair, xdr } from "@stellar/stellar-sdk";

describe("WrapperClient", () => {
  let client: WrapperClient;
  const wrapperAddress = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
  const validGAddr = "GBFUUXATVOGXGD4KS3I423QFZSPE4ZFOQ3TCJVWFUYSIPULXIRVRE2DT";
  const mockKeypair = Keypair.random();

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAccount.mockResolvedValue(new Account(validGAddr, "1"));
    mockNativeToScVal.mockReturnValue({} as xdr.ScVal);
    mockSimulationSuccess.mockReturnValue(true);

    client = new WrapperClient({
      wrapperAddress,
      network: "testnet",
    });
  });

  describe("constructor", () => {
    it("initializes with provided config", () => {
      const config = {
        wrapperAddress,
        network: "mainnet" as const,
      };
      const newClient = new WrapperClient(config);
      expect(newClient).toBeDefined();
    });

    it("uses default RPC URL for network", () => {
      const newClient = new WrapperClient({
        wrapperAddress,
        network: "testnet",
      });
      expect(newClient).toBeDefined();
    });

    it("accepts custom RPC URL", () => {
      const customRpc = "https://custom-soroban-rpc.example.com";
      const newClient = new WrapperClient({
        wrapperAddress,
        network: "testnet",
        rpcUrl: customRpc,
      });
      expect(newClient).toBeDefined();
    });
  });

  describe("deposit()", () => {
    beforeEach(() => {
      const mockTx = { sign: jest.fn() };
      mockPrepareTransaction.mockResolvedValue(mockTx);
      mockSendTransaction.mockResolvedValue({
        status: "PENDING",
        hash: "deposit123",
      });
    });

    it("builds and sends a deposit transaction", async () => {
      const amount = 1000n;
      const hash = await client.deposit(mockKeypair, amount);
      expect(hash).toBe("deposit123");
      expect(mockGetAccount).toHaveBeenCalledWith(mockKeypair.publicKey());
      expect(mockPrepareTransaction).toHaveBeenCalled();
      expect(mockSendTransaction).toHaveBeenCalled();
    });

    it("calls nativeToScVal with correct parameters", async () => {
      await client.deposit(mockKeypair, 500n);
      expect(mockNativeToScVal).toHaveBeenCalledWith(mockKeypair.publicKey(), {
        type: "address",
      });
      expect(mockNativeToScVal).toHaveBeenCalledWith(500n, { type: "i128" });
    });

    it("returns transaction hash on success", async () => {
      mockSendTransaction.mockResolvedValue({
        status: "SUCCESS",
        hash: "abc123def456",
      });
      const hash = await client.deposit(mockKeypair, 1000n);
      expect(hash).toBe("abc123def456");
    });
  });

  describe("withdraw()", () => {
    beforeEach(() => {
      const mockTx = { sign: jest.fn() };
      mockPrepareTransaction.mockResolvedValue(mockTx);
      mockSendTransaction.mockResolvedValue({
        status: "PENDING",
        hash: "withdraw123",
      });
    });

    it("builds and sends a withdraw transaction", async () => {
      const amount = 500n;
      const hash = await client.withdraw(mockKeypair, amount);
      expect(hash).toBe("withdraw123");
      expect(mockGetAccount).toHaveBeenCalledWith(mockKeypair.publicKey());
      expect(mockPrepareTransaction).toHaveBeenCalled();
      expect(mockSendTransaction).toHaveBeenCalled();
    });

    it("calls nativeToScVal with withdraw amount", async () => {
      await client.withdraw(mockKeypair, 750n);
      expect(mockNativeToScVal).toHaveBeenCalledWith(750n, { type: "i128" });
    });
  });

  describe("delegate()", () => {
    const delegateeAddr = "GBTESTDELEGATEEADDRESSEXAMPLEFORUNITTESTSTESTING";

    beforeEach(() => {
      const mockTx = { sign: jest.fn() };
      mockPrepareTransaction.mockResolvedValue(mockTx);
      mockSendTransaction.mockResolvedValue({
        status: "PENDING",
        hash: "delegate123",
      });
    });

    it("builds and sends a delegate transaction", async () => {
      const hash = await client.delegate(mockKeypair, delegateeAddr);
      expect(hash).toBe("delegate123");
      expect(mockGetAccount).toHaveBeenCalledWith(mockKeypair.publicKey());
      expect(mockPrepareTransaction).toHaveBeenCalled();
      expect(mockSendTransaction).toHaveBeenCalled();
    });

    it("calls nativeToScVal with delegatee address", async () => {
      await client.delegate(mockKeypair, delegateeAddr);
      expect(mockNativeToScVal).toHaveBeenCalledWith(delegateeAddr, {
        type: "address",
      });
    });
  });

  describe("getVotes()", () => {
    it("returns voting power for address", async () => {
      mockSimulationSuccess.mockReturnValue(true);
      const mockServer = {
        getAccount: mockGetAccount,
        prepareTransaction: mockPrepareTransaction,
        simulateTransaction: jest.fn().mockResolvedValue({
          result: { retval: { value: "100000" } },
        }),
      };

      client["server"] = mockServer as any;

      const votes = await client.getVotes(validGAddr);
      expect(votes).toBeDefined();
    });

    it("returns 0n when simulation has no retval", async () => {
      mockSimulationSuccess.mockReturnValue(true);
      const mockServer = {
        getAccount: mockGetAccount,
        prepareTransaction: mockPrepareTransaction,
        simulateTransaction: jest.fn().mockResolvedValue({
          result: { retval: null },
        }),
      };

      client["server"] = mockServer as any;

      const votes = await client.getVotes(validGAddr);
      expect(votes).toBe(0n);
    });

    it("throws when simulation fails", async () => {
      mockSimulationSuccess.mockReturnValue(false);
      const mockServer = {
        getAccount: mockGetAccount,
        prepareTransaction: mockPrepareTransaction,
        simulateTransaction: jest.fn().mockResolvedValue({}),
      };

      client["server"] = mockServer as any;

      await expect(client.getVotes(validGAddr)).rejects.toThrow(
        "Simulation failed"
      );
    });
  });
});
