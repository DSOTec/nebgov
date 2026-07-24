import { ProposalState } from "@nebgov/sdk";
import { SimulationHarness } from "../harness";
import { BaseScenario, ProposalScenarioConfig, SimulationResult } from "./base";

export type DefeatScenarioConfig = ProposalScenarioConfig;

/** Votes fail quorum or majority: proposal should resolve to Defeated. */
export class DefeatScenario extends BaseScenario {
  constructor(
    harness: SimulationHarness,
    private config: DefeatScenarioConfig,
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

    await this.harness.advanceLedgers(settings.votingPeriod + 1);

    const finalState = await governorClient.getProposalState(proposalId);
    return {
      success: finalState === ProposalState.Defeated,
      proposalId,
      finalState,
      ledgersElapsed: this.harness.clock.sequence - startLedger,
      errors: [],
    };
  }
}
