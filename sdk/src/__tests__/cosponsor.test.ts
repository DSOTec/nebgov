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
});
