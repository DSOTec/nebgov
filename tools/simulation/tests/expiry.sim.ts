import { ProposalState, VoteSupport } from "@nebgov/sdk";
import { DeployedContracts, ExpiryScenario, SimulationHarness } from "../src";
import { buildTestSetup, PLACEHOLDER_CALLDATA } from "./helpers";

describe("Proposal expiry (mock runtime)", () => {
  let harness: SimulationHarness;
  let addresses: DeployedContracts;
  let setup: ReturnType<typeof buildTestSetup>;

  beforeAll(async () => {
    setup = buildTestSetup({ proposers: 1, voters: 5, settings: { proposalGracePeriod: 50 } });
    harness = new SimulationHarness(setup.config);
    harness.registerActors(setup.actors);
    addresses = await harness.boot();
  });

  afterAll(async () => {
    await harness.teardown();
  });

  it("expires a Succeeded proposal that was never queued once its grace period elapses", async () => {
    const result = await harness.run(ExpiryScenario, {
      proposer: setup.actors.proposers[0],
      voters: [
        { actor: setup.actors.voters[0], support: VoteSupport.For },
        { actor: setup.actors.voters[1], support: VoteSupport.For },
        { actor: setup.actors.voters[2], support: VoteSupport.For },
      ],
      description: "Never queued in time",
      targets: [addresses.governor],
      fnNames: ["noop"],
      calldatas: [PLACEHOLDER_CALLDATA],
    });

    expect(result.success).toBe(true);
    expect(result.finalState).toBe(ProposalState.Expired);

    // queue() should now reject: the proposal is past its grace period.
    await expect(harness.governorClient.queue(setup.actors.proposers[0].keypair, result.proposalId!)).rejects.toThrow();
  });
});
