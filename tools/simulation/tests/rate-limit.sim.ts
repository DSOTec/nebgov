import { DeployedContracts, RateLimitScenario, SimulationHarness } from "../src";
import { buildTestSetup, PLACEHOLDER_CALLDATA } from "./helpers";

describe("Proposer rate limiting (mock runtime)", () => {
  let harness: SimulationHarness;
  let addresses: DeployedContracts;
  let setup: ReturnType<typeof buildTestSetup>;

  beforeAll(async () => {
    setup = buildTestSetup({ proposers: 1, voters: 5, settings: { proposalCooldown: 100 } });
    harness = new SimulationHarness(setup.config);
    harness.registerActors(setup.actors);
    addresses = await harness.boot();
  });

  afterAll(async () => {
    await harness.teardown();
  });

  it("rejects a second proposal from the same proposer within the cooldown period", async () => {
    const result = await harness.run(RateLimitScenario, {
      proposer: setup.actors.proposers[0],
      description: "Cooldown probe",
      targets: [addresses.governor],
      fnNames: ["noop"],
      calldatas: [PLACEHOLDER_CALLDATA],
    });

    expect(result.success).toBe(true);
    expect(result.proposalId).toBeDefined();
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("Error(Contract, #6)");
  });

  it("allows a new proposal from the same proposer once the cooldown has elapsed", async () => {
    await harness.advanceLedgers(101);

    const proposalId = await harness.governorClient.propose(
      setup.actors.proposers[0].keypair,
      "Post-cooldown proposal",
      "0".repeat(64),
      "ipfs://simulation",
      [addresses.governor],
      ["noop"],
      [PLACEHOLDER_CALLDATA],
    );

    expect(proposalId).toBeGreaterThan(0n);
  });
});
