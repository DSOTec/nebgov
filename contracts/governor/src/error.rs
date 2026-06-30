use soroban_sdk::contracterror;

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum GovernorError {
    UnauthorizedCancel = 1,
    InvalidSupport = 2,
    ProposalExpired = 3,
    CalldataTooLarge = 4,
    InvalidCalldata = 5,
    ProposalRateLimited = 6,
    ContractPaused = 7,
    UnauthorizedPause = 8,
    InvalidVectorLengths = 9,
    NoTargets = 10,
    ProposalThresholdNotMet = 11,
    AlreadyVoted = 12,
    ZeroVotingPower = 13,
    ProposalNotSucceeded = 14,
    ProposalNotQueued = 15,
    ProposalAlreadyExecuted = 16,
    MissingOpIds = 17,
    UnauthorizedGuardian = 18,
    VetoWindowClosed = 19,
    ProposalNotFound = 20,
    TimelockNotSet = 21,
    GuardianNotSet = 22,
    TooManyTokens = 23,
    EmptyMetadataUri = 24,
    VotesTokenNotSet = 25,
    PauserNotSet = 26,
    ArithmeticOverflow = 27,
    VotePeriodTooShort = 28,
    ExecutionWindowZero = 29,
    TooManyCalldataEntries = 30,
    /// Vote was cast outside the proposal's Active voting window.
    ProposalNotActive = 31,
    /// The contract has already been initialized.
    AlreadyInitialized = 32,
    /// voting_delay exceeds the protocol maximum (1_209_600 ledgers).
    InvalidVotingDelay = 33,
    /// voting_period must be greater than zero.
    InvalidVotingPeriod = 34,
    /// quorum_numerator must be at most 100.
    InvalidQuorumNumerator = 35,
    /// proposal_threshold must be non-negative.
    InvalidProposalThreshold = 36,
    /// max_calldata_size must be greater than zero.
    InvalidMaxCalldataSize = 37,
    /// max_proposals_per_period must be greater than zero.
    InvalidMaxProposalsPerPeriod = 38,
    /// proposal_period_duration must be greater than zero.
    InvalidProposalPeriodDuration = 39,
    /// The proposal batch was empty.
    EmptyBatch = 40,
    /// A proposal in the batch was not in the Queued state.
    BatchProposalNotQueued = 41,
    /// The proposal has already been cancelled.
    ProposalAlreadyCancelled = 42,
    /// Invalid vote choice: must be 0 (Against), 1 (For), or 2 (Abstain).
    InvalidVoteChoice = 43,
}
