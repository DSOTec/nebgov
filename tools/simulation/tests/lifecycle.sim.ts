import { ProposalState, VoteSupport } from "@nebgov/sdk";
import { assertProposalState, assertVoteCounts, DeployedContracts, FullLifecycleScenario, SimulationHarness } from "../src";
import { buildTestSetup, PLACEHOLDER_CALLDATA } from "./helpers";

describe("Full governance lifecycle (mock runtime)", () => {
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

  it("advances through all six lifecycle phases to Executed state", async () => {
    const result = await harness.run(FullLifecycleScenario, {
      proposer: setup.actors.proposers[0],
      voters: [
        { actor: setup.actors.voters[0], support: VoteSupport.For },
        { actor: setup.actors.voters[1], support: VoteSupport.For },
        { actor: setup.actors.voters[2], support: VoteSupport.For },
        { actor: setup.actors.voters[3], support: VoteSupport.Against },
        { actor: setup.actors.voters[4], support: VoteSupport.Abstain },
      ],
      description: "Upgrade fee parameter to 50bps",
      targets: [addresses.governor],
      fnNames: ["noop"],
      calldatas: [PLACEHOLDER_CALLDATA],
    });

    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);
    expect(result.finalState).toBe(ProposalState.Executed);
    await assertProposalState(harness.governorClient, result.proposalId!, ProposalState.Executed);
  });

  it("is Queued once queue() succeeds, before the timelock delay elapses", async () => {
    const proposalId = await harness.governorClient.propose(
      setup.actors.proposers[0].keypair,
      "Queued-only check",
      "0".repeat(64),
      "ipfs://simulation",
      [addresses.governor],
      ["noop"],
      [PLACEHOLDER_CALLDATA],
    );

    const settings = await harness.governorClient.getSettings();
    await harness.advanceLedgers(settings.votingDelay + 1);
    // quorumNumerator=40% of the 6,000,000 total supply requires 2,400,000
    // participating votes: three voters clear it comfortably.
    await setup.actors.voters[0].vote(harness.governorClient, proposalId, VoteSupport.For);
    await setup.actors.voters[1].vote(harness.governorClient, proposalId, VoteSupport.For);
    await setup.actors.voters[2].vote(harness.governorClient, proposalId, VoteSupport.For);
    await harness.advanceLedgers(settings.votingPeriod + 1);

    await harness.governorClient.queue(setup.actors.proposers[0].keypair, proposalId);
    await assertProposalState(harness.governorClient, proposalId, ProposalState.Queued);
  });

  it("accumulates vote weights proportional to each voter's delegated balance", async () => {
    const proposalId = await harness.governorClient.propose(
      setup.actors.proposers[0].keypair,
      "Vote weight check",
      "0".repeat(64),
      "ipfs://simulation",
      [addresses.governor],
      ["noop"],
      [PLACEHOLDER_CALLDATA],
    );

    const settings = await harness.governorClient.getSettings();
    await harness.advanceLedgers(settings.votingDelay + 1);
    await setup.actors.voters[0].vote(harness.governorClient, proposalId, VoteSupport.For);
    await setup.actors.voters[1].vote(harness.governorClient, proposalId, VoteSupport.Against);

    await assertVoteCounts(harness.governorClient, proposalId, {
      votesFor: 1_000_000n,
      votesAgainst: 1_000_000n,
      votesAbstain: 0n,
    });
  });

  it("re-runs deterministically from a snapshot", async () => {
    const snap = await harness.snapshot();

    const scenarioConfig = {
      proposer: setup.actors.proposers[0],
      voters: [
        { actor: setup.actors.voters[0], support: VoteSupport.For },
        { actor: setup.actors.voters[1], support: VoteSupport.For },
        { actor: setup.actors.voters[2], support: VoteSupport.For },
      ],
      description: "Deterministic replay check",
      targets: [addresses.governor],
      fnNames: ["noop"],
      calldatas: [PLACEHOLDER_CALLDATA],
    };

    const result1 = await harness.run(FullLifecycleScenario, scenarioConfig);
    await harness.restore(snap);
    const result2 = await harness.run(FullLifecycleScenario, scenarioConfig);

    expect(result1.finalState).toBe(result2.finalState);
    expect(result1.proposalId).toBe(result2.proposalId);
    expect(result1.ledgersElapsed).toBe(result2.ledgersElapsed);
  });
});
