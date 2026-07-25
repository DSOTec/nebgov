use soroban_sdk::{Address, Env, Symbol};

pub const LIQUIDITY_ADDED_TOPIC: &str = "LiquidityAdded";
pub const LIQUIDITY_REMOVED_TOPIC: &str = "LiquidityRemoved";
pub const SWAP_TOPIC: &str = "Swap";
pub const POOL_FEE_UPDATED_TOPIC: &str = "PoolFeeUpdated";

#[derive(Clone)]
#[soroban_sdk::contracttype]
pub struct LiquidityAddedEvent {
    pub provider: Address,
    pub outcome_a: u32,
    pub outcome_b: u32,
    pub amount_a: i128,
    pub amount_b: i128,
    pub lp_tokens_minted: i128,
}

#[derive(Clone)]
#[soroban_sdk::contracttype]
pub struct LiquidityRemovedEvent {
    pub provider: Address,
    pub outcome_a: u32,
    pub outcome_b: u32,
    pub amount_a: i128,
    pub amount_b: i128,
    pub lp_tokens_burned: i128,
}

#[derive(Clone)]
#[soroban_sdk::contracttype]
pub struct SwapEvent {
    pub trader: Address,
    pub outcome_in: u32,
    pub outcome_out: u32,
    pub amount_in: i128,
    pub amount_out: i128,
    pub fee: i128,
}

#[derive(Clone)]
#[soroban_sdk::contracttype]
pub struct PoolFeeUpdatedEvent {
    pub outcome_a: u32,
    pub outcome_b: u32,
    pub old_fee_bps: u32,
    pub new_fee_bps: u32,
}

pub fn emit_liquidity_added(
    env: &Env,
    provider: &Address,
    outcome_a: u32,
    outcome_b: u32,
    amount_a: i128,
    amount_b: i128,
    lp_tokens_minted: i128,
) {
    env.events().publish(
        (Symbol::new(env, LIQUIDITY_ADDED_TOPIC), provider.clone()),
        LiquidityAddedEvent {
            provider: provider.clone(),
            outcome_a,
            outcome_b,
            amount_a,
            amount_b,
            lp_tokens_minted,
        },
    );
}

pub fn emit_liquidity_removed(
    env: &Env,
    provider: &Address,
    outcome_a: u32,
    outcome_b: u32,
    amount_a: i128,
    amount_b: i128,
    lp_tokens_burned: i128,
) {
    env.events().publish(
        (Symbol::new(env, LIQUIDITY_REMOVED_TOPIC), provider.clone()),
        LiquidityRemovedEvent {
            provider: provider.clone(),
            outcome_a,
            outcome_b,
            amount_a,
            amount_b,
            lp_tokens_burned,
        },
    );
}

pub fn emit_swap(
    env: &Env,
    trader: &Address,
    outcome_in: u32,
    outcome_out: u32,
    amount_in: i128,
    amount_out: i128,
    fee: i128,
) {
    env.events().publish(
        (Symbol::new(env, SWAP_TOPIC), trader.clone()),
        SwapEvent {
            trader: trader.clone(),
            outcome_in,
            outcome_out,
            amount_in,
            amount_out,
            fee,
        },
    );
}

pub fn emit_pool_fee_updated(
    env: &Env,
    outcome_a: u32,
    outcome_b: u32,
    old_fee_bps: u32,
    new_fee_bps: u32,
) {
    env.events().publish(
        (Symbol::new(env, POOL_FEE_UPDATED_TOPIC),),
        PoolFeeUpdatedEvent {
            outcome_a,
            outcome_b,
            old_fee_bps,
            new_fee_bps,
        },
    );
}
