#![no_std]
#![allow(clippy::too_many_arguments)]

//! Governance-controlled yield strategy allocation for idle treasury funds.
//!
//! This contract does not custody funds long-term on its own authority: the
//! `contracts/treasury` multisig moves tokens in via an ordinary outbound
//! transaction targeting [`TreasuryStrategiesContract::deposit`], and every
//! withdrawal ultimately settles back to that same treasury address. Yield
//! sources are integrated behind a minimal [`StrategyAdapterTrait`] so any
//! external protocol can be whitelisted by governance without changes to
//! this contract; [`adapters::mock_adapter`] ships a simple fixed-APY
//! simulated adapter for tests and the simulation harness.
//!
//! Access control model:
//! - only the configured admin may `register_strategy` / `deactivate_strategy`
//! - only the configured treasury may `deposit` / `request_withdrawal`
//! - `claim_withdrawal` is permissionless once its cooldown has elapsed

mod events;
use events::*;

pub mod adapters;

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, token, Address, Env,
    Vec,
};

const TTL_LEDGERS: u32 = 6_307_200;
const BPS_DENOMINATOR: i128 = 10_000;

#[contractclient(name = "StrategyAdapterClient")]
pub trait StrategyAdapterTrait {
    fn adapter_deposit(env: Env, caller: Address, token: Address, amount: i128);
    fn adapter_withdraw(env: Env, caller: Address, token: Address, amount: i128) -> i128;
    fn adapter_balance(env: Env, token: Address) -> i128;
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Strategy {
    pub adapter: Address,
    pub token: Address,
    pub max_allocation_bps: u32,
    pub withdrawal_cooldown_ledgers: u32,
    pub active: bool,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Allocation {
    pub strategy_id: u64,
    pub amount: i128,
    pub deposited_ledger: u32,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct WithdrawalRequest {
    pub strategy_id: u64,
    pub amount: i128,
    pub requested_ledger: u32,
    pub claimable_ledger: u32,
    pub claimed: bool,
}

#[contracttype]
enum DataKey {
    Admin,
    Treasury,
    NextStrategyId,
    Strategy(u64),
    TokenBalance(Address),
    TokenStrategyIds(Address),
    Allocation(u64),
    NextWithdrawalId,
    Withdrawal(u64),
}

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum TreasuryStrategiesError {
    AlreadyInitialized = 1,
    NotAdmin = 2,
    NotTreasury = 3,
    StrategyNotFound = 4,
    NoActiveStrategy = 5,
    AllocationCapExceeded = 6,
    InsufficientAllocation = 7,
    WithdrawalNotFound = 8,
    WithdrawalAlreadyClaimed = 9,
    WithdrawalNotYetClaimable = 10,
    InvalidAmount = 11,
    InvalidBps = 12,
}

#[contract]
pub struct TreasuryStrategiesContract;

#[contractimpl]
impl TreasuryStrategiesContract {
    pub fn initialize(env: Env, admin: Address, treasury: Address) {
        admin.require_auth();
        if env.storage().instance().has(&DataKey::Admin) {
            env.panic_with_error(TreasuryStrategiesError::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Treasury, &treasury);
        env.storage()
            .instance()
            .set(&DataKey::NextStrategyId, &1u64);
        env.storage()
            .instance()
            .set(&DataKey::NextWithdrawalId, &1u64);
    }

    pub fn register_strategy(
        env: Env,
        admin: Address,
        adapter: Address,
        token: Address,
        max_allocation_bps: u32,
        withdrawal_cooldown_ledgers: u32,
    ) -> u64 {
        admin.require_auth();
        Self::require_admin(&env, &admin);
        if max_allocation_bps as i128 > BPS_DENOMINATOR {
            env.panic_with_error(TreasuryStrategiesError::InvalidBps);
        }

        let strategy_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextStrategyId)
            .unwrap_or(1u64);
        env.storage()
            .instance()
            .set(&DataKey::NextStrategyId, &(strategy_id + 1));

        let strategy = Strategy {
            adapter: adapter.clone(),
            token: token.clone(),
            max_allocation_bps,
            withdrawal_cooldown_ledgers,
            active: true,
        };
        let strategy_key = DataKey::Strategy(strategy_id);
        env.storage().persistent().set(&strategy_key, &strategy);
        env.storage()
            .persistent()
            .extend_ttl(&strategy_key, TTL_LEDGERS, TTL_LEDGERS);

        let ids_key = DataKey::TokenStrategyIds(token.clone());
        let mut ids: Vec<u64> = env
            .storage()
            .persistent()
            .get(&ids_key)
            .unwrap_or(Vec::new(&env));
        ids.push_back(strategy_id);
        env.storage().persistent().set(&ids_key, &ids);
        env.storage()
            .persistent()
            .extend_ttl(&ids_key, TTL_LEDGERS, TTL_LEDGERS);

        emit_strategy_registered(&env, strategy_id, &adapter, &token);
        strategy_id
    }

    pub fn deactivate_strategy(env: Env, admin: Address, strategy_id: u64) {
        admin.require_auth();
        Self::require_admin(&env, &admin);

        let strategy_key = DataKey::Strategy(strategy_id);
        let mut strategy: Strategy = env
            .storage()
            .persistent()
            .get(&strategy_key)
            .unwrap_or_else(|| env.panic_with_error(TreasuryStrategiesError::StrategyNotFound));
        strategy.active = false;
        env.storage().persistent().set(&strategy_key, &strategy);
        env.storage()
            .persistent()
            .extend_ttl(&strategy_key, TTL_LEDGERS, TTL_LEDGERS);

        emit_strategy_deactivated(&env, strategy_id);
    }

    pub fn deposit(env: Env, caller: Address, token: Address, amount: i128) {
        caller.require_auth();
        Self::require_treasury(&env, &caller);
        if amount <= 0 {
            env.panic_with_error(TreasuryStrategiesError::InvalidAmount);
        }

        let token_client = token::TokenClient::new(&env, &token);
        token_client.transfer(&caller, &env.current_contract_address(), &amount);

        let (strategy_id, strategy, mut allocation) = Self::least_allocated_active_strategy(
            &env,
            &token,
        )
        .unwrap_or_else(|| env.panic_with_error(TreasuryStrategiesError::NoActiveStrategy));

        let balance_key = DataKey::TokenBalance(token.clone());
        let total_before: i128 = env.storage().persistent().get(&balance_key).unwrap_or(0);
        let total_after = total_before + amount;
        let cap = (strategy.max_allocation_bps as i128 * total_after) / BPS_DENOMINATOR;
        let new_alloc_amount = allocation.amount + amount;
        if new_alloc_amount > cap {
            env.panic_with_error(TreasuryStrategiesError::AllocationCapExceeded);
        }

        // Effects before interactions: Allocation/TokenBalance are updated
        // here, before the adapter transfer/call below, so a reentrant read
        // (e.g. get_total_value) during adapter_deposit sees final totals
        // rather than a stale pre-deposit snapshot.
        allocation.amount = new_alloc_amount;
        allocation.deposited_ledger = env.ledger().sequence();
        let allocation_key = DataKey::Allocation(strategy_id);
        env.storage().persistent().set(&allocation_key, &allocation);
        env.storage()
            .persistent()
            .extend_ttl(&allocation_key, TTL_LEDGERS, TTL_LEDGERS);

        env.storage().persistent().set(&balance_key, &total_after);
        env.storage()
            .persistent()
            .extend_ttl(&balance_key, TTL_LEDGERS, TTL_LEDGERS);

        token_client.transfer(&env.current_contract_address(), &strategy.adapter, &amount);
        StrategyAdapterClient::new(&env, &strategy.adapter).adapter_deposit(
            &env.current_contract_address(),
            &token,
            &amount,
        );

        emit_deposited(&env, strategy_id, amount);
    }

    pub fn request_withdrawal(
        env: Env,
        caller: Address,
        strategy_id: u64,
        amount: i128,
    ) -> u64 {
        caller.require_auth();
        Self::require_treasury(&env, &caller);
        if amount <= 0 {
            env.panic_with_error(TreasuryStrategiesError::InvalidAmount);
        }

        let strategy: Strategy = env
            .storage()
            .persistent()
            .get(&DataKey::Strategy(strategy_id))
            .unwrap_or_else(|| env.panic_with_error(TreasuryStrategiesError::StrategyNotFound));

        let allocation_key = DataKey::Allocation(strategy_id);
        let mut allocation: Allocation = env
            .storage()
            .persistent()
            .get(&allocation_key)
            .unwrap_or(Allocation {
                strategy_id,
                amount: 0,
                deposited_ledger: 0,
            });
        if amount > allocation.amount {
            env.panic_with_error(TreasuryStrategiesError::InsufficientAllocation);
        }
        allocation.amount -= amount;
        env.storage().persistent().set(&allocation_key, &allocation);
        env.storage()
            .persistent()
            .extend_ttl(&allocation_key, TTL_LEDGERS, TTL_LEDGERS);

        let withdrawal_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextWithdrawalId)
            .unwrap_or(1u64);
        env.storage()
            .instance()
            .set(&DataKey::NextWithdrawalId, &(withdrawal_id + 1));

        let now = env.ledger().sequence();
        let claimable_ledger = now + strategy.withdrawal_cooldown_ledgers;
        let withdrawal = WithdrawalRequest {
            strategy_id,
            amount,
            requested_ledger: now,
            claimable_ledger,
            claimed: false,
        };
        let withdrawal_key = DataKey::Withdrawal(withdrawal_id);
        env.storage().persistent().set(&withdrawal_key, &withdrawal);
        env.storage()
            .persistent()
            .extend_ttl(&withdrawal_key, TTL_LEDGERS, TTL_LEDGERS);

        emit_withdrawal_requested(&env, withdrawal_id, strategy_id, amount, claimable_ledger);
        withdrawal_id
    }

    pub fn claim_withdrawal(env: Env, withdrawal_id: u64) {
        let withdrawal_key = DataKey::Withdrawal(withdrawal_id);
        let mut withdrawal: WithdrawalRequest = env
            .storage()
            .persistent()
            .get(&withdrawal_key)
            .unwrap_or_else(|| env.panic_with_error(TreasuryStrategiesError::WithdrawalNotFound));
        if withdrawal.claimed {
            env.panic_with_error(TreasuryStrategiesError::WithdrawalAlreadyClaimed);
        }
        if env.ledger().sequence() < withdrawal.claimable_ledger {
            env.panic_with_error(TreasuryStrategiesError::WithdrawalNotYetClaimable);
        }

        let strategy: Strategy = env
            .storage()
            .persistent()
            .get(&DataKey::Strategy(withdrawal.strategy_id))
            .unwrap_or_else(|| env.panic_with_error(TreasuryStrategiesError::StrategyNotFound));
        let treasury: Address = env.storage().instance().get(&DataKey::Treasury).unwrap();

        let actual_amount = StrategyAdapterClient::new(&env, &strategy.adapter).adapter_withdraw(
            &env.current_contract_address(),
            &strategy.token,
            &withdrawal.amount,
        );

        token::TokenClient::new(&env, &strategy.token).transfer(
            &env.current_contract_address(),
            &treasury,
            &actual_amount,
        );

        let balance_key = DataKey::TokenBalance(strategy.token.clone());
        let total: i128 = env.storage().persistent().get(&balance_key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&balance_key, &(total - withdrawal.amount));
        env.storage()
            .persistent()
            .extend_ttl(&balance_key, TTL_LEDGERS, TTL_LEDGERS);

        withdrawal.claimed = true;
        env.storage().persistent().set(&withdrawal_key, &withdrawal);
        env.storage()
            .persistent()
            .extend_ttl(&withdrawal_key, TTL_LEDGERS, TTL_LEDGERS);

        emit_withdrawal_claimed(&env, withdrawal_id, actual_amount);
    }

    pub fn get_strategy(env: Env, strategy_id: u64) -> Strategy {
        env.storage()
            .persistent()
            .get(&DataKey::Strategy(strategy_id))
            .unwrap_or_else(|| env.panic_with_error(TreasuryStrategiesError::StrategyNotFound))
    }

    pub fn get_allocation(env: Env, strategy_id: u64) -> Allocation {
        env.storage()
            .persistent()
            .get(&DataKey::Allocation(strategy_id))
            .unwrap_or(Allocation {
                strategy_id,
                amount: 0,
                deposited_ledger: 0,
            })
    }

    /// Read-only lookup of the configured treasury address, mirroring
    /// `TokenVotes::admin`/`Liquidity::governor` — lets deploy tooling
    /// confirm the contract is both deployed and initialized without
    /// mutating state.
    pub fn get_treasury(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Treasury).unwrap()
    }

    pub fn get_total_value(env: Env, token: Address) -> i128 {
        let ids: Vec<u64> = env
            .storage()
            .persistent()
            .get(&DataKey::TokenStrategyIds(token.clone()))
            .unwrap_or(Vec::new(&env));

        let mut total: i128 = 0;
        for strategy_id in ids.iter() {
            if let Some(strategy) = env
                .storage()
                .persistent()
                .get::<DataKey, Strategy>(&DataKey::Strategy(strategy_id))
            {
                if strategy.active {
                    total +=
                        StrategyAdapterClient::new(&env, &strategy.adapter).adapter_balance(&token);
                }
            }
        }
        total
    }

    fn least_allocated_active_strategy(
        env: &Env,
        token: &Address,
    ) -> Option<(u64, Strategy, Allocation)> {
        let ids: Vec<u64> = env
            .storage()
            .persistent()
            .get(&DataKey::TokenStrategyIds(token.clone()))
            .unwrap_or(Vec::new(env));

        let mut best: Option<(u64, Strategy, Allocation)> = None;
        for strategy_id in ids.iter() {
            let strategy: Strategy = match env
                .storage()
                .persistent()
                .get(&DataKey::Strategy(strategy_id))
            {
                Some(s) => s,
                None => continue,
            };
            if !strategy.active {
                continue;
            }
            let allocation: Allocation = env
                .storage()
                .persistent()
                .get(&DataKey::Allocation(strategy_id))
                .unwrap_or(Allocation {
                    strategy_id,
                    amount: 0,
                    deposited_ledger: 0,
                });

            let is_better = match &best {
                None => true,
                Some((_, _, best_allocation)) => allocation.amount < best_allocation.amount,
            };
            if is_better {
                best = Some((strategy_id, strategy, allocation));
            }
        }
        best
    }

    fn require_admin(env: &Env, caller: &Address) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if caller != &admin {
            env.panic_with_error(TreasuryStrategiesError::NotAdmin);
        }
    }

    fn require_treasury(env: &Env, caller: &Address) {
        let treasury: Address = env.storage().instance().get(&DataKey::Treasury).unwrap();
        if caller != &treasury {
            env.panic_with_error(TreasuryStrategiesError::NotTreasury);
        }
    }
}

#[cfg(test)]
mod tests;
