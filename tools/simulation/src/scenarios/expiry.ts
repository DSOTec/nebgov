import { ProposalState } from "@nebgov/sdk";
import { SimulationHarness } from "../harness";
import { BaseScenario, ProposalScenarioConfig, SimulationResult } from "./base";

export type ExpiryScenarioConfig = ProposalScenarioConfig;

/** A proposal that succeeds but is never queued expires once its grace period elapses. */
export class ExpiryScenario extends BaseScenario {
  constructor(
    harness: SimulationHarness,
    private config: ExpiryScenarioConfig,
  ) {
    super(harness);
  }

  async run(): Promise<SimulationResult> {
    const startLedger = this.harness.clock.sequence;
    const { governorClient } = this.harness;

    const proposalId = await governorClient.propose(
      this.config.proposer.keypair,
      this.config.description,
      "0".repeat(64),
      "ipfs://simulation",
      this.config.targets,
      this.config.fnNames,
      this.config.calldatas,
    );

    const settings = await governorClient.getSettings();
    await this.harness.advanceLedgers(settings.votingDelay + 1);

    for (const { actor, support } of this.config.voters) {
      await actor.vote(governorClient, proposalId, support);
    }

    // Advance past the voting period (Succeeded) and then past the grace
    // period without ever calling queue().
    await this.harness.advanceLedgers(settings.votingPeriod + settings.proposalGracePeriod + 2);

    const finalState = await governorClient.getProposalState(proposalId);
    return {
      success: finalState === ProposalState.Expired,
      proposalId,
      finalState,
      ledgersElapsed: this.harness.clock.sequence - startLedger,
      errors: [],
    };
  }
}
