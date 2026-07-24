import { ProposalState } from "@nebgov/sdk";
import { SimulationHarness } from "../harness";
import { BaseScenario, ProposalScenarioConfig, SimulationResult } from "./base";

export type LifecycleScenarioConfig = ProposalScenarioConfig;

/** Drives a proposal through all six lifecycle states: propose -> vote -> queue -> execute. */
export class FullLifecycleScenario extends BaseScenario {
  constructor(
    harness: SimulationHarness,
    private config: LifecycleScenarioConfig,
  ) {
    super(harness);
  }

  async run(): Promise<SimulationResult> {
    const startLedger = this.harness.clock.sequence;
    const { governorClient, timelockClient } = this.harness;
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

    // Phase 1: advance past the voting delay so the proposal becomes Active.
    await this.harness.advanceLedgers(settings.votingDelay + 1);

    // Phase 2: cast votes.
    for (const { actor, support } of this.config.voters) {
      await actor.vote(governorClient, proposalId, support);
    }

    // Phase 3: advance past the voting period so the proposal resolves.
    await this.harness.advanceLedgers(settings.votingPeriod + 1);

    // Phase 4: queue (transitions to Timelock).
    try {
      await governorClient.queue(this.config.proposer.keypair, proposalId);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
      const finalState = await governorClient.getProposalState(proposalId);
      return { success: false, proposalId, finalState, ledgersElapsed: this.harness.clock.sequence - startLedger, errors };
    }

    // Phase 5: advance past the timelock delay.
    const delaySeconds = await timelockClient.minDelay();
    await this.harness.advanceLedgers(this.harness.clock.secondsToLedgers(Number(delaySeconds)) + 1);

    // Phase 6: execute.
    try {
      await governorClient.execute(this.config.proposer.keypair, proposalId);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }

    const finalState = await governorClient.getProposalState(proposalId);
    return {
      success: finalState === ProposalState.Executed,
      proposalId,
      finalState,
      ledgersElapsed: this.harness.clock.sequence - startLedger,
      errors,
    };
  }
}
