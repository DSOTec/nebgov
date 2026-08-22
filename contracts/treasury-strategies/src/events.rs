use soroban_sdk::{contracttype, Address, Env, Symbol};

pub const STRATEGY_REGISTERED_TOPIC: &str = "StratReg";
pub const STRATEGY_DEACTIVATED_TOPIC: &str = "StratDeact";
pub const DEPOSITED_TOPIC: &str = "Deposited";
pub const WITHDRAWAL_REQUESTED_TOPIC: &str = "WdrawReq";
pub const WITHDRAWAL_CLAIMED_TOPIC: &str = "WdrawClaim";

#[derive(Clone)]
#[contracttype]
pub struct StrategyRegisteredEvent {
    pub strategy_id: u64,
    pub adapter: Address,
    pub token: Address,
}

#[derive(Clone)]
#[contracttype]
pub struct StrategyDeactivatedEvent {
    pub strategy_id: u64,
}

#[derive(Clone)]
#[contracttype]
pub struct DepositedEvent {
    pub strategy_id: u64,
    pub amount: i128,
}

#[derive(Clone)]
#[contracttype]
pub struct WithdrawalRequestedEvent {
    pub withdrawal_id: u64,
    pub strategy_id: u64,
    pub amount: i128,
    pub claimable_ledger: u32,
}

#[derive(Clone)]
#[contracttype]
pub struct WithdrawalClaimedEvent {
    pub withdrawal_id: u64,
    pub actual_amount: i128,
}

pub fn emit_strategy_registered(env: &Env, strategy_id: u64, adapter: &Address, token: &Address) {
    env.events().publish(
        (Symbol::new(env, STRATEGY_REGISTERED_TOPIC), strategy_id),
        StrategyRegisteredEvent {
            strategy_id,
            adapter: adapter.clone(),
            token: token.clone(),
        },
    );
}

pub fn emit_strategy_deactivated(env: &Env, strategy_id: u64) {
    env.events().publish(
        (Symbol::new(env, STRATEGY_DEACTIVATED_TOPIC), strategy_id),
        StrategyDeactivatedEvent { strategy_id },
    );
}

pub fn emit_deposited(env: &Env, strategy_id: u64, amount: i128) {
    env.events().publish(
        (Symbol::new(env, DEPOSITED_TOPIC), strategy_id),
        DepositedEvent {
            strategy_id,
            amount,
        },
    );
}

pub fn emit_withdrawal_requested(
    env: &Env,
    withdrawal_id: u64,
    strategy_id: u64,
    amount: i128,
    claimable_ledger: u32,
) {
    env.events().publish(
        (Symbol::new(env, WITHDRAWAL_REQUESTED_TOPIC), withdrawal_id),
        WithdrawalRequestedEvent {
            withdrawal_id,
            strategy_id,
            amount,
            claimable_ledger,
        },
    );
}

pub fn emit_withdrawal_claimed(env: &Env, withdrawal_id: u64, actual_amount: i128) {
    env.events().publish(
        (Symbol::new(env, WITHDRAWAL_CLAIMED_TOPIC), withdrawal_id),
        WithdrawalClaimedEvent {
            withdrawal_id,
            actual_amount,
        },
    );
}
