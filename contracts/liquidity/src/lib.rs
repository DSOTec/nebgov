#![no_std]

//! Protocol-owned liquidity management for NebGov markets.
//!
//! This contract maintains simple two-asset pools used to support market
//! liquidity around governance-controlled prediction or outcome tokens. End
//! users can add liquidity, remove liquidity, and swap against a pool using a
//! constant-product pricing curve with configurable fees.
//!
//! The contract integrates with NebGov governance through a stored governor
//! address. Day-to-day user actions are self-authorized by the caller, while
//! privileged configuration changes such as fee updates are restricted to the
//! governor and are intended to be executed through the governor -> timelock ->
//! liquidity proposal flow.
//!
//! Access control model:
//! - liquidity providers must authorize `add_liquidity` and `remove_liquidity`
//! - traders must authorize `swap`
//! - only the configured governor may call `update_pool_fee`

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env,
};

const MIN_LIQUIDITY: i128 = 1_000;
const DEFAULT_FEE_BPS: u32 = 30;
const MAX_FEE_BPS: u32 = 1_000;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Pool {
    pub reserve_a: i128,
    pub reserve_b: i128,
    pub total_lp_supply: i128,
    pub fee_bps: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LPPosition {
    pub lp_tokens: i128,
}

#[contracttype]
enum DataKey {
    Governor,
    Pool(u32, u32),
    Position(Address, u32, u32),
    /// SEP-41 token backing a given outcome id.
    OutcomeToken(u32),
}

/// Liquidity contract error codes.
#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LiquidityError {
    /// Amount must be positive (not zero or negative).
    InvalidAmount = 1,
    /// Caller does not have sufficient LP shares for this operation.
    InsufficientShares = 2,
    /// Swap output is below the caller's minimum acceptable amount.
    SlippageExceeded = 3,
    /// Zero amount provided for liquidity operation.
    ZeroAmount = 4,
}

#[contract]
pub struct LiquidityContract;

#[contractimpl]
impl LiquidityContract {
    /// Initialize the contract with the governor that owns privileged actions.
    pub fn initialize(env: Env, governor: Address) {
        governor.require_auth();
        assert!(
            !env.storage().instance().has(&DataKey::Governor),
            "already initialized"
        );
        env.storage().instance().set(&DataKey::Governor, &governor);
    }

    /// Return the configured governor address.
    pub fn governor(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Governor)
            .expect("not initialized")
    }

    /// Register the SEP-41 token backing an outcome. Only the governor may call
    /// this. Once both outcomes of a pool have a registered token, liquidity and
    /// swap operations move real tokens instead of tracking phantom balances.
    pub fn set_outcome_token(env: Env, caller: Address, outcome: u32, token: Address) {
        caller.require_auth();
        Self::require_governor(&env, &caller);
        env.storage()
            .persistent()
            .set(&DataKey::OutcomeToken(outcome), &token);
    }

    /// Return the SEP-41 token registered for an outcome, if any.
    pub fn get_outcome_token(env: Env, outcome: u32) -> Option<Address> {
        env.storage()
            .persistent()
            .get(&DataKey::OutcomeToken(outcome))
    }

    /// Add liquidity to a pool and mint LP shares.
    pub fn add_liquidity(
        env: Env,
        provider: Address,
        outcome_a: u32,
        outcome_b: u32,
        amount_a: i128,
        amount_b: i128,
    ) -> i128 {
        provider.require_auth();

        // Security: reject zero amounts to prevent zero-reserve pool creation (#444).
        // A zero-reserve pool would cause divide-by-zero panics in swap() when
        // computing the AMM ratio, enabling DoS attacks.
        if amount_a <= 0 || amount_b <= 0 {
            env.panic_with_error(LiquidityError::ZeroAmount);
        }

        if amount_a < MIN_LIQUIDITY || amount_b < MIN_LIQUIDITY {
            env.panic_with_error(LiquidityError::InvalidAmount);
        }

        let (na, nb, swapped) = Self::normalize_outcomes(outcome_a, outcome_b);
        let mut pool = Self::get_pool_or_default(&env, na, nb);
        // Map incoming amounts to normalized order
        let (deposit_a, deposit_b) = if !swapped {
            (amount_a, amount_b)
        } else {
            (amount_b, amount_a)
        };

        // Pull the real tokens into the pool before minting LP shares, so the
        // recorded reserves are always backed by actual on-chain balances.
        if let (Some(token_a), Some(token_b)) = (
            Self::outcome_token(&env, outcome_a),
            Self::outcome_token(&env, outcome_b),
        ) {
            let contract = env.current_contract_address();
            token::TokenClient::new(&env, &token_a).transfer(&provider, &contract, &amount_a);
            token::TokenClient::new(&env, &token_b).transfer(&provider, &contract, &amount_b);
        }

        let lp_tokens = if pool.total_lp_supply == 0 {
            deposit_a
        } else {
            (deposit_a * pool.total_lp_supply) / pool.reserve_a
        };

        pool.reserve_a += deposit_a;
        pool.reserve_b += deposit_b;
        pool.total_lp_supply += lp_tokens;
        env.storage()
            .persistent()
            .set(&DataKey::Pool(na, nb), &pool);

        let position_key = Self::position_key(provider.clone(), na, nb);
        let mut position: LPPosition = env
            .storage()
            .persistent()
            .get(&position_key)
            .unwrap_or(LPPosition { lp_tokens: 0 });
        position.lp_tokens += lp_tokens;
        env.storage().persistent().set(&position_key, &position);

        if pool.total_lp_supply == 0 {
            env.events().publish(
                (soroban_sdk::Symbol::new(&env, "PoolCreated"), na, nb),
                (provider.clone(), deposit_a, deposit_b, lp_tokens),
            );
        }

        env.events().publish(
            (soroban_sdk::Symbol::new(&env, "LiquidityAdded"), na, nb),
            (provider.clone(), deposit_a, deposit_b, lp_tokens),
        );

        lp_tokens
    }

    /// Remove liquidity from a pool and burn LP shares.
    pub fn remove_liquidity(
        env: Env,
        provider: Address,
        outcome_a: u32,
        outcome_b: u32,
        lp_tokens: i128,
    ) -> (i128, i128) {
        provider.require_auth();

        // Security: validate caller inputs before any state mutation or token transfer.
        // A failed check here leaves contract state unchanged.
        if lp_tokens <= 0 {
            panic!("invalid amount");
        }

        let provider_shares =
            Self::get_lp_position(env.clone(), provider.clone(), outcome_a, outcome_b);
        if lp_tokens > provider_shares {
            panic!("insufficient shares");
        }

        let (na, nb, swapped) = Self::normalize_outcomes(outcome_a, outcome_b);
        let mut pool: Pool = env
            .storage()
            .persistent()
            .get(&DataKey::Pool(na, nb))
            .expect("pool not found");

        let position_key = Self::position_key(provider.clone(), na, nb);
        let mut position: LPPosition = env
            .storage()
            .persistent()
            .get(&position_key)
            .expect("no LP position");

        let amount_a_norm = (lp_tokens * pool.reserve_a) / pool.total_lp_supply;
        let amount_b_norm = (lp_tokens * pool.reserve_b) / pool.total_lp_supply;

        pool.reserve_a -= amount_a_norm;
        pool.reserve_b -= amount_b_norm;
        pool.total_lp_supply -= lp_tokens;
        position.lp_tokens -= lp_tokens;

        env.storage()
            .persistent()
            .set(&DataKey::Pool(na, nb), &pool);
        env.storage().persistent().set(&position_key, &position);

        // Amounts mapped back to the caller's requested outcome order.
        let (out_a, out_b) = if !swapped {
            (amount_a_norm, amount_b_norm)
        } else {
            (amount_b_norm, amount_a_norm)
        };

        env.events().publish(
            (soroban_sdk::Symbol::new(&env, "LiquidityRemoved"), na, nb),
            (provider.clone(), out_a, out_b, lp_tokens),
        );

        // Return the real tokens to the provider after burning their shares.
        if let (Some(token_a), Some(token_b)) = (
            Self::outcome_token(&env, outcome_a),
            Self::outcome_token(&env, outcome_b),
        ) {
            let contract = env.current_contract_address();
            token::TokenClient::new(&env, &token_a).transfer(&contract, &provider, &out_a);
            token::TokenClient::new(&env, &token_b).transfer(&contract, &provider, &out_b);
        }

        (out_a, out_b)
    }

    /// Swap `amount_in` of one pool asset for the other.
    ///
    /// Security: `min_amount_out` provides slippage protection (#443).
    /// Without this parameter, front-running or price manipulation could cause
    /// the trader to receive far less than expected.
    pub fn swap(
        env: Env,
        trader: Address,
        outcome_in: u32,
        outcome_out: u32,
        amount_in: i128,
        min_amount_out: i128,
    ) -> i128 {
        trader.require_auth();

        if amount_in <= 0 {
            panic!("amount_in must be positive");
        }

        if outcome_in == outcome_out {
            panic!("outcome_in and outcome_out must differ");
        }

        let (na, nb, swapped) = Self::normalize_outcomes(outcome_in, outcome_out);
        let mut pool: Pool = env
            .storage()
            .persistent()
            .get(&DataKey::Pool(na, nb))
            .expect("pool not found");

        // Determine direction relative to normalized reserves
        let trading_a_to_b = !swapped;

        let amount_out = if trading_a_to_b {
            (amount_in * pool.reserve_b) / (pool.reserve_a + amount_in)
        } else {
            (amount_in * pool.reserve_a) / (pool.reserve_b + amount_in)
        };
        let fee = (amount_out * pool.fee_bps as i128) / 10_000;
        let amount_out_with_fee = amount_out - fee;

        if amount_out_with_fee < min_amount_out {
            env.panic_with_error(LiquidityError::SlippageExceeded);
        }

        if trading_a_to_b {
            pool.reserve_a += amount_in;
            pool.reserve_b -= amount_out_with_fee;
        } else {
            pool.reserve_b += amount_in;
            pool.reserve_a -= amount_out_with_fee;
        }

        env.events().publish(
            (soroban_sdk::Symbol::new(&env, "Swap"), na, nb),
            (
                trader.clone(),
                amount_in,
                amount_out_with_fee,
                trading_a_to_b,
            ),
        );

        env.storage()
            .persistent()
            .set(&DataKey::Pool(na, nb), &pool);

        // Move the real tokens: pull what the trader sends in, send out what
        // they receive. Uses the caller's outcome ids directly.
        if let (Some(token_in), Some(token_out)) = (
            Self::outcome_token(&env, outcome_in),
            Self::outcome_token(&env, outcome_out),
        ) {
            let contract = env.current_contract_address();
            token::TokenClient::new(&env, &token_in).transfer(&trader, &contract, &amount_in);
            token::TokenClient::new(&env, &token_out).transfer(
                &contract,
                &trader,
                &amount_out_with_fee,
            );
        }

        amount_out_with_fee
    }

    /// Update a pool fee. Only the configured governor may call this.
    pub fn update_pool_fee(
        env: Env,
        caller: Address,
        outcome_a: u32,
        outcome_b: u32,
        fee_bps: u32,
    ) {
        caller.require_auth();
        Self::require_governor(&env, &caller);

        if fee_bps > MAX_FEE_BPS {
            panic!("fee too high");
        }

        let pool_key = Self::pool_key(outcome_a, outcome_b);
        let mut pool: Pool = env
            .storage()
            .persistent()
            .get(&pool_key)
            .expect("pool not found");
        pool.fee_bps = fee_bps;
        env.storage().persistent().set(&pool_key, &pool);
    }

    /// Get the current pool state.
    pub fn get_pool(env: Env, outcome_a: u32, outcome_b: u32) -> Pool {
        let (na, nb, swapped) = Self::normalize_outcomes(outcome_a, outcome_b);
        let pool: Pool = env
            .storage()
            .persistent()
            .get(&DataKey::Pool(na, nb))
            .expect("pool not found");

        if !swapped {
            pool
        } else {
            Pool {
                reserve_a: pool.reserve_b,
                reserve_b: pool.reserve_a,
                total_lp_supply: pool.total_lp_supply,
                fee_bps: pool.fee_bps,
            }
        }
    }

    /// Get the LP token balance for a provider in a specific pool.
    pub fn get_lp_position(env: Env, provider: Address, outcome_a: u32, outcome_b: u32) -> i128 {
        let position: LPPosition = env
            .storage()
            .persistent()
            .get(&Self::position_key(provider, outcome_a, outcome_b))
            .unwrap_or(LPPosition { lp_tokens: 0 });
        position.lp_tokens
    }

    /// Calculate the current pool price as reserve_b / reserve_a scaled by 10_000.
    pub fn get_price(env: Env, outcome_a: u32, outcome_b: u32) -> i128 {
        let pool = Self::get_pool(env, outcome_a, outcome_b);
        if pool.reserve_a == 0 {
            return 0;
        }
        (pool.reserve_b * 10_000) / pool.reserve_a
    }

    fn require_governor(env: &Env, caller: &Address) {
        assert!(caller == &Self::governor(env.clone()), "only governor");
    }

    fn outcome_token(env: &Env, outcome: u32) -> Option<Address> {
        env.storage()
            .persistent()
            .get(&DataKey::OutcomeToken(outcome))
    }

    fn pool_key(outcome_a: u32, outcome_b: u32) -> DataKey {
        let (a, b, _swapped) = Self::normalize_outcomes(outcome_a, outcome_b);
        DataKey::Pool(a, b)
    }

    fn position_key(provider: Address, outcome_a: u32, outcome_b: u32) -> DataKey {
        let (a, b, _swapped) = Self::normalize_outcomes(outcome_a, outcome_b);
        DataKey::Position(provider, a, b)
    }

    fn get_pool_or_default(env: &Env, outcome_a: u32, outcome_b: u32) -> Pool {
        let (a, b, _swapped) = Self::normalize_outcomes(outcome_a, outcome_b);
        env.storage()
            .persistent()
            .get(&DataKey::Pool(a, b))
            .unwrap_or(Pool {
                reserve_a: 0,
                reserve_b: 0,
                total_lp_supply: 0,
                fee_bps: DEFAULT_FEE_BPS,
            })
    }

    fn normalize_outcomes(a: u32, b: u32) -> (u32, u32, bool) {
        if a <= b {
            (a, b, false)
        } else {
            (b, a, true)
        }
    }
}

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::testutils::Events;
    use soroban_sdk::{Env, Symbol, TryFromVal};

    fn setup() -> (Env, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let governor = Address::generate(&env);
        let provider = Address::generate(&env);
        let contract_id = env.register_contract(None, LiquidityContract);
        LiquidityContractClient::new(&env, &contract_id).initialize(&governor);
        (env, provider, governor, contract_id)
    }

    #[test]
    fn test_add_liquidity_creates_pool() {
        let (env, provider, _, contract_id) = setup();
        let outcome_a: u32 = 1;
        let outcome_b: u32 = 2;
        let amount_a: i128 = 100_000;
        let amount_b: i128 = 200_000;

        let lp_tokens = LiquidityContractClient::new(&env, &contract_id)
            .add_liquidity(&provider, &outcome_a, &outcome_b, &amount_a, &amount_b);

        assert!(lp_tokens > 0);
        let pool =
            LiquidityContractClient::new(&env, &contract_id).get_pool(&outcome_a, &outcome_b);
        assert_eq!(pool.reserve_a, amount_a);
        assert_eq!(pool.reserve_b, amount_b);
    }

    #[test]
    fn test_add_liquidity_mints_lp_tokens() {
        let (env, provider, _, contract_id) = setup();
        let outcome_a: u32 = 1;
        let outcome_b: u32 = 2;
        let amount_a: i128 = 100_000;
        let amount_b: i128 = 200_000;

        let lp_tokens = LiquidityContractClient::new(&env, &contract_id)
            .add_liquidity(&provider, &outcome_a, &outcome_b, &amount_a, &amount_b);

        let position = LiquidityContractClient::new(&env, &contract_id)
            .get_lp_position(&provider, &outcome_a, &outcome_b);
        assert_eq!(position, lp_tokens);
    }

    #[test]
    fn test_remove_liquidity_returns_tokens() {
        let (env, provider, _, contract_id) = setup();
        let outcome_a: u32 = 1;
        let outcome_b: u32 = 2;
        let amount_a: i128 = 100_000;
        let amount_b: i128 = 200_000;

        let client = LiquidityContractClient::new(&env, &contract_id);
        let lp_tokens =
            client.add_liquidity(&provider, &outcome_a, &outcome_b, &amount_a, &amount_b);

        let (returned_a, returned_b) =
            client.remove_liquidity(&provider, &outcome_a, &outcome_b, &lp_tokens);

        assert!(returned_a > 0);
        assert!(returned_b > 0);
    }

    #[test]
    fn test_swap_moves_tokens() {
        let (env, provider, _, contract_id) = setup();
        let outcome_a: u32 = 1;
        let outcome_b: u32 = 2;
        let amount_a: i128 = 100_000;
        let amount_b: i128 = 200_000;

        let client = LiquidityContractClient::new(&env, &contract_id);
        client.add_liquidity(&provider, &outcome_a, &outcome_b, &amount_a, &amount_b);

        let trader = Address::generate(&env);
        let amount_in: i128 = 10_000;
        let min_out: i128 = 1;
        let amount_out = client.swap(&trader, &outcome_a, &outcome_b, &amount_in, &min_out);

        assert!(amount_out > 0);
        let pool = client.get_pool(&outcome_a, &outcome_b);
        assert!(pool.reserve_a > amount_a); // increased by amount_in
        assert!(pool.reserve_b < amount_b); // decreased by amount_out
    }

    #[test]
    fn test_pool_key_normalized() {
        let (env, provider, _, contract_id) = setup();
        let outcome_a: u32 = 1;
        let outcome_b: u32 = 2;
        let amount_a: i128 = 100_000;
        let amount_b: i128 = 200_000;

        let client = LiquidityContractClient::new(&env, &contract_id);

        // Add liquidity with (1, 2) and verify pool exists
        client.add_liquidity(&provider, &outcome_a, &outcome_b, &amount_a, &amount_b);

        // Check pool exists with (1, 2)
        let pool_ab = client.get_pool(&outcome_a, &outcome_b);
        assert_eq!(pool_ab.reserve_a, amount_a);
        assert_eq!(pool_ab.reserve_b, amount_b);

        // (2,1) should return the same pool but with reserves mapped to the
        // caller's requested order (reserve_a corresponds to outcome 2).
        let pool_ba = client.get_pool(&outcome_b, &outcome_a);
        assert_eq!(pool_ba.reserve_a, amount_b);
        assert_eq!(pool_ba.reserve_b, amount_a);
    }

    #[test]
    fn test_swap_invalid_token_rejected() {
        let (env, provider, _, contract_id) = setup();
        let outcome_a: u32 = 1;
        let outcome_b: u32 = 3;

        let client = LiquidityContractClient::new(&env, &contract_id);
        client.add_liquidity(&provider, &outcome_a, &outcome_b, &100_000, &200_000);

        let trader = Address::generate(&env);
        // Attempt swap with a token not in the pool
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.swap(&trader, &99, &outcome_b, &10_000, &1);
        }));
        assert!(result.is_err());
    }

    #[test]
    fn test_add_liquidity_emits_event() {
        let (env, provider, _, contract_id) = setup();
        let outcome_a: u32 = 1;
        let outcome_b: u32 = 2;

        let client = LiquidityContractClient::new(&env, &contract_id);
        client.add_liquidity(&provider, &outcome_a, &outcome_b, &100_000, &200_000);

        let events = env.events().all();
        let event_symbol = Symbol::new(&env, "LiquidityAdded");
        let found = events.iter().any(|event| {
            if event.0 != contract_id {
                return false;
            }
            if let Some(val) = event.1.get(0) {
                if let Ok(sym) = Symbol::try_from_val(&env, &val) {
                    return sym == event_symbol;
                }
            }
            false
        });
        assert!(found);
    }

    /// Deploy the liquidity contract plus two SAC tokens registered to outcomes
    /// 1 and 2, with `provider` funded. Returns the pieces tests need.
    fn setup_with_tokens() -> (Env, Address, Address, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let governor = Address::generate(&env);
        let provider = Address::generate(&env);
        let contract_id = env.register_contract(None, LiquidityContract);
        let client = LiquidityContractClient::new(&env, &contract_id);
        client.initialize(&governor);

        let admin = Address::generate(&env);
        let token_a = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let token_b = env.register_stellar_asset_contract_v2(admin).address();

        client.set_outcome_token(&governor, &1u32, &token_a);
        client.set_outcome_token(&governor, &2u32, &token_b);

        token::StellarAssetClient::new(&env, &token_a).mint(&provider, &500_000);
        token::StellarAssetClient::new(&env, &token_b).mint(&provider, &500_000);

        (env, provider, governor, contract_id, token_a, token_b)
    }

    #[test]
    /// Issue #379: add_liquidity moves real tokens into the contract.
    fn test_add_liquidity_transfers_real_tokens() {
        let (env, provider, _governor, contract_id, token_a, token_b) = setup_with_tokens();
        let client = LiquidityContractClient::new(&env, &contract_id);

        client.add_liquidity(&provider, &1u32, &2u32, &100_000, &200_000);

        let tok_a = token::TokenClient::new(&env, &token_a);
        let tok_b = token::TokenClient::new(&env, &token_b);
        // Pool now holds the deposited tokens; provider was debited.
        assert_eq!(tok_a.balance(&contract_id), 100_000);
        assert_eq!(tok_b.balance(&contract_id), 200_000);
        assert_eq!(tok_a.balance(&provider), 400_000);
        assert_eq!(tok_b.balance(&provider), 300_000);
    }

    #[test]
    /// Issue #379: remove_liquidity returns real tokens to the provider.
    fn test_remove_liquidity_returns_real_tokens() {
        let (env, provider, _governor, contract_id, token_a, token_b) = setup_with_tokens();
        let client = LiquidityContractClient::new(&env, &contract_id);

        let lp = client.add_liquidity(&provider, &1u32, &2u32, &100_000, &200_000);
        client.remove_liquidity(&provider, &1u32, &2u32, &lp);

        let tok_a = token::TokenClient::new(&env, &token_a);
        let tok_b = token::TokenClient::new(&env, &token_b);
        // Full withdrawal drains the pool back to the provider.
        assert_eq!(tok_a.balance(&contract_id), 0);
        assert_eq!(tok_b.balance(&contract_id), 0);
        assert_eq!(tok_a.balance(&provider), 500_000);
        assert_eq!(tok_b.balance(&provider), 500_000);
    }

    #[test]
    /// Issue #379: swap pulls the input token and pays out the output token.
    fn test_swap_transfers_real_tokens() {
        let (env, provider, _governor, contract_id, token_a, token_b) = setup_with_tokens();
        let client = LiquidityContractClient::new(&env, &contract_id);

        client.add_liquidity(&provider, &1u32, &2u32, &100_000, &200_000);

        let trader = Address::generate(&env);
        token::StellarAssetClient::new(&env, &token_a).mint(&trader, &50_000);

        let amount_out = client.swap(&trader, &1u32, &2u32, &10_000, &1i128);

        let tok_a = token::TokenClient::new(&env, &token_a);
        let tok_b = token::TokenClient::new(&env, &token_b);
        // Trader paid token_a and received token_out.
        assert_eq!(tok_a.balance(&trader), 40_000);
        assert_eq!(tok_b.balance(&trader), amount_out);
        // Contract reserves reflect the real movement.
        assert_eq!(tok_a.balance(&contract_id), 110_000);
        assert_eq!(tok_b.balance(&contract_id), 200_000 - amount_out);
    }

    #[test]
    #[should_panic(expected = "only governor")]
    /// Issue #379: only the governor may register outcome tokens.
    fn test_set_outcome_token_requires_governor() {
        let env = Env::default();
        env.mock_all_auths();
        let governor = Address::generate(&env);
        let contract_id = env.register_contract(None, LiquidityContract);
        let client = LiquidityContractClient::new(&env, &contract_id);
        client.initialize(&governor);

        let not_governor = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(Address::generate(&env))
            .address();
        client.set_outcome_token(&not_governor, &1u32, &token);
    }

    #[test]
    fn test_remove_liquidity_emits_event() {
        let (env, provider, _, contract_id) = setup();
        let outcome_a: u32 = 1;
        let outcome_b: u32 = 2;

        let client = LiquidityContractClient::new(&env, &contract_id);
        let lp = client.add_liquidity(&provider, &outcome_a, &outcome_b, &100_000, &200_000);
        client.remove_liquidity(&provider, &outcome_a, &outcome_b, &lp);

        let events = env.events().all();
        let event_symbol = Symbol::new(&env, "LiquidityRemoved");
        let found = events.iter().any(|event| {
            if event.0 != contract_id {
                return false;
            }
            if let Some(val) = event.1.get(0) {
                if let Ok(sym) = Symbol::try_from_val(&env, &val) {
                    return sym == event_symbol;
                }
            }
            false
        });
        assert!(found);
    }
}
