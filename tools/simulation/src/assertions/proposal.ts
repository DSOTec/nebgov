import { GovernorClient, ProposalState } from "@nebgov/sdk";
import { AssertionError } from "./errors";

export async function assertProposalState(client: GovernorClient, proposalId: bigint, expected: ProposalState): Promise<void> {
  const actual = await client.getProposalState(proposalId);
  if (actual !== expected) {
    throw new AssertionError(`Proposal ${proposalId}: expected state ${expected}, got ${actual}`);
  }
}

export async function assertVoteCounts(
  client: GovernorClient,
  proposalId: bigint,
  expected: { votesFor?: bigint; votesAgainst?: bigint; votesAbstain?: bigint },
): Promise<void> {
  const votes = await client.getProposalVotes(proposalId);
  if (expected.votesFor !== undefined && votes.votesFor !== expected.votesFor) {
    throw new AssertionError(`Proposal ${proposalId}: expected votesFor ${expected.votesFor}, got ${votes.votesFor}`);
  }
  if (expected.votesAgainst !== undefined && votes.votesAgainst !== expected.votesAgainst) {
    throw new AssertionError(`Proposal ${proposalId}: expected votesAgainst ${expected.votesAgainst}, got ${votes.votesAgainst}`);
  }
  if (expected.votesAbstain !== undefined && votes.votesAbstain !== expected.votesAbstain) {
    throw new AssertionError(`Proposal ${proposalId}: expected votesAbstain ${expected.votesAbstain}, got ${votes.votesAbstain}`);
  }
}

export async function assertQuorumReached(client: GovernorClient, proposalId: bigint): Promise<void> {
  const reached = await client.isQuorumReached(proposalId);
  if (!reached) throw new AssertionError(`Proposal ${proposalId}: expected quorum to be reached`);
}

export async function assertQuorumNotReached(client: GovernorClient, proposalId: bigint): Promise<void> {
  const reached = await client.isQuorumReached(proposalId);
  if (reached) throw new AssertionError(`Proposal ${proposalId}: expected quorum to NOT be reached`);
}
