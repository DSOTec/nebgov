import { VoteType } from "@nebgov/sdk";
import { ActorSet, createActors, SimulationConfig } from "../src";

export const PLACEHOLDER_CALLDATA = Buffer.from([]);

export interface TestSetup {
  actors: ActorSet;
  config: SimulationConfig;
}

/**
 * A default deterministic scenario config: every actor is funded and
 * self-delegated, so `voter-N`'s balance is directly its voting power.
 */
export function buildTestSetup(
  overrides: {
    proposers?: number;
    voters?: number;
    hasGuardian?: boolean;
    balances?: Record<string, bigint>;
    settings?: Partial<SimulationConfig["settings"]>;
  } = {},
): TestSetup {
  const actors = createActors({
    proposers: overrides.proposers ?? 1,
    voters: overrides.voters ?? 5,
    hasGuardian: overrides.hasGuardian ?? false,
  });

  const tokenBalances: Record<string, bigint> = {};
  const delegations: Record<string, string> = {};
  for (const actor of actors.all.values()) {
    tokenBalances[actor.publicKey] = overrides.balances?.[actor.name] ?? 1_000_000n;
    delegations[actor.publicKey] = actor.publicKey;
  }

  const config: SimulationConfig = {
    mode: "mock",
    settings: {
      votingDelay: 10,
      votingPeriod: 100,
      quorumNumerator: 40,
      proposalThreshold: 1n,
      timelockDelay: 3_600n,
      voteType: VoteType.Extended,
      guardian: actors.guardian?.publicKey,
      ...overrides.settings,
    },
    tokenBalances,
    delegations,
    initialLedger: 1000,
  };

  return { actors, config };
}
