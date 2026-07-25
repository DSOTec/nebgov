use soroban_sdk::{Address, Env, Symbol};

pub const DELEGATED_BY_SIG_TOPIC: &str = "DelegatedBySig";
pub const PERMITS_INVALIDATED_TOPIC: &str = "PermitsInvalidated";
pub const RELAYER_WHITELIST_UPDATED_TOPIC: &str = "RelayerWhitelistUpdated";

#[derive(Clone)]
#[soroban_sdk::contracttype]
pub struct DelegatedBySigEvent {
    pub delegator: Address,
    pub delegatee: Address,
    pub relayer: Address,
    pub nonce: u64,
}

#[derive(Clone)]
#[soroban_sdk::contracttype]
pub struct PermitsInvalidatedEvent {
    pub delegator: Address,
    pub new_nonce: u64,
}

#[derive(Clone)]
#[soroban_sdk::contracttype]
pub struct RelayerWhitelistUpdatedEvent {
    pub relayer: Address,
    pub whitelisted: bool,
}

/// Emitted whenever a signed delegation permit is applied on-chain via
/// `delegate_by_sig` or `delegate_batch_by_sig`.
pub fn emit_delegated_by_sig(
    env: &Env,
    delegator: &Address,
    delegatee: &Address,
    relayer: &Address,
    nonce: u64,
) {
    env.events().publish(
        (Symbol::new(env, DELEGATED_BY_SIG_TOPIC), delegator.clone()),
        DelegatedBySigEvent {
            delegator: delegator.clone(),
            delegatee: delegatee.clone(),
            relayer: relayer.clone(),
            nonce,
        },
    );
}

/// Emitted when a delegator invalidates all of their outstanding signed
/// permits by bumping their nonce past anything they may have already signed.
pub fn emit_permits_invalidated(env: &Env, delegator: &Address, new_nonce: u64) {
    env.events().publish(
        (
            Symbol::new(env, PERMITS_INVALIDATED_TOPIC),
            delegator.clone(),
        ),
        PermitsInvalidatedEvent {
            delegator: delegator.clone(),
            new_nonce,
        },
    );
}

/// Emitted when the admin adds/removes a relayer from the whitelist.
pub fn emit_relayer_whitelist_updated(env: &Env, relayer: &Address, whitelisted: bool) {
    env.events().publish(
        (
            Symbol::new(env, RELAYER_WHITELIST_UPDATED_TOPIC),
            relayer.clone(),
        ),
        RelayerWhitelistUpdatedEvent {
            relayer: relayer.clone(),
            whitelisted,
        },
    );
}
