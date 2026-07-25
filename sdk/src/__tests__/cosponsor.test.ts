import { CoSponsorshipClient } from "../cosponsor";

describe("CoSponsorshipClient", () => {
  it("getDraft parses snake_case fields as camelCase", () => {
    const client = new CoSponsorshipClient({
      cosponsorshipAddress: "CCOSPONSOR00000000000000000000000000000000000000000000",
      network: "testnet",
    });

    const nativeData = {
      id: 1n,
      proposer: "GPROPOSER111111111111111111111111111111111",
      description_hash: "abcd1234",
      targets: ["CTARGET1000000000000000000000000000000000000000000000000000"],
      fn_names: ["execute"],
      calldatas: [new Uint8Array([1, 2, 3])],
      start_ledger: 1000,
      end_ledger: 2000,
    };

    const parsed = (client as any).parseProposalDraft(nativeData);

    expect(parsed.id).toBe(1n);
    expect(parsed.proposer).toBe("GPROPOSER111111111111111111111111111111111");
    expect(parsed.descriptionHash).toBe("abcd1234");
    expect(parsed.descriptionHash).toBeDefined();
    expect(typeof parsed.descriptionHash).toBe("string");
    expect(parsed.targets[0]).toBe("CTARGET1000000000000000000000000000000000000000000000000000");
    expect(parsed.startLedger).toBe(1000);
    expect(parsed.endLedger).toBe(2000);
  });
});
