import { StrKey, xdr, scValToNative } from "@stellar/stellar-sdk";
import { VotingRewardsClient } from "../votingRewards";
import { VotingRewardsError, VotingRewardsErrorCode, parseVotingRewardsError } from "../errors";

describe("VotingRewardsClient", () => {
  const contractAddress = StrKey.encodeContract(Buffer.alloc(32, 1));
  const governorAddress = StrKey.encodeContract(Buffer.alloc(32, 2));

  function makeClient(extra: Record<string, unknown> = {}): VotingRewardsClient {
    return new VotingRewardsClient({
      governorAddress,
      timelockAddress: contractAddress,
      votesAddress: contractAddress,
      votingRewardsAddress: contractAddress,
      network: "testnet",
      ...extra,
    });
  }

  it("refuses to construct without a voting-rewards address", () => {
    expect(
      () =>
        new VotingRewardsClient({
          governorAddress,
          timelockAddress: contractAddress,
          votesAddress: contractAddress,
          network: "testnet",
        }),
    ).toThrow(VotingRewardsError);
  });

  describe("encodePublishEpochRootCalldata", () => {
    it("encodes each argument with the type the contract declares", () => {
      const client = makeClient();
      const merkleRoot = "ab".repeat(32);

      const { target, fnName, calldata } = client.encodePublishEpochRootCalldata(
        governorAddress,
        7n,
        merkleRoot,
        1_234_567n,
      );

      expect(target).toBe(contractAddress);
      expect(fnName).toBe("publish_epoch_root");

      const decodedVec = xdr.ScVal.fromXDR(calldata).vec();
      expect(decodedVec).not.toBeNull();
      const [adminArg, epochArg, rootArg, amountArg] = decodedVec!;

      // Same trap `ProposalBondsClient.encodeSlashCalldata` guards against:
      // without a per-arg type hint a plain address string encodes as
      // scvString, and `publish_epoch_root(admin: Address, ...)` would fail
      // at execution time rather than at proposal time.
      expect(adminArg.switch().name).toBe("scvAddress");
      expect(epochArg.switch().name).toBe("scvU64");
      expect(rootArg.switch().name).toBe("scvBytes");
      expect(amountArg.switch().name).toBe("scvI128");

      expect(scValToNative(adminArg)).toBe(governorAddress);
      expect(scValToNative(epochArg)).toBe(7n);
      expect(Buffer.from(scValToNative(rootArg) as Uint8Array).toString("hex")).toBe(merkleRoot);
      expect(scValToNative(amountArg)).toBe(1_234_567n);
    });

    it("rejects a root that is not 32 bytes of hex", () => {
      const client = makeClient();
      expect(() =>
        client.encodePublishEpochRootCalldata(governorAddress, 1n, "deadbeef", 1n),
      ).toThrow(/BytesN<32>/);
    });
  });

  describe("backend-backed query methods", () => {
    const originalFetch = global.fetch;
    let mockFetch: jest.Mock;

    beforeEach(() => {
      mockFetch = jest.fn();
      global.fetch = mockFetch as unknown as typeof fetch;
    });

    afterAll(() => {
      global.fetch = originalFetch;
    });

    it("requires a backendUrl before asking for proofs", async () => {
      await expect(makeClient().getClaimableRewards("GABC")).rejects.toThrow(VotingRewardsError);
    });

    it("parses claimable rewards, keeping amounts as bigints", async () => {
      const client = makeClient({ backendUrl: "https://api.example.com", maxAttempts: 1 });
      const proof = ["aa".repeat(32), "bb".repeat(32)];

      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          data: [
            { epoch_id: "3", amount: "9007199254740993", merkle_proof: proof, claimed: false },
            { epoch_id: "2", amount: "100", merkle_proof: [], claimed: true },
          ],
        }),
      });

      const rewards = await client.getClaimableRewards("GABC");

      expect(mockFetch).toHaveBeenCalledWith("https://api.example.com/voting-rewards/claims/GABC");
      expect(rewards).toEqual([
        // Larger than Number.MAX_SAFE_INTEGER: parsing through a JS number
        // would silently round this claim and make its proof unverifiable.
        { epochId: 3n, amount: 9007199254740993n, merkleProof: proof, claimed: false },
        { epochId: 2n, amount: 100n, merkleProof: [], claimed: true },
      ]);
    });

    it("surfaces a failed backend response as a typed error", async () => {
      const client = makeClient({ backendUrl: "https://api.example.com", maxAttempts: 1 });
      mockFetch.mockResolvedValue({ ok: false, status: 503, statusText: "Service Unavailable" });

      await expect(client.getClaimableRewards("GABC")).rejects.toThrow(VotingRewardsError);
    });

    it("parses the epoch leaderboard", async () => {
      const client = makeClient({ backendUrl: "https://api.example.com", maxAttempts: 1 });
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          data: [{ claimant_address: "GABC", amount: "500", claimed: false }],
        }),
      });

      await expect(client.getEpochLeaderboard(4n, 5)).resolves.toEqual([
        { address: "GABC", amount: 500n, claimed: false },
      ]);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/voting-rewards/epochs/4/leaderboard?limit=5",
      );
    });
  });

  describe("parseVotingRewardsError", () => {
    it("maps an on-chain contract code to its typed message", () => {
      const error = parseVotingRewardsError({
        status: "ERROR",
        error: "HostError: Error(Contract, #12)",
      });

      expect(error.code).toBe(VotingRewardsErrorCode.InvalidProof);
      expect(error.message).toMatch(/Merkle proof/);
    });

    it("falls back to a transport-level code for a non-contract failure", () => {
      const error = parseVotingRewardsError({ status: "ERROR", error: "connection reset" });

      expect(error.code).toBe(VotingRewardsErrorCode.TransactionFailed);
    });
  });
});
