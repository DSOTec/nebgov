use super::adapters::mock_adapter::MockAdapter;
use super::{TreasuryStrategiesContract, TreasuryStrategiesContractClient};
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::token::StellarAssetClient;
use soroban_sdk::Address;
use soroban_sdk::Env;

const COOLDOWN: u32 = 100;

fn setup() -> (
    Env,
    TreasuryStrategiesContractClient<'static>,
    Address,
    Address,
    Address,
    Address,
) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(TreasuryStrategiesContract, ());
    let client = TreasuryStrategiesContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let sac_admin = Address::generate(&env);
    let token = env
        .register_stellar_asset_contract_v2(sac_admin.clone())
        .address();

    let sac = StellarAssetClient::new(&env, &token);
    sac.mint(&treasury, &1_000_000);

    client.initialize(&admin, &treasury);

    (env, client, admin, treasury, token, sac_admin)
}

fn register_adapter(env: &Env, client: &TreasuryStrategiesContractClient, admin: &Address, token: &Address, max_allocation_bps: u32) -> (u64, Address) {
    let adapter_id = env.register(MockAdapter, ());
    let strategy_id = client.register_strategy(admin, &adapter_id, token, &max_allocation_bps, &COOLDOWN);
    (strategy_id, adapter_id)
}

#[test]
fn test_register_strategy_rejected_from_non_admin() {
    let (env, client, _admin, _treasury, token, _sac_admin) = setup();
    let intruder = Address::generate(&env);
    let adapter_id = env.register(MockAdapter, ());

    let result = client.try_register_strategy(&intruder, &adapter_id, &token, &10_000, &COOLDOWN);
    assert!(result.is_err());
}

#[test]
fn test_deposit_rejected_from_non_treasury() {
    let (env, client, admin, _treasury, token, sac_admin) = setup();
    register_adapter(&env, &client, &admin, &token, 10_000);

    let intruder = Address::generate(&env);
    let sac = StellarAssetClient::new(&env, &token);
    sac.mint(&intruder, &1_000);

    let result = client.try_deposit(&intruder, &token, &1_000);
    assert!(result.is_err());
    let _ = sac_admin;
}

#[test]
fn test_deposit_routes_to_least_allocated_active_strategy() {
    let (env, client, admin, treasury, token, _sac_admin) = setup();
    let (strategy_a, _adapter_a) = register_adapter(&env, &client, &admin, &token, 10_000);
    let (strategy_b, _adapter_b) = register_adapter(&env, &client, &admin, &token, 10_000);

    client.deposit(&treasury, &token, &100);
    let alloc_a = client.get_allocation(&strategy_a);
    assert_eq!(alloc_a.amount, 100);

    client.deposit(&treasury, &token, &50);
    let alloc_b = client.get_allocation(&strategy_b);
    assert_eq!(alloc_b.amount, 50);

    let alloc_a_after = client.get_allocation(&strategy_a);
    assert_eq!(alloc_a_after.amount, 100);
}

#[test]
fn test_deposit_respects_max_allocation_bps() {
    let (env, client, admin, treasury, token, _sac_admin) = setup();
    register_adapter(&env, &client, &admin, &token, 5_000);

    let result = client.try_deposit(&treasury, &token, &1_000);
    assert!(result.is_err());
}

#[test]
fn test_deposit_with_no_active_strategy_panics() {
    let (_env, client, _admin, treasury, token, _sac_admin) = setup();
    let result = client.try_deposit(&treasury, &token, &1_000);
    assert!(result.is_err());
}

#[test]
fn test_request_withdrawal_exceeding_allocation_panics() {
    let (env, client, admin, treasury, token, _sac_admin) = setup();
    let (strategy_id, _adapter_id) = register_adapter(&env, &client, &admin, &token, 10_000);
    client.deposit(&treasury, &token, &100);

    let result = client.try_request_withdrawal(&treasury, &strategy_id, &200);
    assert!(result.is_err());
}

#[test]
fn test_claim_withdrawal_before_claimable_panics() {
    let (env, client, admin, treasury, token, _sac_admin) = setup();
    let (strategy_id, _adapter_id) = register_adapter(&env, &client, &admin, &token, 10_000);
    client.deposit(&treasury, &token, &100);

    let withdrawal_id = client.request_withdrawal(&treasury, &strategy_id, &100);
    let result = client.try_claim_withdrawal(&withdrawal_id);
    assert!(result.is_err());
}

#[test]
fn test_claim_withdrawal_after_cooldown_succeeds() {
    let (env, client, admin, treasury, token, _sac_admin) = setup();
    let (strategy_id, _adapter_id) = register_adapter(&env, &client, &admin, &token, 10_000);
    client.deposit(&treasury, &token, &100);

    let withdrawal_id = client.request_withdrawal(&treasury, &strategy_id, &100);

    env.ledger()
        .with_mut(|ledger| ledger.sequence_number += COOLDOWN + 1);

    let treasury_balance_before = soroban_sdk::token::TokenClient::new(&env, &token).balance(&treasury);
    client.claim_withdrawal(&withdrawal_id);
    let treasury_balance_after = soroban_sdk::token::TokenClient::new(&env, &token).balance(&treasury);
    assert_eq!(treasury_balance_after - treasury_balance_before, 100);

    let result = client.try_claim_withdrawal(&withdrawal_id);
    assert!(result.is_err());
}

#[test]
fn test_claim_withdrawal_handles_adapter_loss() {
    let (env, client, admin, treasury, token, _sac_admin) = setup();
    let (strategy_id, adapter_id) = register_adapter(&env, &client, &admin, &token, 10_000);
    client.deposit(&treasury, &token, &100);

    let token_client = soroban_sdk::token::TokenClient::new(&env, &token);
    let held = token_client.balance(&adapter_id);
    token_client.transfer(&adapter_id, &treasury, &(held - 40));

    let withdrawal_id = client.request_withdrawal(&treasury, &strategy_id, &100);
    env.ledger()
        .with_mut(|ledger| ledger.sequence_number += COOLDOWN + 1);

    let treasury_balance_before = token_client.balance(&treasury);
    client.claim_withdrawal(&withdrawal_id);
    let treasury_balance_after = token_client.balance(&treasury);
    assert_eq!(treasury_balance_after - treasury_balance_before, 40);
}

#[test]
fn test_deactivate_strategy_blocks_deposits_not_withdrawals() {
    let (env, client, admin, treasury, token, _sac_admin) = setup();
    let (strategy_id, _adapter_id) = register_adapter(&env, &client, &admin, &token, 10_000);
    client.deposit(&treasury, &token, &100);

    client.deactivate_strategy(&admin, &strategy_id);

    let deposit_result = client.try_deposit(&treasury, &token, &50);
    assert!(deposit_result.is_err());

    let withdrawal_id = client.request_withdrawal(&treasury, &strategy_id, &100);
    env.ledger()
        .with_mut(|ledger| ledger.sequence_number += COOLDOWN + 1);
    client.claim_withdrawal(&withdrawal_id);
}

#[test]
fn test_get_total_value_sums_across_strategies() {
    let (env, client, admin, treasury, token, _sac_admin) = setup();
    register_adapter(&env, &client, &admin, &token, 10_000);
    register_adapter(&env, &client, &admin, &token, 10_000);

    client.deposit(&treasury, &token, &100);
    client.deposit(&treasury, &token, &60);

    let total = client.get_total_value(&token);
    assert_eq!(total, 160);
}

#[test]
#[should_panic(expected = "Error(Contract, #12)")]
fn test_register_strategy_rejects_invalid_max_allocation_bps() {
    let (env, client, admin, _treasury, token, _sac_admin) = setup();
    let adapter_id = env.register(MockAdapter, ());
    client.register_strategy(&admin, &adapter_id, &token, &10_001, &COOLDOWN);
}

#[test]
fn test_get_treasury_returns_configured_treasury() {
    let (_env, client, _admin, treasury, _token, _sac_admin) = setup();
    assert_eq!(client.get_treasury(), treasury);
}
