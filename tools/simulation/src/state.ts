import { GovernorClient, ProposalState, ProposalVotes, TimelockClient, VotesClient } from "@nebgov/sdk";

/** Thin read-only wrapper around the three governance clients, for scenarios/assertions. */
export class StateInspector {
  constructor(
    private readonly governor: GovernorClient,
    private readonly timelock: TimelockClient,
    private readonly votes: VotesClient,
  ) {}

  proposalState(proposalId: bigint): Promise<ProposalState> {
    return this.governor.getProposalState(proposalId);
  }

  proposalVotes(proposalId: bigint): Promise<ProposalVotes> {
    return this.governor.getProposalVotes(proposalId);
  }

  delegatedVotes(account: string): Promise<bigint> {
    return this.votes.getVotes(account);
  }

  isOperationReady(opId: string): Promise<boolean> {
    return this.timelock.isReady(opId);
  }
}
