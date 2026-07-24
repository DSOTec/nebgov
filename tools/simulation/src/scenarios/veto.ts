import { ProposalState } from "@nebgov/sdk";
import { Actor } from "../actors";
import { SimulationHarness } from "../harness";
import { BaseScenario, ProposalScenarioConfig, SimulationResult } from "./base";

export interface GuardianVetoScenarioConfig extends ProposalScenarioConfig {
  guardian: Actor;
  /** Ledgers to advance after queuing before the guardian attempts the veto. Defaults to 0 (immediately). */
  advanceBeforeVeto?: number;
}

/** Guardian cancels a queued proposal, inside or outside its veto window. */
export class GuardianVetoScenario extends BaseScenario {
  constructor(
    harness: SimulationHarness,
    private config: GuardianVetoScenarioConfig,
  ) {
    super(harness);
  }

  async run(): Promise<SimulationResult> {
    const startLedger = this.harness.clock.sequence;
    const { governorClient } = this.harness;
    const errors: string[] = [];

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
    await governorClient.queue(this.config.proposer.keypair, proposalId);

    if (this.config.advanceBeforeVeto) {
      await this.harness.advanceLedgers(this.config.advanceBeforeVeto);
    }

    let vetoed = false;
    try {
      await this.harness.cancelQueuedProposal(this.config.guardian.keypair, proposalId);
      vetoed = true;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }

    const finalState = await governorClient.getProposalState(proposalId);
    return {
      success: vetoed && finalState === ProposalState.Cancelled,
      proposalId,
      finalState,
      ledgersElapsed: this.harness.clock.sequence - startLedger,
      errors,
    };
  }
}
