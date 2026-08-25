import { ProposalSimulationClient } from "../proposalSimulation";
import { GovernorErrorCode } from "../errors";

describe("ProposalSimulationClient", () => {
  const originalFetch = global.fetch;
  let mockFetch: jest.Mock;

  const makeClient = (backendUrl?: string) =>
    new ProposalSimulationClient({
      governorAddress: "CABC",
      timelockAddress: "CDEF",
      votesAddress: "CGHI",
      network: "testnet",
      backendUrl,
      maxAttempts: 1,
    });

  beforeEach(() => {
    mockFetch = jest.fn();
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it("requires a backend URL", async () => {
    await expect(makeClient().simulateProposal(1)).rejects.toMatchObject({
      code: GovernorErrorCode.SimulationFailed,
    });
  });

  it("posts a draft with base64 calldata and maps treasury impact", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        results: [{
          target: "CTARGET",
          fn_name: "transfer",
          success: true,
          decoded_summary: "Transfer tokens",
          return_value: "ok",
          revert_reason: null,
          treasury_impact: {
            token: "CTOKEN",
            cap_remaining_before: "9007199254740993",
            cap_remaining_after: null,
          },
        }],
      }),
    });

    const result = await makeClient("https://api.example").previewDraft(
      ["CTARGET"],
      ["transfer"],
      [Buffer.from([1, 2, 3])],
      "ab".repeat(32),
    );

    expect(result[0].treasuryImpact).toEqual({
      token: "CTOKEN",
      capRemainingBefore: 9007199254740993n,
      capRemainingAfter: null,
    });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.example/proposal-simulation/preview",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          targets: ["CTARGET"],
          fnNames: ["transfer"],
          calldatas: ["AQID"],
          descriptionHash: "ab".repeat(32),
        }),
      }),
    );
  });

  it("simulates an existing proposal and maps a revert", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        results: [{ target: "C", fn_name: "run", success: false, revert_reason: "denied" }],
      }),
    });

    await expect(makeClient("https://api.example").simulateProposal(7)).resolves.toEqual([
      expect.objectContaining({ target: "C", fnName: "run", success: false, revertReason: "denied" }),
    ]);
  });

  it("maps simulation history and rejects failed backend responses", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue([{
          simulated_at: "2026-01-01T00:00:00Z",
          simulated_at_ledger: 123,
          results: [{ target: "C", fn_name: "run", success: true }],
          any_action_would_revert: false,
        }]),
      })
      .mockResolvedValueOnce({ ok: false, status: 500 });

    const client = makeClient("https://api.example");
    await expect(client.getSimulationHistory(7)).resolves.toEqual([{
      simulatedAt: "2026-01-01T00:00:00Z",
      simulatedAtLedger: 123,
      results: [expect.objectContaining({ fnName: "run", success: true })],
      anyActionWouldRevert: false,
    }]);
    await expect(client.simulateProposal(7)).rejects.toMatchObject({
      code: GovernorErrorCode.SimulationFailed,
    });
  });
});
