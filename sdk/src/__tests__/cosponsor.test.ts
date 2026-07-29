import { CoSponsorshipClient } from "../cosponsor";
import { StrKey } from "@stellar/stellar-sdk";

describe("CoSponsorshipClient", () => {
  it("getDraft parses snake_case fields as camelCase", () => {
    const contractAddress = StrKey.encodeContract(Buffer.alloc(32, 1));
    const client = new CoSponsorshipClient({
      governorAddress: contractAddress,
      timelockAddress: contractAddress,
      votesAddress: contractAddress,
      coSponsorshipAddress: contractAddress,
      network: "testnet",
    });

    const nativeData = {
      id: 1n,
      creator: "GCREATOR",
      description: "Fund public goods",
      description_hash: new Uint8Array([0xab, 0xcd, 0x12, 0x34]),
      metadata_uri: "ipfs://draft",
      targets: [contractAddress],
      fn_names: ["execute"],
      calldatas: [new Uint8Array([1, 2, 3])],
      created_ledger: 1000,
      expiry_ledger: 2000,
      co_sponsors: ["GSPONSOR"],
      co_sponsor_power: [800n],
      total_power: 800n,
      finalized: false,
      cancelled: false,
    };

    const parsed = (client as any).parseProposalDraft(nativeData);

    expect(parsed.id).toBe(1n);
    expect(parsed.creator).toBe("GCREATOR");
    expect(parsed.description).toBe("Fund public goods");
    expect(parsed.descriptionHash).toBe("abcd1234");
    expect(parsed.metadataUri).toBe("ipfs://draft");
    expect(parsed.targets).toEqual([contractAddress]);
    expect(parsed.fnNames).toEqual(["execute"]);
    expect(parsed.createdLedger).toBe(1000);
    expect(parsed.expiryLedger).toBe(2000);
    expect(parsed.coSponsors).toEqual(["GSPONSOR"]);
    expect(parsed.coSponsorPower).toEqual([800n]);
    expect(parsed.totalPower).toBe(800n);
    expect(parsed.finalized).toBe(false);
    expect(parsed.cancelled).toBe(false);
  });

  describe("indexer-backed query methods", () => {
    const contractAddress = StrKey.encodeContract(Buffer.alloc(32, 1));
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
      const client = new CoSponsorshipClient({
        governorAddress: contractAddress,
        timelockAddress: contractAddress,
        votesAddress: contractAddress,
        coSponsorshipAddress: contractAddress,
        network: "testnet",
      });

      await expect(client.listDrafts()).rejects.toThrow("requires config.indexerUrl to be set");
      await expect(client.getDraftsByCreator("GCREATOR")).rejects.toThrow("requires config.indexerUrl to be set");
      await expect(client.getDraftCoSponsorHistory(1n)).rejects.toThrow("requires config.indexerUrl to be set");
    });

    it("listDrafts queries indexer and maps results", async () => {
      const client = new CoSponsorshipClient({
        governorAddress: contractAddress,
        timelockAddress: contractAddress,
        votesAddress: contractAddress,
        coSponsorshipAddress: contractAddress,
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
          pagination: {
            page: 1,
            limit: 20,
            has_more: false,
          },
        }),
      });

      const res = await client.listDrafts({ status: "active", page: 2, limit: 10 });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://indexer.example.com/co-sponsorship/drafts?status=active&page=2&limit=10",
      );
      expect(res.data).toHaveLength(1);
      expect(res.data[0].id).toBe(1n);
      expect(res.data[0].description).toBe("Draft 1");
      expect(res.pagination.page).toBe(1);
      expect(res.pagination.hasMore).toBe(false);
    });

    it("getDraftsByCreator queries indexer for specific creator", async () => {
      const client = new CoSponsorshipClient({
        governorAddress: contractAddress,
        timelockAddress: contractAddress,
        votesAddress: contractAddress,
        coSponsorshipAddress: contractAddress,
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
              total_power: 10n,
              finalized: true,
              cancelled: false,
            },
          ],
        }),
      });

      const drafts = await client.getDraftsByCreator("GCREATOR");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://indexer.example.com/co-sponsorship/drafts?creator=GCREATOR",
      );
      expect(drafts).toHaveLength(1);
      expect(drafts[0].id).toBe(2n);
      expect(drafts[0].totalPower).toBe(10n);
      expect(drafts[0].finalized).toBe(true);
    });

    it("getDraftCoSponsorHistory queries co-sponsor history for a draft", async () => {
      const client = new CoSponsorshipClient({
        governorAddress: contractAddress,
        timelockAddress: contractAddress,
        votesAddress: contractAddress,
        coSponsorshipAddress: contractAddress,
        network: "testnet",
        indexerUrl: "https://indexer.example.com",
        maxAttempts: 1,
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          data: [
            {
              sponsor_address: "GSPONSOR1",
              pledged_power: 500,
              pledged_at_ledger: 100,
            },
            {
              sponsor_address: "GSPONSOR2",
              pledged_power: 1000,
              pledged_at_ledger: 110,
            },
          ],
        }),
      });

      const history = await client.getDraftCoSponsorHistory(1n);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://indexer.example.com/co-sponsorship/drafts/1/co-sponsors",
      );
      expect(history).toEqual([
        { sponsorAddress: "GSPONSOR1", pledgedPower: 500n, pledgedAtLedger: 100 },
        { sponsorAddress: "GSPONSOR2", pledgedPower: 1000n, pledgedAtLedger: 110 },
      ]);
    });
  });
});

