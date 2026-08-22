//! Split delegation: delegating arbitrary basis-point percentages of one's
//! voting power across up to `MaxSplitTargets` delegatees simultaneously.
//!
//! This is additive to the existing single-target `Delegate` mapping/
//! `apply_delegation` path in `lib.rs`, which keeps working completely
//! unchanged for any account that never calls a `*_split` entrypoint. A
//! plain `delegate(a, b)` call is the degenerate one-entry case of a split
//! (100% to `b`); this module treats it that way on the *read* side
//! (`get_split_delegations` falls back to the legacy `Delegate` mapping) and
//! collapses a single 100%-weight split back into the legacy `Delegate` key
//! on the *write* side, so a delegator who has only ever used `delegate_split`
//! with one entry remains fully interoperable with `delegate()`/`undelegate()`
//! and with `delegation_registry`'s chain resolution. Once a delegator has a
//! genuine multi-entry split on file, falling back to the plain `delegate()`
//! entrypoint is out of scope (not exercised by existing tests, and the
//! issue's compatibility requirement is one-directional: legacy accounts
//! that never touch the split API).

use crate::{DataKey, DelegatorRecord, TokenVotesContract, TokenVotesError};
use soroban_sdk::{contracttype, token, Address, Env, Symbol, Vec};

const BPS_DENOMINATOR: u32 = 10000;
const DEFAULT_MAX_SPLIT_TARGETS: u32 = 10;

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct SplitDelegation {
    pub delegatee: Address,
    pub weight_bps: u32,
}

fn emit_split_delegated(env: &Env, delegator: &Address, splits: &Vec<SplitDelegation>) {
    env.events().publish(
        (Symbol::new(env, "SplitDelegated"), delegator.clone()),
        splits.clone(),
    );
}

fn emit_split_undelegated(env: &Env, delegator: &Address) {
    env.events().publish(
        (Symbol::new(env, "SplitUndelegated"), delegator.clone()),
        (),
    );
}

pub(crate) fn get_max_split_targets(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::MaxSplitTargets)
        .unwrap_or(DEFAULT_MAX_SPLIT_TARGETS)
}

pub(crate) fn set_max_split_targets(env: &Env, max_targets: u32) {
    assert!(max_targets >= 1, "max targets must be at least 1");
    env.storage()
        .instance()
        .set(&DataKey::MaxSplitTargets, &max_targets);
}

fn validate_splits(env: &Env, splits: &Vec<SplitDelegation>) {
    let n = splits.len();
    assert!(n > 0, "splits must not be empty");

    let max_targets = get_max_split_targets(env);
    if n > max_targets {
        env.panic_with_error(TokenVotesError::SplitTooManyTargets);
    }

    let mut sum: u32 = 0;
    let mut i: u32 = 0;
    while i < n {
        let s = splits.get(i).unwrap();
        if s.weight_bps == 0 {
            env.panic_with_error(TokenVotesError::SplitZeroWeight);
        }
        sum = sum.checked_add(s.weight_bps).expect("weight_bps overflow");

        let mut j = i + 1;
        while j < n {
            if splits.get(j).unwrap().delegatee == s.delegatee {
                env.panic_with_error(TokenVotesError::SplitDuplicateDelegatee);
            }
            j += 1;
        }
        i += 1;
    }

    if sum != BPS_DENOMINATOR {
        env.panic_with_error(TokenVotesError::SplitWeightsMustSum10000);
    }
}

/// Split `total` across `splits` by `weight_bps`, crediting the rounding
/// remainder from integer division to the last entry so the parts always
/// sum exactly to `total`.
fn split_amount(splits: &Vec<SplitDelegation>, index: u32, total: i128) -> i128 {
    let n = splits.len();
    if index == n - 1 {
        let mut allocated: i128 = 0;
        let mut i: u32 = 0;
        while i < n - 1 {
            let s = splits.get(i).unwrap();
            allocated += (total * s.weight_bps as i128) / BPS_DENOMINATOR as i128;
            i += 1;
        }
        total - allocated
    } else {
        let s = splits.get(index).unwrap();
        (total * s.weight_bps as i128) / BPS_DENOMINATOR as i128
    }
}

/// Remove whatever distribution `delegator` currently has on file — either a
/// legacy single `Delegate` target or an existing split — crediting the
/// removed voting power back out of each affected delegatee's checkpoints
/// and revoking the corresponding registry entries. Returns whether the
/// delegator had any prior distribution at all (needed to decide whether the
/// upcoming total-supply update is a delta or a first-time addition).
fn remove_old_distribution(
    env: &Env,
    delegator: &Address,
    old_record: &DelegatorRecord,
    current_ledger: u32,
) -> bool {
    let legacy: Option<Address> = env
        .storage()
        .persistent()
        .get(&DataKey::Delegate(delegator.clone()));

    if let Some(old_delegatee) = legacy {
        let old_ws = old_record.balance * old_record.start_ledger as i128;
        if old_record.balance != 0 || old_ws != 0 {
            TokenVotesContract::update_account_votes(
                env,
                old_delegatee.clone(),
                -old_record.balance,
                -old_ws,
            );
        }
        if old_delegatee != *delegator {
            crate::delegation_registry::revoke_registry_entry(
                env,
                delegator,
                &old_delegatee,
                current_ledger,
            );
        }
        env.storage()
            .persistent()
            .remove(&DataKey::Delegate(delegator.clone()));
        return true;
    }

    let old_splits: Vec<SplitDelegation> = env
        .storage()
        .persistent()
        .get(&DataKey::SplitDelegations(delegator.clone()))
        .unwrap_or(Vec::new(env));
    if old_splits.is_empty() {
        return false;
    }

    let n = old_splits.len();
    let mut i: u32 = 0;
    while i < n {
        let s = old_splits.get(i).unwrap();
        let entry_balance = split_amount(&old_splits, i, old_record.balance);
        let entry_ws = entry_balance * old_record.start_ledger as i128;
        if entry_balance != 0 || entry_ws != 0 {
            TokenVotesContract::update_account_votes(env, s.delegatee.clone(), -entry_balance, -entry_ws);
        }
        if s.delegatee != *delegator {
            crate::delegation_registry::revoke_registry_entry(env, delegator, &s.delegatee, current_ledger);
        }
        i += 1;
    }

    env.storage()
        .persistent()
        .remove(&DataKey::SplitDelegations(delegator.clone()));
    true
}

fn apply_new_distribution(
    env: &Env,
    delegator: &Address,
    splits: &Vec<SplitDelegation>,
    balance: i128,
    start_ledger: u32,
    current_ledger: u32,
) {
    let n = splits.len();
    let mut i: u32 = 0;
    while i < n {
        let s = splits.get(i).unwrap();
        let entry_balance = split_amount(splits, i, balance);
        let entry_ws = entry_balance * start_ledger as i128;
        if entry_balance != 0 || entry_ws != 0 {
            TokenVotesContract::update_account_votes(env, s.delegatee.clone(), entry_balance, entry_ws);
        }
        if s.delegatee != *delegator {
            crate::delegation_registry::register_delegation(
                env,
                delegator,
                &s.delegatee,
                entry_balance,
                current_ledger,
            );
        }
        i += 1;
    }
}

/// Store the resulting split on file. A single 100%-weight entry is
/// collapsed into the legacy `Delegate` key rather than `SplitDelegations` —
/// see the module doc comment for why this matters for interop.
fn store_result(env: &Env, delegator: &Address, splits: &Vec<SplitDelegation>) {
    env.storage()
        .persistent()
        .remove(&DataKey::SplitDelegations(delegator.clone()));
    env.storage()
        .persistent()
        .remove(&DataKey::Delegate(delegator.clone()));

    if splits.len() == 1 && splits.get(0).unwrap().weight_bps == BPS_DENOMINATOR {
        env.storage().persistent().set(
            &DataKey::Delegate(delegator.clone()),
            &splits.get(0).unwrap().delegatee,
        );
    } else {
        env.storage()
            .persistent()
            .set(&DataKey::SplitDelegations(delegator.clone()), splits);
    }
}

/// Shared engine for both `delegate_split` and `undelegate_split` (the
/// latter calling in with a single 100%-to-self entry) — the "one code path"
/// for split voting-power computation the issue asks for.
fn apply_split_core(env: &Env, delegator: Address, splits: Vec<SplitDelegation>) {
    validate_splits(env, &splits);

    let token_addr: Address = env
        .storage()
        .instance()
        .get(&DataKey::Token)
        .expect("token not set");
    let balance = token::TokenClient::new(env, &token_addr).balance(&delegator);

    let current_ledger = env.ledger().sequence();
    let old_record: DelegatorRecord = env
        .storage()
        .persistent()
        .get(&DataKey::DelegatorRecord(delegator.clone()))
        .unwrap_or_default();

    let mut new_record = old_record.clone();
    new_record.balance = balance;
    if balance > old_record.balance {
        let added = balance - old_record.balance;
        let total_weighted_start = (old_record.balance * old_record.start_ledger as i128)
            + (added * current_ledger as i128);
        new_record.start_ledger = if balance > 0 {
            (total_weighted_start / balance) as u32
        } else {
            current_ledger
        };
    }

    let old_weighted_sum = old_record.balance * old_record.start_ledger as i128;
    let new_weighted_sum = new_record.balance * new_record.start_ledger as i128;

    let had_prior = remove_old_distribution(env, &delegator, &old_record, current_ledger);

    if had_prior {
        let delta = new_record.balance - old_record.balance;
        let delta_ws = new_weighted_sum - old_weighted_sum;
        if delta != 0 || delta_ws != 0 {
            TokenVotesContract::update_total_supply_checkpoint(env, delta, delta_ws);
        }
    } else if balance > 0 {
        TokenVotesContract::update_total_supply_checkpoint(env, balance, new_weighted_sum);
    }

    apply_new_distribution(
        env,
        &delegator,
        &splits,
        new_record.balance,
        new_record.start_ledger,
        current_ledger,
    );

    store_result(env, &delegator, &splits);
    env.storage()
        .persistent()
        .set(&DataKey::DelegatorRecord(delegator.clone()), &new_record);
}

pub(crate) fn delegate_split(env: &Env, delegator: Address, splits: Vec<SplitDelegation>) {
    apply_split_core(env, delegator.clone(), splits.clone());
    emit_split_delegated(env, &delegator, &splits);
}

pub(crate) fn undelegate_split(env: &Env, delegator: Address) {
    let legacy: Option<Address> = env
        .storage()
        .persistent()
        .get(&DataKey::Delegate(delegator.clone()));
    let has_split: bool = {
        let s: Vec<SplitDelegation> = env
            .storage()
            .persistent()
            .get(&DataKey::SplitDelegations(delegator.clone()))
            .unwrap_or(Vec::new(env));
        !s.is_empty()
    };

    if !has_split {
        match &legacy {
            None => return,
            Some(d) if *d == delegator => return,
            _ => {}
        }
    }

    let mut self_splits = Vec::new(env);
    self_splits.push_back(SplitDelegation {
        delegatee: delegator.clone(),
        weight_bps: BPS_DENOMINATOR,
    });
    apply_split_core(env, delegator.clone(), self_splits);
    emit_split_undelegated(env, &delegator);
}

pub(crate) fn get_split_delegations(env: &Env, delegator: Address) -> Vec<SplitDelegation> {
    let stored: Vec<SplitDelegation> = env
        .storage()
        .persistent()
        .get(&DataKey::SplitDelegations(delegator.clone()))
        .unwrap_or(Vec::new(env));
    if !stored.is_empty() {
        return stored;
    }

    if let Some(delegatee) = env
        .storage()
        .persistent()
        .get::<_, Address>(&DataKey::Delegate(delegator))
    {
        let mut v = Vec::new(env);
        v.push_back(SplitDelegation {
            delegatee,
            weight_bps: BPS_DENOMINATOR,
        });
        return v;
    }

    Vec::new(env)
}
