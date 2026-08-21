use soroban_sdk::contracterror;

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ConvictionVotingError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    InvalidConfiguration = 3,
    InvalidAmount = 4,
    ProposalNotFound = 5,
    ProposalClosed = 6,
    InsufficientVotingPower = 7,
    StakeNotFound = 8,
    Unauthorized = 9,
    ArithmeticOverflow = 10,
    InvalidCalldata = 11,
}
