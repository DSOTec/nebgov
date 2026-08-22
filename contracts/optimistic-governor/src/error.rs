use soroban_sdk::contracterror;

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum OptimisticGovernorError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    InvalidConfiguration = 3,
    InvalidCalldata = 4,
    ProposalNotFound = 5,
    NotInChallengeWindow = 6,
    ChallengeWindowNotElapsed = 7,
    ChallengeWindowElapsed = 8,
    AlreadyObjected = 9,
    NoVotingPower = 10,
    ProposalObjected = 11,
    ProposalNotPassed = 12,
    ProposalAlreadyFinalized = 13,
    Unauthorized = 14,
    ArithmeticOverflow = 15,
    ProposalNotCancellable = 16,
}
