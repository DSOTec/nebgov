//! Reference strategy adapter implementing [`crate::StrategyAdapterTrait`].
//!
//! Simulates a fixed-APY yield source over a real token: deposited principal
//! accrues at [`FIXED_APY_BPS`] per [`YEAR_LEDGERS`], and `adapter_balance`
//! reports principal plus accrued interest. Payouts on withdraw are clamped
//! to whatever the adapter actually holds, so tests can simulate a lossy
//! position by draining tokens out of the adapter's address between deposit
//! and withdrawal. Not intended to integrate a real external protocol.

use soroban_sdk::{contract, contractimpl, contracttype, token, Address, Env};

use crate::StrategyAdapterTrait;

const YEAR_LEDGERS: i128 = 6_307_200;
const FIXED_APY_BPS: i128 = 500;

#[contracttype]
enum DataKey {
    Principal(Address),
    LastLedger(Address),
}

#[contract]
pub struct MockAdapter;

impl MockAdapter {
    fn accrued(env: &Env, token: &Address) -> i128 {
        let principal: i128 = env
            .storage()
            .instance()
            .get(&DataKey::Principal(token.clone()))
            .unwrap_or(0);
        if principal == 0 {
            return 0;
        }
        let last_ledger: u32 = env
            .storage()
            .instance()
            .get(&DataKey::LastLedger(token.clone()))
            .unwrap_or(env.ledger().sequence());
        let elapsed = (env.ledger().sequence() - last_ledger) as i128;
        let interest = principal * FIXED_APY_BPS * elapsed / (10_000 * YEAR_LEDGERS);
        principal + interest
    }
}

#[contractimpl]
impl StrategyAdapterTrait for MockAdapter {
    fn adapter_deposit(env: Env, caller: Address, token: Address, amount: i128) {
        caller.require_auth();
        let accrued = Self::accrued(&env, &token);
        let new_principal = accrued + amount;
        env.storage()
            .instance()
            .set(&DataKey::Principal(token.clone()), &new_principal);
        env.storage()
            .instance()
            .set(&DataKey::LastLedger(token), &env.ledger().sequence());
    }

    fn adapter_withdraw(env: Env, caller: Address, token: Address, amount: i128) -> i128 {
        caller.require_auth();
        let accrued = Self::accrued(&env, &token);
        let held = token::TokenClient::new(&env, &token).balance(&env.current_contract_address());
        let payout = amount.min(accrued).min(held);

        let token_client = token::TokenClient::new(&env, &token);
        token_client.transfer(&env.current_contract_address(), &caller, &payout);

        let remaining_principal = accrued - payout;
        env.storage()
            .instance()
            .set(&DataKey::Principal(token.clone()), &remaining_principal);
        env.storage()
            .instance()
            .set(&DataKey::LastLedger(token), &env.ledger().sequence());

        payout
    }

    fn adapter_balance(env: Env, token: Address) -> i128 {
        let accrued = Self::accrued(&env, &token);
        let held = token::TokenClient::new(&env, &token).balance(&env.current_contract_address());
        accrued.min(held)
    }
}
