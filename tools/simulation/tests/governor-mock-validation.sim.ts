import { GovernorErrorCode, VoteSupport } from "@nebgov/sdk";
import { MockContractError } from "../src/mock/errors";
import { SimulationHarness, DeployedContracts } from "../src";
import { buildTestSetup, PLACEHOLDER_CALLDATA } from "./helpers";

describe("Governor mock validation (issues #882-885)", () => {
  let harness: SimulationHarness;
  let addresses: DeployedContracts;
  let setup: ReturnType<typeof buildTestSetup>;

  beforeAll(async () => {
    setup = buildTestSetup({ proposers: 1, voters: 2, hasGuardian: true });
    harness = new SimulationHarness(setup.config);
    harness.registerActors(setup.actors);
    addresses = await harness.boot();
  });

  afterAll(async () => {
    await harness.teardown();
  });

  beforeEach(async () => {
    await harness.advanceLedgers(200);
  });

  describe("Issue #882: Error code mapping (ProposalNotActive)", () => {
    it("ProposalNotActive should map to error code #31, not #28", async () => {
      const proposalId = await harness.governorClient.propose(
        setup.actors.proposers[0].keypair,
        "Test error codes",
        "0".repeat(64),
        "ipfs://test",
        [addresses.governor],
        ["noop"],
        [PLACEHOLDER_CALLDATA],
      );

      const settings = await harness.governorClient.getSettings();

      // Advance past the voting window
      await harness.advanceLedgers(settings.votingDelay + settings.votingPeriod + 10);

      // Try to vote after voting period ends
      try {
        await harness.governorClient.castVote(
          setup.actors.voters[0].keypair,
          proposalId,
          VoteSupport.For,
        );
        fail("Should have thrown ProposalNotActive");
      } catch (err: unknown) {
        const error = err as any;
        expect(error.code).toBe(GovernorErrorCode.ProposalNotActive);
        expect(error.code).toBe(31); // Verify numeric value
      }
    });

    it("VotePeriodTooShort should be available as error code #28", () => {
      // Verify the enum has the correct value
      expect(GovernorErrorCode.VotePeriodTooShort).toBe(28);
    });

    it("TooManyCalldataEntries should be available as error code #30", () => {
      expect(GovernorErrorCode.TooManyCalldataEntries).toBe(30);
    });
  });

  describe("Issue #883: NoTargets vs InvalidVectorLengths", () => {
    it("should throw NoTargets (#10) when all three vectors are empty", async () => {
      try {
        await harness.governorClient.propose(
          setup.actors.proposers[0].keypair,
          "Empty targets",
          "0".repeat(64),
          "ipfs://empty",
          [], // empty targets
          [], // empty fnNames
          [], // empty calldatas
        );
        fail("Should have thrown NoTargets");
      } catch (err: unknown) {
        const error = err as any;
        if (error instanceof MockContractError) {
          expect(error.code).toBe(GovernorErrorCode.NoTargets);
        } else {
          expect((err as any).code).toBe(GovernorErrorCode.NoTargets);
        }
      }
    });

    it("should throw InvalidVectorLengths (#9) when fnNames length doesn't match", async () => {
      try {
        await harness.governorClient.propose(
          setup.actors.proposers[0].keypair,
          "Length mismatch",
          "0".repeat(64),
          "ipfs://mismatch",
          [addresses.governor, addresses.timelock], // 2 targets
          ["noop"], // 1 fnName (mismatch!)
          [PLACEHOLDER_CALLDATA, PLACEHOLDER_CALLDATA], // 2 calldatas
        );
        fail("Should have thrown InvalidVectorLengths");
      } catch (err: unknown) {
        const error = err as any;
        if (error instanceof MockContractError) {
          expect(error.code).toBe(GovernorErrorCode.InvalidVectorLengths);
        } else {
          expect((err as any).code).toBe(GovernorErrorCode.InvalidVectorLengths);
        }
      }
    });

    it("should throw InvalidVectorLengths (#9) when calldatas length doesn't match", async () => {
      try {
        await harness.governorClient.propose(
          setup.actors.proposers[0].keypair,
          "Calldata mismatch",
          "0".repeat(64),
          "ipfs://mismatch2",
          [addresses.governor], // 1 target
          ["noop"], // 1 fnName
          [PLACEHOLDER_CALLDATA, PLACEHOLDER_CALLDATA], // 2 calldatas (mismatch!)
        );
        fail("Should have thrown InvalidVectorLengths");
      } catch (err: unknown) {
        const error = err as any;
        if (error instanceof MockContractError) {
          expect(error.code).toBe(GovernorErrorCode.InvalidVectorLengths);
        } else {
          expect((err as any).code).toBe(GovernorErrorCode.InvalidVectorLengths);
        }
      }
    });
  });

  describe("Issue #884: Calldata size and count validation", () => {
    it("should throw CalldataTooLarge (#4) when calldata exceeds maxCalldataSize", async () => {
      const oversizedCalldata = Buffer.alloc(11_000); // exceeds default 10_000
      try {
        await harness.governorClient.propose(
          setup.actors.proposers[0].keypair,
          "Oversized calldata",
          "0".repeat(64),
          "ipfs://oversized",
          [addresses.governor],
          ["noop"],
          [oversizedCalldata],
        );
        fail("Should have thrown CalldataTooLarge");
      } catch (err: unknown) {
        const error = err as any;
        if (error instanceof MockContractError) {
          expect(error.code).toBe(GovernorErrorCode.CalldataTooLarge);
        } else {
          expect((err as any).code).toBe(GovernorErrorCode.CalldataTooLarge);
        }
      }
    });

    it("should throw TooManyCalldataEntries (#30) when more than 10 entries", async () => {
      const entries = Array(11).fill(PLACEHOLDER_CALLDATA);
      const targets = Array(11).fill(addresses.governor);
      const fnNames = Array(11).fill("noop");

      try {
        await harness.governorClient.propose(
          setup.actors.proposers[0].keypair,
          "Too many entries",
          "0".repeat(64),
          "ipfs://toomany",
          targets,
          fnNames,
          entries,
        );
        fail("Should have thrown TooManyCalldataEntries");
      } catch (err: unknown) {
        const error = err as any;
        if (error instanceof MockContractError) {
          expect(error.code).toBe(GovernorErrorCode.TooManyCalldataEntries);
        } else {
          expect((err as any).code).toBe(GovernorErrorCode.TooManyCalldataEntries);
        }
      }
    });

    it("should allow exactly 10 calldata entries", async () => {
      const entries = Array(10).fill(PLACEHOLDER_CALLDATA);
      const targets = Array(10).fill(addresses.governor);
      const fnNames = Array(10).fill("noop");

      // This should succeed (10 is the max)
      const proposalId = await harness.governorClient.propose(
        setup.actors.proposers[0].keypair,
        "Max entries",
        "0".repeat(64),
        "ipfs://maxentries",
        targets,
        fnNames,
        entries,
      );

      expect(proposalId).toBeDefined();
    });
  });

  describe("Issue #885: Pause/unpause modeling", () => {
    it("should throw ContractPaused (#7) when trying to propose on paused contract", async () => {
      // First, pause the contract
      const pauserKeypair = setup.actors.guardian?.keypair;
      if (!pauserKeypair) {
        throw new Error("No guardian for pausing test");
      }

      // Pause (this will be mocked through the harness)
      const mockStore = (harness as any).store;
      if (mockStore && mockStore.governor) {
        mockStore.governor.settings.isPaused = true;
      }

      // Try to propose on paused contract
      try {
        await harness.governorClient.propose(
          setup.actors.proposers[0].keypair,
          "Should fail - paused",
          "0".repeat(64),
          "ipfs://paused",
          [addresses.governor],
          ["noop"],
          [PLACEHOLDER_CALLDATA],
        );
        fail("Should have thrown ContractPaused");
      } catch (err: unknown) {
        const error = err as any;
        if (error instanceof MockContractError) {
          expect(error.code).toBe(GovernorErrorCode.ContractPaused);
        } else {
          // RPC error from SDK
          expect(error.message).toContain("paused");
        }
      }
    });

    it("should allow proposal after unpausing", async () => {
      const mockStore = (harness as any).store;
      if (mockStore && mockStore.governor) {
        // Ensure contract is unpaused
        mockStore.governor.settings.isPaused = false;
      }

      // This should succeed
      const proposalId = await harness.governorClient.propose(
        setup.actors.proposers[0].keypair,
        "After unpause",
        "0".repeat(64),
        "ipfs://unpaused",
        [addresses.governor],
        ["noop"],
        [PLACEHOLDER_CALLDATA],
      );

      expect(proposalId).toBeDefined();
    });

    it("should throw ContractPaused (#7) when trying to vote on paused contract", async () => {
      // Create and queue a proposal first (while unpaused)
      const mockStore = (harness as any).store;
      if (mockStore && mockStore.governor) {
        mockStore.governor.settings.isPaused = false;
      }

      const proposalId = await harness.governorClient.propose(
        setup.actors.proposers[0].keypair,
        "Vote pause test",
        "0".repeat(64),
        "ipfs://votepause",
        [addresses.governor],
        ["noop"],
        [PLACEHOLDER_CALLDATA],
      );

      const settings = await harness.governorClient.getSettings();
      await harness.advanceLedgers(settings.votingDelay + 1);

      // Now pause the contract
      if (mockStore && mockStore.governor) {
        mockStore.governor.settings.isPaused = true;
      }

      // Try to vote while paused
      try {
        await harness.governorClient.castVote(
          setup.actors.voters[0].keypair,
          proposalId,
          VoteSupport.For,
        );
        fail("Should have thrown ContractPaused");
      } catch (err: unknown) {
        const error = err as any;
        if (error instanceof MockContractError) {
          expect(error.code).toBe(GovernorErrorCode.ContractPaused);
        } else {
          // RPC error from SDK
          expect(error.message).toContain("paused");
        }
      }
    });
  });
});
