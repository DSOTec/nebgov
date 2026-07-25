// Re-exports for backwards compatibility
// All existing public exports remain importable from @nebgov/sdk

export { GovernorClient } from "./governor-client";
export {
  toBigInt,
  simulationCostValue,
  scVecAddress,
  scVecSymbol,
  scVecBytes,
} from "./governor-client";

export {
  propose,
  proposeWithSign,
  simulateTargetInvocation,
  simulateProposal,
  estimateProposeResources,
  cancel,
  cancelByGovernance,
  cancelByGovernanceWithSign,
  waitForProposalState,
  getProposal,
  getQueueTime,
  getQueuedOpIds,
  getTimelockInfo,
  getProposalsBatch,
  getProposalExpiryLedger,
  validateGovernorSettings,
  buildUpdateConfigProposal,
} from "./proposals";

export {
  estimateVoteGas,
  castVote,
  castVoteWithSign,
  castVoteWithReason,
  castVoteWithReasonAndSign,
  getProposalVotes,
  hasVoted,
  canPropose,
  getVotingHistory,
  getVotesCastByAddress,
  getReceipt,
  getVoteReason,
} from "./voting";

export {
  estimateExecutionGas,
} from "./execution";

export {
  proposalThreshold,
  getSettings,
  getProposalState,
  decodeProposalState,
  getQuorum,
  isQuorumReached,
  getLatestLedger,
  onProposalStateChange,
  proposalCount,
  getProposalFromIndexer,
  getLastProposalLedger,
  getProposalsInPeriod,
  getProposalsSummaryBatch,
} from "./queries";

export {
  getGuardianActivity,
  getProposalsForAddress,
} from "./events";

export {
  generateCommitment,
  commitVote,
  revealVote,
  hasCommitted,
  getCommitDeadline,
  getRevealDeadline,
  getCommitRevealStatus,
} from "./commitReveal";

// Re-export MetadataUploadOptions from the original governor.ts
export type { MetadataUploadOptions } from "../governor";

// Re-export utility functions from the original governor.ts
export { hashDescription, hashDescriptionSync, uploadProposalMetadata } from "../governor";
