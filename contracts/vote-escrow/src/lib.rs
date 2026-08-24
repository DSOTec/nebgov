#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, token, Address, Env, Vec};

mod error;
mod events;

pub use error::VoteEscrowError;
pub use events::*;

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Lock {
    pub owner: Address,
    pub amount: i128,
    pub start_ledger: u32,
    pub end_ledger: u32,
    pub initial_voting_power: i128,
    pub withdrawn: bool,
}

#[contracttype]
pub enum DataKey {
    Admin,
    LockedToken,
    MinLockDuration,
    MaxLockDuration,
    MaxMultiplierBps,
    Lock(Address),
    LockHistory(Address),
    TotalLocked,
    GlobalCheckpoints,
}

#[contract]
pub struct VoteEscrowContract;

#[contractimpl]
impl VoteEscrowContract {
    pub fn initialize(
        env: Env,
        admin: Address,
        locked_token: Address,
        min_lock_duration: u32,
        max_lock_duration: u32,
        max_multiplier_bps: u32,
    ) {
        admin.require_auth();

        if env.storage().instance().has(&DataKey::Admin) {
            env.panic_with_error(VoteEscrowError::NotInitialized);
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::LockedToken, &locked_token);
        env.storage()
            .instance()
            .set(&DataKey::MinLockDuration, &min_lock_duration);
        env.storage()
            .instance()
            .set(&DataKey::MaxLockDuration, &max_lock_duration);
        env.storage()
            .instance()
            .set(&DataKey::MaxMultiplierBps, &max_multiplier_bps);
        env.storage()
            .instance()
            .set(&DataKey::TotalLocked, &0i128);

        let checkpoints: Vec<(u32, i128)> = Vec::new(&env);
        env.storage()
            .instance()
            .set(&DataKey::GlobalCheckpoints, &checkpoints);
    }

    pub fn create_lock(env: Env, owner: Address, amount: i128, duration_ledgers: u32) -> Lock {
        owner.require_auth();

        let min_duration: u32 = env
            .storage()
            .instance()
            .get(&DataKey::MinLockDuration)
            .ok_or(VoteEscrowError::NotInitialized)
            .unwrap();
        let max_duration: u32 = env
            .storage()
            .instance()
            .get(&DataKey::MaxLockDuration)
            .ok_or(VoteEscrowError::NotInitialized)
            .unwrap();

        if duration_ledgers < min_duration || duration_ledgers > max_duration {
            env.panic_with_error(VoteEscrowError::InvalidDuration);
        }

        if amount <= 0 {
            env.panic_with_error(VoteEscrowError::InvalidAmount);
        }

        if env
            .storage()
            .persistent()
            .has(&DataKey::Lock(owner.clone()))
        {
            let existing_lock: Lock = env
                .storage()
                .persistent()
                .get(&DataKey::Lock(owner.clone()))
                .unwrap();
            if !existing_lock.withdrawn {
                env.panic_with_error(VoteEscrowError::LockNotFound);
            }
        }

        let locked_token: Address = env
            .storage()
            .instance()
            .get(&DataKey::LockedToken)
            .ok_or(VoteEscrowError::NotInitialized)
            .unwrap();

        token::Client::new(&env, &locked_token).transfer(&owner, &env.current_contract_address(), &amount);

        let current_ledger = env.ledger().sequence();
        let end_ledger = current_ledger.checked_add(duration_ledgers)
            .ok_or(VoteEscrowError::ArithmeticOverflow)
            .unwrap();

        let max_multiplier_bps: u32 = env
            .storage()
            .instance()
            .get(&DataKey::MaxMultiplierBps)
            .ok_or(VoteEscrowError::NotInitialized)
            .unwrap();

        let initial_voting_power =
            Self::compute_initial_voting_power(&env, amount, duration_ledgers, min_duration, max_duration, max_multiplier_bps);

        let lock = Lock {
            owner: owner.clone(),
            amount,
            start_ledger: current_ledger,
            end_ledger,
            initial_voting_power,
            withdrawn: false,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Lock(owner.clone()), &lock);

        let current_total: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalLocked)
            .unwrap_or(0);
        let new_total = current_total.checked_add(amount)
            .ok_or(VoteEscrowError::ArithmeticOverflow)
            .unwrap();
        env.storage()
            .instance()
            .set(&DataKey::TotalLocked, &new_total);

        Self::update_global_checkpoint(&env, current_ledger);

        emit_lock_created(&env, &owner, amount, end_ledger, initial_voting_power);

        lock
    }

    pub fn increase_lock_amount(env: Env, owner: Address, additional_amount: i128) -> Lock {
        owner.require_auth();

        if additional_amount <= 0 {
            env.panic_with_error(VoteEscrowError::InvalidAmount);
        }

        let mut lock: Lock = env
            .storage()
            .persistent()
            .get(&DataKey::Lock(owner.clone()))
            .ok_or(VoteEscrowError::LockNotFound)
            .unwrap();

        if lock.withdrawn {
            env.panic_with_error(VoteEscrowError::LockAlreadyWithdrawn);
        }

        let locked_token: Address = env
            .storage()
            .instance()
            .get(&DataKey::LockedToken)
            .ok_or(VoteEscrowError::NotInitialized)
            .unwrap();

        token::Client::new(&env, &locked_token).transfer(&owner, &env.current_contract_address(), &additional_amount);

        let new_amount = lock.amount.checked_add(additional_amount)
            .ok_or(VoteEscrowError::ArithmeticOverflow)
            .unwrap();

        let min_duration: u32 = env
            .storage()
            .instance()
            .get(&DataKey::MinLockDuration)
            .ok_or(VoteEscrowError::NotInitialized)
            .unwrap();
        let max_duration: u32 = env
            .storage()
            .instance()
            .get(&DataKey::MaxLockDuration)
            .ok_or(VoteEscrowError::NotInitialized)
            .unwrap();
        let max_multiplier_bps: u32 = env
            .storage()
            .instance()
            .get(&DataKey::MaxMultiplierBps)
            .ok_or(VoteEscrowError::NotInitialized)
            .unwrap();

        let remaining_duration = lock.end_ledger.saturating_sub(lock.start_ledger);
        let new_initial_voting_power =
            Self::compute_initial_voting_power(&env, new_amount, remaining_duration, min_duration, max_duration, max_multiplier_bps);

        lock.amount = new_amount;
        lock.initial_voting_power = new_initial_voting_power;

        env.storage()
            .persistent()
            .set(&DataKey::Lock(owner.clone()), &lock);

        let current_total: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalLocked)
            .unwrap_or(0);
        let new_total = current_total.checked_add(additional_amount)
            .ok_or(VoteEscrowError::ArithmeticOverflow)
            .unwrap();
        env.storage()
            .instance()
            .set(&DataKey::TotalLocked, &new_total);

        let current_ledger = env.ledger().sequence();
        Self::update_global_checkpoint(&env, current_ledger);

        emit_lock_increased(&env, &owner, additional_amount, lock.initial_voting_power);

        lock
    }

    pub fn extend_lock(env: Env, owner: Address, new_end_ledger: u32) -> Lock {
        owner.require_auth();

        let mut lock: Lock = env
            .storage()
            .persistent()
            .get(&DataKey::Lock(owner.clone()))
            .ok_or(VoteEscrowError::LockNotFound)
            .unwrap();

        if lock.withdrawn {
            env.panic_with_error(VoteEscrowError::LockAlreadyWithdrawn);
        }

        if new_end_ledger <= lock.end_ledger {
            env.panic_with_error(VoteEscrowError::InvalidEndLedger);
        }

        let min_duration: u32 = env
            .storage()
            .instance()
            .get(&DataKey::MinLockDuration)
            .ok_or(VoteEscrowError::NotInitialized)
            .unwrap();
        let max_duration: u32 = env
            .storage()
            .instance()
            .get(&DataKey::MaxLockDuration)
            .ok_or(VoteEscrowError::NotInitialized)
            .unwrap();
        let max_multiplier_bps: u32 = env
            .storage()
            .instance()
            .get(&DataKey::MaxMultiplierBps)
            .ok_or(VoteEscrowError::NotInitialized)
            .unwrap();

        let new_duration = new_end_ledger.saturating_sub(lock.start_ledger);

        if new_duration < min_duration || new_duration > max_duration {
            env.panic_with_error(VoteEscrowError::InvalidDuration);
        }

        let old_end_ledger = lock.end_ledger;
        let new_initial_voting_power =
            Self::compute_initial_voting_power(&env, lock.amount, new_duration, min_duration, max_duration, max_multiplier_bps);

        lock.end_ledger = new_end_ledger;
        lock.initial_voting_power = new_initial_voting_power;

        env.storage()
            .persistent()
            .set(&DataKey::Lock(owner.clone()), &lock);

        let current_ledger = env.ledger().sequence();
        Self::update_global_checkpoint(&env, current_ledger);

        emit_lock_extended(&env, &owner, old_end_ledger, new_end_ledger);

        lock
    }

    pub fn withdraw(env: Env, owner: Address) -> i128 {
        owner.require_auth();

        let mut lock: Lock = env
            .storage()
            .persistent()
            .get(&DataKey::Lock(owner.clone()))
            .ok_or(VoteEscrowError::LockNotFound)
            .unwrap();

        let current_ledger = env.ledger().sequence();

        if current_ledger < lock.end_ledger {
            env.panic_with_error(VoteEscrowError::LockNotMatured);
        }

        if lock.withdrawn {
            env.panic_with_error(VoteEscrowError::LockAlreadyWithdrawn);
        }

        let locked_token: Address = env
            .storage()
            .instance()
            .get(&DataKey::LockedToken)
            .ok_or(VoteEscrowError::NotInitialized)
            .unwrap();

        token::Client::new(&env, &locked_token).transfer(
            &env.current_contract_address(),
            &owner,
            &lock.amount,
        );

        lock.withdrawn = true;

        let mut history: Vec<Lock> = env
            .storage()
            .persistent()
            .get(&DataKey::LockHistory(owner.clone()))
            .unwrap_or_else(|| Vec::new(&env));
        history.push_back(lock.clone());
        env.storage()
            .persistent()
            .set(&DataKey::LockHistory(owner.clone()), &history);

        env.storage()
            .persistent()
            .remove(&DataKey::Lock(owner.clone()));

        let current_total: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalLocked)
            .unwrap_or(0);
        let new_total = current_total.saturating_sub(lock.amount);
        env.storage()
            .instance()
            .set(&DataKey::TotalLocked, &new_total);

        Self::update_global_checkpoint(&env, current_ledger);

        emit_lock_withdrawn(&env, &owner, lock.amount);

        lock.amount
    }

    pub fn get_votes(env: Env, account: Address) -> i128 {
        let lock_opt: Option<Lock> = env
            .storage()
            .persistent()
            .get(&DataKey::Lock(account));

        match lock_opt {
            Some(lock) => {
                if lock.withdrawn {
                    return 0;
                }
                let current_ledger = env.ledger().sequence();
                Self::compute_decayed_power(&lock, current_ledger)
            }
            None => 0,
        }
    }

    pub fn get_past_votes(env: Env, account: Address, ledger: u32) -> i128 {
        let lock_opt: Option<Lock> = env
            .storage()
            .persistent()
            .get(&DataKey::Lock(account.clone()));

        if let Some(lock) = lock_opt {
            if !lock.withdrawn && ledger >= lock.start_ledger && ledger < lock.end_ledger {
                return Self::compute_decayed_power(&lock, ledger);
            }
            if ledger >= lock.start_ledger && ledger < lock.end_ledger {
                return Self::compute_decayed_power(&lock, ledger);
            }
        }

        let history_opt: Option<Vec<Lock>> = env
            .storage()
            .persistent()
            .get(&DataKey::LockHistory(account));

        if let Some(history) = history_opt {
            for historical_lock in history.iter() {
                if ledger >= historical_lock.start_ledger && ledger < historical_lock.end_ledger {
                    return Self::compute_decayed_power(&historical_lock, ledger);
                }
            }
        }

        0
    }

    pub fn get_past_total_supply(env: Env, ledger: u32) -> i128 {
        let checkpoints_opt: Option<Vec<(u32, i128)>> = env
            .storage()
            .instance()
            .get(&DataKey::GlobalCheckpoints);

        if let Some(checkpoints) = checkpoints_opt {
            for i in (0..checkpoints.len()).rev() {
                let (cp_ledger, cp_total) = checkpoints.get(i).unwrap();
                if cp_ledger <= ledger {
                    return cp_total;
                }
            }
        }

        0
    }

    pub fn token(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::LockedToken)
            .ok_or(VoteEscrowError::NotInitialized)
            .unwrap()
    }

    pub fn get_lock(env: Env, owner: Address) -> Option<Lock> {
        env.storage()
            .persistent()
            .get(&DataKey::Lock(owner))
    }

    pub fn get_lock_history(env: Env, owner: Address, offset: u32, limit: u32) -> Vec<Lock> {
        let history_opt: Option<Vec<Lock>> = env
            .storage()
            .persistent()
            .get(&DataKey::LockHistory(owner));

        if let Some(history) = history_opt {
            let start = offset;
            let end = offset.saturating_add(limit);
            let history_len = history.len();

            if start >= history_len {
                return Vec::new(&env);
            }

            let actual_end = end.min(history_len);
            let mut result = Vec::new(&env);
            for i in start..actual_end {
                result.push_back(history.get(i).unwrap());
            }
            result
        } else {
            Vec::new(&env)
        }
    }

    pub fn update_escrow_config(
        env: Env,
        admin: Address,
        min_lock_duration: u32,
        max_lock_duration: u32,
        max_multiplier_bps: u32,
    ) {
        admin.require_auth();

        env.storage()
            .instance()
            .set(&DataKey::MinLockDuration, &min_lock_duration);
        env.storage()
            .instance()
            .set(&DataKey::MaxLockDuration, &max_lock_duration);
        env.storage()
            .instance()
            .set(&DataKey::MaxMultiplierBps, &max_multiplier_bps);
    }

    fn compute_initial_voting_power(
        _env: &Env,
        amount: i128,
        duration_ledgers: u32,
        min_duration: u32,
        max_duration: u32,
        max_multiplier_bps: u32,
    ) -> i128 {
        if duration_ledgers <= min_duration {
            return amount;
        }

        let duration_range = max_duration.saturating_sub(min_duration) as i128;
        if duration_range == 0 {
            return amount
                .checked_add(
                    amount
                        .checked_mul(max_multiplier_bps as i128)
                        .unwrap_or(0)
                        .checked_div(10000)
                        .unwrap_or(0),
                )
                .unwrap_or(0);
        }

        let applicable_duration = (duration_ledgers.saturating_sub(min_duration)) as i128;
        let applicable_bps =
            (applicable_duration.checked_mul(max_multiplier_bps as i128).unwrap_or(0))
                .checked_div(duration_range)
                .unwrap_or(0);

        let boost = amount
            .checked_mul(applicable_bps)
            .ok_or(VoteEscrowError::ArithmeticOverflow)
            .unwrap()
            .checked_div(10000)
            .unwrap_or(0);

        amount
            .checked_add(boost)
            .ok_or(VoteEscrowError::ArithmeticOverflow)
            .unwrap()
    }

    fn compute_decayed_power(lock: &Lock, current_ledger: u32) -> i128 {
        if current_ledger >= lock.end_ledger {
            return lock.amount;
        }

        if current_ledger < lock.start_ledger {
            return 0;
        }

        let duration = lock.end_ledger.saturating_sub(lock.start_ledger) as i128;
        if duration == 0 {
            return lock.amount;
        }

        let remaining = (lock.end_ledger.saturating_sub(current_ledger)) as i128;

        let boost = lock.initial_voting_power.saturating_sub(lock.amount);
        let decayed_boost = boost
            .checked_mul(remaining)
            .ok_or(VoteEscrowError::ArithmeticOverflow)
            .unwrap()
            .checked_div(duration)
            .unwrap_or(0);

        lock.amount
            .checked_add(decayed_boost)
            .unwrap_or(lock.amount)
    }

    fn update_global_checkpoint(env: &Env, ledger: u32) {
        let mut checkpoints: Vec<(u32, i128)> = env
            .storage()
            .instance()
            .get(&DataKey::GlobalCheckpoints)
            .unwrap_or_else(|| Vec::new(env));

        let total_locked: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalLocked)
            .unwrap_or(0);

        checkpoints.push_back((ledger, total_locked));

        env.storage()
            .instance()
            .set(&DataKey::GlobalCheckpoints, &checkpoints);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::Address as _,
        Env,
    };

    #[test]
    fn test_initialize() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let token = Address::generate(&env);
        let contract_id = env.register(VoteEscrowContract, ());

        env.as_contract(&contract_id, || {
            VoteEscrowContract::initialize(
                env.clone(),
                admin.clone(),
                token.clone(),
                100,
                1000,
                25000,
            );

            let stored_token: Address = env
                .storage()
                .instance()
                .get(&DataKey::LockedToken)
                .unwrap();
            assert_eq!(stored_token, token);
        });
    }

    #[test]
    fn test_compute_initial_voting_power_min_duration() {
        let env = Env::default();
        let power = VoteEscrowContract::compute_initial_voting_power(&env, 100, 100, 100, 1000, 25000);
        assert_eq!(power, 100);
    }

    #[test]
    fn test_compute_initial_voting_power_max_duration() {
        let env = Env::default();
        let power = VoteEscrowContract::compute_initial_voting_power(&env, 100, 1000, 100, 1000, 25000);
        assert_eq!(power, 350);
    }

    #[test]
    fn test_compute_initial_voting_power_mid_duration() {
        let env = Env::default();
        let power = VoteEscrowContract::compute_initial_voting_power(&env, 100, 550, 100, 1000, 25000);
        assert!(power > 100 && power < 350);
    }

    #[test]
    fn test_compute_decayed_power_at_start() {
        let lock = Lock {
            owner: Address::generate(&Env::default()),
            amount: 100,
            start_ledger: 100,
            end_ledger: 200,
            initial_voting_power: 125,
            withdrawn: false,
        };
        let power = VoteEscrowContract::compute_decayed_power(&lock, 100);
        assert_eq!(power, 125);
    }

    #[test]
    fn test_compute_decayed_power_at_end() {
        let lock = Lock {
            owner: Address::generate(&Env::default()),
            amount: 100,
            start_ledger: 100,
            end_ledger: 200,
            initial_voting_power: 125,
            withdrawn: false,
        };
        let power = VoteEscrowContract::compute_decayed_power(&lock, 200);
        assert_eq!(power, 100);
    }

    #[test]
    fn test_compute_decayed_power_at_mid() {
        let lock = Lock {
            owner: Address::generate(&Env::default()),
            amount: 100,
            start_ledger: 100,
            end_ledger: 200,
            initial_voting_power: 125,
            withdrawn: false,
        };
        let power = VoteEscrowContract::compute_decayed_power(&lock, 150);
        assert!(power > 100 && power < 125);
        assert_eq!(power, 112);
    }

    #[test]
    fn test_compute_decayed_power_before_start() {
        let lock = Lock {
            owner: Address::generate(&Env::default()),
            amount: 100,
            start_ledger: 100,
            end_ledger: 200,
            initial_voting_power: 125,
            withdrawn: false,
        };
        let power = VoteEscrowContract::compute_decayed_power(&lock, 99);
        assert_eq!(power, 0);
    }
}
