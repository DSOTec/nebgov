//! Delegation Registry: on-chain bookkeeping for who delegated to whom, when,
//! and through what chain, layered on top of the existing single-hop
//! `Delegate` mapping in `lib.rs`. This module does not change how voting
//! power itself is computed (see `apply_delegation`/`update_account_votes`);
//! it tracks history, per-delegatee delegator lists, and enforces a
//! configurable delegation-chain depth limit so that transitive delegation
//! (already representable via the existing `Delegate` mapping) can be
//! resolved, audited, and bounded.

use crate::{DataKey, TokenVotesContract, TokenVotesError};
use soroban_sdk::{contracttype, Address, Env, Symbol, Vec};

/// Safety bound on delegation-chain traversal. Real chains are already
/// bounded by `DelegationDepthLimit` at write time; this guards read-side
/// traversal against unbounded gas usage if that invariant is ever violated.
const MAX_CHAIN_WALK: u32 = 64;

#[contracttype]
#[derive(Clone)]
pub struct DelegationEntry {
    pub delegator: Address,
    pub delegatee: Address,
    pub delegated_at_ledger: u32,
    pub voting_power_at_delegation: i128,
    pub active: bool,
    pub revoked_at_ledger: Option<u32>,
}

#[contracttype]
#[derive(Clone)]
pub struct DelegationHistoryEntry {
    pub delegatee: Address,
    pub delegated_at_ledger: u32,
    pub revoked_at_ledger: Option<u32>,
    pub power_at_delegation: i128,
    pub sequence: u32,
}

#[contracttype]
#[derive(Clone)]
pub struct DelegatorInfo {
    pub address: Address,
    pub delegated_power: i128,
    pub delegated_at_ledger: u32,
    pub chain_depth: u32,
}

#[contracttype]
#[derive(Clone)]
pub struct DelegateProfile {
    pub address: Address,
    pub current_voting_power: i128,
    pub base_voting_power: i128,
    pub total_delegators: u32,
    pub total_delegated_power: i128,
    pub delegation_depth_limit: u32,
    pub first_delegated_at_ledger: Option<u32>,
}

// --- Internal helpers (called from lib.rs's apply_delegation hook) ---

fn get_depth_limit(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::DelegationDepthLimit)
        .unwrap_or(1)
}

/// Resolve the live delegation chain starting at `start`, following the
/// `Delegate` mapping until a terminal node (self-delegated or undelegated)
/// or `MAX_CHAIN_WALK` hops. Includes `start` as the first element.
fn resolve_chain(env: &Env, start: Address) -> Vec<Address> {
    let mut chain = Vec::new(env);
    chain.push_back(start.clone());
    let mut current = start;
    let mut hops = 0u32;
    loop {
        let next: Option<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::Delegate(current.clone()));
        match next {
            Some(n) if n != current => {
                // Checked here, not before the lookup: a `current` with no
                // further delegate is a legal terminal node even exactly at
                // MAX_CHAIN_WALK hops, and must be allowed to resolve as one.
                // Checking eagerly rejected a fully legitimate MAX_CHAIN_WALK-
                // hop chain before ever confirming it terminates.
                if hops >= MAX_CHAIN_WALK {
                    env.panic_with_error(TokenVotesError::ChainDepthExceeded);
                }
                current = n.clone();
                chain.push_back(n);
                hops += 1;
            }
            _ => break,
        }
    }
    chain
}


fn emit_delegation_registered(
    env: &Env,
    delegator: &Address,
    delegatee: &Address,
    power: i128,
    chain_depth: u32,
) {
    env.events().publish(
        (Symbol::new(env, "DelegationRegistered"), delegator.clone()),
        (delegatee.clone(), power, chain_depth),
    );
}

fn emit_delegation_revoked(env: &Env, delegator: &Address, previous_delegatee: &Address, at_ledger: u32) {
    env.events().publish(
        (Symbol::new(env, "DelegationRevoked"), delegator.clone()),
        (previous_delegatee.clone(), at_ledger),
    );
}

fn emit_delegation_depth_limit_updated(env: &Env, old_limit: u32, new_limit: u32) {
    env.events().publish(
        (Symbol::new(env, "DelegationDepthLimitUpdated"),),
        (old_limit, new_limit),
    );
}

/// Validate that delegating from `delegator` to `delegatee` is legal
/// (no cycle, does not exceed the configured depth limit). Must be called
/// before any state mutation for this delegation.
pub(crate) fn validate_delegation(env: &Env, delegator: &Address, delegatee: &Address) {
    assert!(
        !would_create_cycle(env, delegator.clone(), delegatee.clone()),
        "delegation would create a cycle"
    );

    let prospective_depth = resolve_chain(env, delegatee.clone()).len();
    let limit = get_depth_limit(env);
    assert!(
        prospective_depth <= limit,
        "delegation would exceed max chain depth"
    );
}

/// Record a (new or changed) delegation in the registry. Must be called
/// after the `Delegate(delegator)` mapping has already been updated to
/// `delegatee`, so that chain resolution reflects the new edge.
pub(crate) fn register_delegation(
    env: &Env,
    delegator: &Address,
    delegatee: &Address,
    power: i128,
    current_ledger: u32,
) {
    let history_key = DataKey::DelegationHistory(delegator.clone());
    let mut history: Vec<DelegationHistoryEntry> = env
        .storage()
        .persistent()
        .get(&history_key)
        .unwrap_or(Vec::new(env));
    let sequence = history.len();
    history.push_back(DelegationHistoryEntry {
        delegatee: delegatee.clone(),
        delegated_at_ledger: current_ledger,
        revoked_at_ledger: None,
        power_at_delegation: power,
        sequence,
    });
    env.storage().persistent().set(&history_key, &history);

    env.storage().persistent().set(
        &DataKey::DelegationRecord(delegator.clone(), delegatee.clone()),
        &DelegationEntry {
            delegator: delegator.clone(),
            delegatee: delegatee.clone(),
            delegated_at_ledger: current_ledger,
            voting_power_at_delegation: power,
            active: true,
            revoked_at_ledger: None,
        },
    );

    let received_key = DataKey::ReceivedDelegations(delegatee.clone());
    let mut received: Vec<Address> = env
        .storage()
        .persistent()
        .get(&received_key)
        .unwrap_or(Vec::new(env));
    received.push_back(delegator.clone());
    env.storage().persistent().set(&received_key, &received);

    let historical_key = DataKey::HistoricalDelegations(delegatee.clone());
    let mut historical: Vec<Address> = env
        .storage()
        .persistent()
        .get(&historical_key)
        .unwrap_or(Vec::new(env));
    if !historical.contains(delegator.clone()) {
        historical.push_back(delegator.clone());
        env.storage().persistent().set(&historical_key, &historical);
    }

    let count_key = DataKey::TotalDelegatorsFor(delegatee.clone());
    let count: u32 = env.storage().persistent().get(&count_key).unwrap_or(0);
    env.storage().persistent().set(&count_key, &(count + 1));

    let full_chain = resolve_chain(env, delegator.clone());
    let depth = full_chain.len() - 1;

    emit_delegation_registered(env, delegator, delegatee, power, depth);
}

/// Revoke a previously-registered delegation from `delegator` to
/// `old_delegatee` (called when `delegator` moves away from `old_delegatee`,
/// including moving back to self).
pub(crate) fn revoke_registry_entry(
    env: &Env,
    delegator: &Address,
    old_delegatee: &Address,
    current_ledger: u32,
) {
    let record_key = DataKey::DelegationRecord(delegator.clone(), old_delegatee.clone());
    let Some(mut entry) = env
        .storage()
        .persistent()
        .get::<_, DelegationEntry>(&record_key)
    else {
        return;
    };
    entry.active = false;
    entry.revoked_at_ledger = Some(current_ledger);
    env.storage().persistent().set(&record_key, &entry);

    let history_key = DataKey::DelegationHistory(delegator.clone());
    if let Some(mut history) = env
        .storage()
        .persistent()
        .get::<_, Vec<DelegationHistoryEntry>>(&history_key)
    {
        let len = history.len();
        let mut i = len;
        while i > 0 {
            i -= 1;
            let mut h = history.get(i).unwrap();
            if h.delegatee == *old_delegatee && h.revoked_at_ledger.is_none() {
                h.revoked_at_ledger = Some(current_ledger);
                history.set(i, h);
                break;
            }
        }
        env.storage().persistent().set(&history_key, &history);
    }

    let received_key = DataKey::ReceivedDelegations(old_delegatee.clone());
    if let Some(mut received) = env.storage().persistent().get::<_, Vec<Address>>(&received_key) {
        if let Some(idx) = received.first_index_of(delegator.clone()) {
            received.remove(idx);
            env.storage().persistent().set(&received_key, &received);
        }
    }

    let count_key = DataKey::TotalDelegatorsFor(old_delegatee.clone());
    let count: u32 = env.storage().persistent().get(&count_key).unwrap_or(0);
    if count > 0 {
        env.storage().persistent().set(&count_key, &(count - 1));
    }

    emit_delegation_revoked(env, delegator, old_delegatee, current_ledger);
}

// --- Public query / admin functions (wrapped by contract entrypoints in lib.rs) ---

pub(crate) fn get_delegation_history(env: &Env, delegator: Address) -> Vec<DelegationHistoryEntry> {
    env.storage()
        .persistent()
        .get(&DataKey::DelegationHistory(delegator))
        .unwrap_or(Vec::new(env))
}

pub(crate) fn get_delegators(
    env: &Env,
    delegatee: Address,
    offset: u32,
    limit: u32,
) -> Vec<DelegatorInfo> {
    let received: Vec<Address> = env
        .storage()
        .persistent()
        .get(&DataKey::ReceivedDelegations(delegatee.clone()))
        .unwrap_or(Vec::new(env));

    let mut result = Vec::new(env);
    let len = received.len();
    let mut i = offset;
    let end = offset.saturating_add(limit).min(len);
    while i < end {
        let delegator = received.get(i).unwrap();
        let record: Option<DelegationEntry> = env
            .storage()
            .persistent()
            .get(&DataKey::DelegationRecord(delegator.clone(), delegatee.clone()));
        let record_balance: crate::DelegatorRecord = env
            .storage()
            .persistent()
            .get(&DataKey::DelegatorRecord(delegator.clone()))
            .unwrap_or_default();

        result.push_back(DelegatorInfo {
            address: delegator.clone(),
            delegated_power: record_balance.balance,
            delegated_at_ledger: record.map(|r| r.delegated_at_ledger).unwrap_or(0),
            chain_depth: get_chain_depth(env, delegator),
        });
        i += 1;
    }
    result
}

pub(crate) fn get_delegator_count(env: &Env, delegatee: Address) -> u32 {
    env.storage()
        .persistent()
        .get(&DataKey::TotalDelegatorsFor(delegatee))
        .unwrap_or(0)
}

pub(crate) fn get_delegation_chain(env: &Env, delegator: Address) -> Vec<Address> {
    resolve_chain(env, delegator)
}

pub(crate) fn get_chain_depth(env: &Env, delegator: Address) -> u32 {
    resolve_chain(env, delegator).len() - 1
}

pub(crate) fn would_create_cycle(env: &Env, delegator: Address, delegatee: Address) -> bool {
    if delegator == delegatee {
        return false;
    }
    let chain = resolve_chain(env, delegatee);
    chain.contains(delegator)
}

pub(crate) fn get_delegate_profile(env: &Env, address: Address) -> DelegateProfile {
    let current_voting_power = TokenVotesContract::get_votes(env.clone(), address.clone());
    let base_voting_power = TokenVotesContract::get_base_votes(env.clone(), address.clone());
    let total_delegators = get_delegator_count(env, address.clone());

    let received: Vec<Address> = env
        .storage()
        .persistent()
        .get(&DataKey::ReceivedDelegations(address.clone()))
        .unwrap_or(Vec::new(env));

    let mut total_delegated_power: i128 = 0;
    let mut first_delegated_at_ledger: Option<u32> = None;
    for delegator in received.iter() {
        let record_balance: crate::DelegatorRecord = env
            .storage()
            .persistent()
            .get(&DataKey::DelegatorRecord(delegator.clone()))
            .unwrap_or_default();
        total_delegated_power += record_balance.balance;

        if let Some(entry) = env.storage().persistent().get::<_, DelegationEntry>(
            &DataKey::DelegationRecord(delegator.clone(), address.clone()),
        ) {
            first_delegated_at_ledger = Some(match first_delegated_at_ledger {
                Some(existing) => existing.min(entry.delegated_at_ledger),
                None => entry.delegated_at_ledger,
            });
        }
    }

    DelegateProfile {
        address,
        current_voting_power,
        base_voting_power,
        total_delegators,
        total_delegated_power,
        delegation_depth_limit: get_depth_limit(env),
        first_delegated_at_ledger,
    }
}

pub(crate) fn get_received_delegations(
    env: &Env,
    delegatee: Address,
    offset: u32,
    limit: u32,
) -> Vec<DelegationEntry> {
    let received: Vec<Address> = env
        .storage()
        .persistent()
        .get(&DataKey::ReceivedDelegations(delegatee.clone()))
        .unwrap_or(Vec::new(env));

    let mut result = Vec::new(env);
    let len = received.len();
    let mut i = offset;
    let end = offset.saturating_add(limit).min(len);
    while i < end {
        let delegator = received.get(i).unwrap();
        if let Some(entry) = env.storage().persistent().get::<_, DelegationEntry>(
            &DataKey::DelegationRecord(delegator, delegatee.clone()),
        ) {
            result.push_back(entry);
        }
        i += 1;
    }
    result
}

pub(crate) fn set_delegation_depth_limit(env: &Env, new_limit: u32) {
    assert!(new_limit >= 1, "depth limit must be at least 1");
    assert!(new_limit <= MAX_CHAIN_WALK, "depth limit must not exceed MAX_CHAIN_WALK");
    let old_limit = get_depth_limit(env);
    env.storage()
        .instance()
        .set(&DataKey::DelegationDepthLimit, &new_limit);
    emit_delegation_depth_limit_updated(env, old_limit, new_limit);
}

pub(crate) fn get_delegation_depth_limit(env: &Env) -> u32 {
    get_depth_limit(env)
}

/// Snapshot of all delegators active for `delegatee` at a past ledger,
/// reconstructed from each known delegator's history log. `chain_depth` is
/// not reconstructed historically and is always reported as 0.
pub(crate) fn get_delegation_snapshot(
    env: &Env,
    delegatee: Address,
    at_ledger: u32,
    offset: u32,
    limit: u32,
) -> Vec<DelegatorInfo> {
    let historical_delegators: Vec<Address> = env
        .storage()
        .persistent()
        .get(&DataKey::HistoricalDelegations(delegatee.clone()))
        .unwrap_or(Vec::new(env));

    let mut result = Vec::new(env);
    let len = historical_delegators.len();
    let mut i = offset;
    let end = offset.saturating_add(limit).min(len);
    while i < end {
        let delegator = historical_delegators.get(i).unwrap();
        let history: Vec<DelegationHistoryEntry> = env
            .storage()
            .persistent()
            .get(&DataKey::DelegationHistory(delegator.clone()))
            .unwrap_or(Vec::new(env));

        for entry in history.iter() {
            if entry.delegatee == delegatee
                && entry.delegated_at_ledger <= at_ledger
                && entry.revoked_at_ledger.is_none_or(|r| r > at_ledger)
            {
                result.push_back(DelegatorInfo {
                    address: delegator.clone(),
                    delegated_power: entry.power_at_delegation,
                    delegated_at_ledger: entry.delegated_at_ledger,
                    chain_depth: 0,
                });
                break;
            }
        }
        i += 1;
    }
    result
}
