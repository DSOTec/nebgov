use soroban_sdk::contracterror;

/// Error codes for the token-votes contract.
///
/// Codes 1-9 are reserved for delegation/checkpoint invariants that today
/// panic via `assert!`/`expect` (see lib.rs); codes 10-16 cover the
/// signed-delegation (`delegate_by_sig`) flow introduced for issue #772.
#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum TokenVotesError {
    /// Reserved for parity with the numbering requested in issue #772.
    ///
    /// Not raised directly: an invalid `delegate_by_sig` signature is
    /// rejected by Soroban's native authorization framework (a host-level
    /// auth trap) before contract code regains control, because
    /// verification is delegated to `Address::require_auth_for_args`
    /// rather than a manual `ed25519_verify` call (see delegation_sig.rs).
    InvalidSignature = 10,
    NonceAlreadyUsed = 11,
    PermitExpired = 12,
    InvalidDelegationPermit = 13,
    RelayerNotWhitelisted = 14,
    InvalidChainId = 15,
    InvalidContractId = 16,
    ChainDepthExceeded = 17,
}
