import { createHash } from "node:crypto";
import { GovernorClient, VoteSupport, VotesClient } from "@nebgov/sdk";
import { Keypair } from "@stellar/stellar-sdk";

export interface ActorRole {
  isProposer?: boolean;
  isVoter?: boolean;
  isGuardian?: boolean;
}

/** A simulated governance participant with a deterministic keypair. */
export class Actor {
  constructor(
    readonly name: string,
    readonly keypair: Keypair,
    readonly role: ActorRole = {},
  ) {}

  get publicKey(): string {
    return this.keypair.publicKey();
  }

  /** Cast a vote on `proposalId` using this actor's keypair. */
  async vote(client: GovernorClient, proposalId: bigint, support: VoteSupport): Promise<string> {
    return client.castVote(this.keypair, proposalId, support);
  }

  /** Delegate this actor's voting power to `delegatee` (or itself). */
  async delegateTo(votesClient: VotesClient, delegatee: Actor | string): Promise<string> {
    const target = typeof delegatee === "string" ? delegatee : delegatee.publicKey;
    return votesClient.delegate(this.keypair, target);
  }
}

export interface ActorSet {
  proposers: Actor[];
  voters: Actor[];
  guardian?: Actor;
  /** All actors keyed by name (e.g. "proposer-0", "voter-3", "guardian"). */
  all: Map<string, Actor>;
}

/** Deterministic 32-byte Ed25519 seed so simulation runs are reproducible without a faucet. */
function deterministicSeed(label: string): Buffer {
  return createHash("sha256").update(`nebgov-simulation-actor:${label}`).digest();
}

function makeActor(name: string, role: ActorRole): Actor {
  const keypair = Keypair.fromRawEd25519Seed(deterministicSeed(name));
  return new Actor(name, keypair, role);
}

/** Build a deterministic set of proposer/voter/guardian actors for a simulation run. */
export function createActors(config: { proposers: number; voters: number; hasGuardian?: boolean }): ActorSet {
  const all = new Map<string, Actor>();

  const proposers = Array.from({ length: config.proposers }, (_, i) => {
    const actor = makeActor(`proposer-${i}`, { isProposer: true });
    all.set(actor.name, actor);
    return actor;
  });

  const voters = Array.from({ length: config.voters }, (_, i) => {
    const actor = makeActor(`voter-${i}`, { isVoter: true });
    all.set(actor.name, actor);
    return actor;
  });

  let guardian: Actor | undefined;
  if (config.hasGuardian) {
    guardian = makeActor("guardian", { isGuardian: true });
    all.set(guardian.name, guardian);
  }

  return { proposers, voters, guardian, all };
}
