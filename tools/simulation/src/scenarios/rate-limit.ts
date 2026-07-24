import { Actor } from "../actors";
import { SimulationHarness } from "../harness";
import { BaseScenario, SimulationResult } from "./base";

export interface RateLimitScenarioConfig {
  proposer: Actor;
  description: string;
  targets: string[];
  fnNames: string[];
  calldatas: Buffer[];
}

/** A second proposal from the same proposer within the rate-limit period is rejected. */
export class RateLimitScenario extends BaseScenario {
  constructor(
    harness: SimulationHarness,
    private config: RateLimitScenarioConfig,
  ) {
    super(harness);
  }

  async run(): Promise<SimulationResult> {
    const startLedger = this.harness.clock.sequence;
    const { governorClient } = this.harness;
    const errors: string[] = [];

    const firstId = await governorClient.propose(
      this.config.proposer.keypair,
      `${this.config.description} #1`,
      "0".repeat(64),
      "ipfs://simulation",
      this.config.targets,
      this.config.fnNames,
      this.config.calldatas,
    );

    let rejected = false;
    try {
      await governorClient.propose(
        this.config.proposer.keypair,
        `${this.config.description} #2`,
        "0".repeat(64),
        "ipfs://simulation",
        this.config.targets,
        this.config.fnNames,
        this.config.calldatas,
      );
    } catch (e) {
      rejected = true;
      errors.push(e instanceof Error ? e.message : String(e));
    }

    return {
      success: rejected,
      proposalId: firstId,
      ledgersElapsed: this.harness.clock.sequence - startLedger,
      errors,
    };
  }
}
