import { ProposalState, VoteSupport } from "@nebgov/sdk";
import { assertVoteCounts, DefeatScenario, DeployedContracts, SimulationHarness } from "../src";
import { buildTestSetup, PLACEHOLDER_CALLDATA } from "./helpers";

describe("Proposal defeat (mock runtime)", () => {
  let harness: SimulationHarness;
  let addresses: DeployedContracts;
  let setup: ReturnType<typeof buildTestSetup>;

  beforeAll(async () => {
    setup = buildTestSetup({ proposers: 1, voters: 5 });
    harness = new SimulationHarness(setup.config);
    harness.registerActors(setup.actors);
    addresses = await harness.boot();
  });

  afterAll(async () => {
    await harness.teardown();
  });

  // Each test proposes from the same proposer; clear the proposer cooldown
  // (100 ledgers by default) between tests so they don't interfere.
  beforeEach(async () => {
    await harness.advanceLedgers(200);
  });

  it("resolves to Defeated when quorum is not reached", async () => {
    // quorumNumerator=40% of a 6,000,000 total supply requires 2,400,000
    // participating votes; only one voter (1,000,000) participates.
    const result = await harness.run(DefeatScenario, {
      proposer: setup.actors.proposers[0],
      voters: [{ actor: setup.actors.voters[0], support: VoteSupport.For }],
      description: "Underfunded quorum attempt",
      targets: [addresses.governor],
      fnNames: ["noop"],
      calldatas: [PLACEHOLDER_CALLDATA],
    });

    expect(result.success).toBe(true);
    expect(result.finalState).toBe(ProposalState.Defeated);
  });

  it("resolves to Defeated when against votes meet or exceed for votes, even with quorum reached", async () => {
    // Abstain counts toward quorum but not toward the for/against comparison,
    // so quorum (2,400,000) is met via abstains while for (0) <= against (1,000,000).
    const result = await harness.run(DefeatScenario, {
      proposer: setup.actors.proposers[0],
      voters: [
        { actor: setup.actors.voters[0], support: VoteSupport.Abstain },
        { actor: setup.actors.voters[1], support: VoteSupport.Abstain },
        { actor: setup.actors.voters[2], support: VoteSupport.Abstain },
        { actor: setup.actors.voters[3], support: VoteSupport.Against },
      ],
      description: "Outvoted proposal",
      targets: [addresses.governor],
      fnNames: ["noop"],
      calldatas: [PLACEHOLDER_CALLDATA],
    });

    await assertVoteCounts(harness.governorClient, result.proposalId!, {
      votesFor: 0n,
      votesAgainst: 1_000_000n,
      votesAbstain: 3_000_000n,
    });
    expect(result.success).toBe(true);
    expect(result.finalState).toBe(ProposalState.Defeated);
  });
});
