import { ProposalState, VoteSupport } from "@nebgov/sdk";
import { DeployedContracts, GuardianVetoScenario, SimulationHarness } from "../src";
import { buildTestSetup, PLACEHOLDER_CALLDATA } from "./helpers";

describe("Guardian veto of a queued proposal (mock runtime)", () => {
  let harness: SimulationHarness;
  let addresses: DeployedContracts;
  let setup: ReturnType<typeof buildTestSetup>;

  beforeAll(async () => {
    setup = buildTestSetup({ proposers: 1, voters: 5, hasGuardian: true });
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

  it("cancels a queued proposal when the guardian vetoes inside the veto window", async () => {
    const result = await harness.run(GuardianVetoScenario, {
      proposer: setup.actors.proposers[0],
      voters: [
        { actor: setup.actors.voters[0], support: VoteSupport.For },
        { actor: setup.actors.voters[1], support: VoteSupport.For },
        { actor: setup.actors.voters[2], support: VoteSupport.For },
      ],
      guardian: setup.actors.guardian!,
      description: "Vetoed while still in the window",
      targets: [addresses.governor],
      fnNames: ["noop"],
      calldatas: [PLACEHOLDER_CALLDATA],
      // Immediate veto attempt, well inside the window (timelockDelay=3600s -> 720 ledgers).
      advanceBeforeVeto: 1,
    });

    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);
    expect(result.finalState).toBe(ProposalState.Cancelled);
  });

  it("rejects the veto once the veto window has closed", async () => {
    const result = await harness.run(GuardianVetoScenario, {
      proposer: setup.actors.proposers[0],
      voters: [
        { actor: setup.actors.voters[0], support: VoteSupport.For },
        { actor: setup.actors.voters[1], support: VoteSupport.For },
        { actor: setup.actors.voters[2], support: VoteSupport.For },
      ],
      guardian: setup.actors.guardian!,
      description: "Veto attempted too late",
      targets: [addresses.governor],
      fnNames: ["noop"],
      calldatas: [PLACEHOLDER_CALLDATA],
      // timelockDelay=3600s / SECONDS_PER_LEDGER(5) = 720 ledgers; advance past that.
      advanceBeforeVeto: 900,
    });

    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("Error(Contract, #19)");
    expect(result.finalState).toBe(ProposalState.Queued);
  });
});
