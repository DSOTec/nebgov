use super::{LiquidityContract, LiquidityContractClient};
use soroban_sdk::xdr::ToXdr;
use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::{Address as _, Ledger as _},
    Address, Bytes, Env, IntoVal, String, Symbol, Val, Vec,
};
use sorogov_governor::{GovernorContract, GovernorContractClient, VoteSupport, VoteType};
use sorogov_timelock::{TimelockContract, TimelockContractClient};

#[contracttype]
#[derive(Clone)]
enum MockVotesDataKey {
    Votes(Address),
    TotalSupply,
}

#[contract]
pub struct MockVotesContract;

#[contractimpl]
impl MockVotesContract {
    pub fn set_votes(env: Env, account: Address, votes: i128) {
        env.storage()
            .instance()
            .set(&MockVotesDataKey::Votes(account), &votes);
    }

    pub fn set_total_supply(env: Env, total_supply: i128) {
        env.storage()
            .instance()
            .set(&MockVotesDataKey::TotalSupply, &total_supply);
    }

    pub fn get_votes(env: Env, account: Address) -> i128 {
        env.storage()
            .instance()
            .get(&MockVotesDataKey::Votes(account))
            .unwrap_or(0)
    }

    pub fn get_past_votes(env: Env, account: Address, _ledger: u32) -> i128 {
        Self::get_votes(env, account)
    }

    pub fn get_past_total_supply(env: Env, _ledger: u32) -> i128 {
        env.storage()
            .instance()
            .get(&MockVotesDataKey::TotalSupply)
            .unwrap_or(0)
    }
}

fn setup_liquidity() -> (Env, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(LiquidityContract, ());
    let client = LiquidityContractClient::new(&env, &contract_id);

    let governor = Address::generate(&env);
    let provider = Address::generate(&env);
    let trader = Address::generate(&env);

    client.initialize(&governor);

    (env, contract_id, governor, provider, trader)
}

#[test]
fn test_initialize_sets_governor() {
    let (env, contract_id, governor, _, _) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);
    assert_eq!(client.governor(), governor);
}

#[test]
fn test_add_liquidity_creates_pool_and_position() {
    let (env, contract_id, _, provider, _) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    let lp_tokens = client.add_liquidity(&provider, &0, &1, &10_000, &10_000);
    assert_eq!(lp_tokens, 10_000);

    let pool = client.get_pool(&0, &1);
    assert_eq!(pool.reserve_a, 10_000);
    assert_eq!(pool.reserve_b, 10_000);
    assert_eq!(pool.total_lp_supply, 10_000);
    assert_eq!(pool.fee_bps, 30);
    assert_eq!(client.get_lp_position(&provider, &0, &1), 10_000);
}

#[test]
fn test_get_lp_position_defaults_to_zero() {
    let (env, contract_id, _, _, _) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);
    let unknown_provider = Address::generate(&env);
    assert_eq!(client.get_lp_position(&unknown_provider, &0, &1), 0);
}

#[test]
fn test_remove_liquidity_burns_lp_tokens() {
    let (env, contract_id, _, provider, _) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    client.add_liquidity(&provider, &0, &1, &10_000, &10_000);
    let (amount_a, amount_b) = client.remove_liquidity(&provider, &0, &1, &4_000);

    assert_eq!(amount_a, 4_000);
    assert_eq!(amount_b, 4_000);

    let pool = client.get_pool(&0, &1);
    assert_eq!(pool.reserve_a, 6_000);
    assert_eq!(pool.reserve_b, 6_000);
    assert_eq!(pool.total_lp_supply, 6_000);
    assert_eq!(client.get_lp_position(&provider, &0, &1), 6_000);
}

#[test]
fn test_swap_updates_reserves_and_price() {
    let (env, contract_id, _, provider, trader) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    client.add_liquidity(&provider, &0, &1, &10_000, &10_000);
    let price_before = client.get_price(&0, &1);
    let amount_out = client.swap(&trader, &0, &1, &1_000, &0);
    let price_after = client.get_price(&0, &1);

    assert!(amount_out > 0);
    assert!(amount_out < 1_000);
    assert!(price_after < price_before);
}

#[test]
fn test_update_pool_fee_changes_fee_for_governor() {
    let (env, contract_id, governor, provider, _) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    client.add_liquidity(&provider, &0, &1, &10_000, &10_000);
    client.update_pool_fee(&governor, &0, &1, &75);

    let pool = client.get_pool(&0, &1);
    assert_eq!(pool.fee_bps, 75);
}

#[test]
#[should_panic(expected = "only governor")]
fn test_update_pool_fee_rejects_non_governor() {
    let (env, contract_id, _, provider, _) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);
    let unauthorized = Address::generate(&env);

    client.add_liquidity(&provider, &0, &1, &10_000, &10_000);
    client.update_pool_fee(&unauthorized, &0, &1, &75);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn test_add_liquidity_rejects_zero_amounts() {
    let (env, contract_id, _, provider, _) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);
    client.add_liquidity(&provider, &0, &1, &0, &10_000);
}

#[test]
#[should_panic(expected = "fee too high")]
fn test_update_pool_fee_rejects_excessive_fee() {
    let (env, contract_id, governor, provider, _) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    client.add_liquidity(&provider, &0, &1, &10_000, &10_000);
    client.update_pool_fee(&governor, &0, &1, &1_001);
}

#[test]
fn test_governor_proposal_executes_liquidity_fee_update() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let admin = Address::generate(&env);
    let guardian = Address::generate(&env);
    let proposer = Address::generate(&env);
    let voter = Address::generate(&env);
    let provider = Address::generate(&env);

    let votes_id = env.register(MockVotesContract, ());
    let votes_client = MockVotesContractClient::new(&env, &votes_id);
    votes_client.set_votes(&proposer, &500);
    votes_client.set_votes(&voter, &500);
    votes_client.set_total_supply(&1_000);

    let liquidity_id = env.register(LiquidityContract, ());
    let liquidity_client = LiquidityContractClient::new(&env, &liquidity_id);

    let timelock_id = env.register(TimelockContract, ());
    let governor_id = env.register(GovernorContract, ());

    let timelock_client = TimelockContractClient::new(&env, &timelock_id);
    let governor_client = GovernorContractClient::new(&env, &governor_id);

    liquidity_client.initialize(&governor_id);
    liquidity_client.add_liquidity(&provider, &0, &1, &10_000, &10_000);

    timelock_client.initialize(&admin, &governor_id, &1, &1_209_600);
    governor_client.initialize(
        &admin,
        &votes_id,
        &timelock_id,
        &0,
        &5,
        &0,
        &0,
        &guardian,
        &VoteType::Extended,
        &120_960,
    );

    let description = String::from_str(&env, "Update liquidity pool fee");
    let description_hash = env
        .crypto()
        .sha256(&Bytes::from_slice(&env, b"update-liquidity-pool-fee"))
        .into();
    let metadata_uri = String::from_str(&env, "ipfs://liquidity-fee-update");

    let mut targets = Vec::new(&env);
    targets.push_back(liquidity_id.clone());

    let mut fn_names = Vec::new(&env);
    fn_names.push_back(Symbol::new(&env, "update_pool_fee"));

    let mut args: Vec<Val> = Vec::new(&env);
    args.push_back(governor_id.clone().into_val(&env));
    args.push_back(0u32.into_val(&env));
    args.push_back(1u32.into_val(&env));
    args.push_back(75u32.into_val(&env));

    let mut calldatas = Vec::new(&env);
    calldatas.push_back(args.to_xdr(&env));

    let proposal_id = governor_client.propose(
        &proposer,
        &description,
        &description_hash,
        &metadata_uri,
        &targets,
        &fn_names,
        &calldatas,
    );

    governor_client.cast_vote(&voter, &proposal_id, &VoteSupport::For);
    env.ledger().with_mut(|ledger| ledger.sequence_number = 6);

    governor_client.queue(&proposal_id);
    let queued_pool = liquidity_client.get_pool(&0, &1);
    assert_eq!(queued_pool.fee_bps, 30);

    let queue_timestamp = env.ledger().timestamp();
    env.ledger()
        .with_mut(|ledger| ledger.timestamp = queue_timestamp + 2);

    governor_client.execute(&proposal_id);

    let updated_pool = liquidity_client.get_pool(&0, &1);
    assert_eq!(updated_pool.fee_bps, 75);
}
// ============================================================================
// SECURITY TESTS FOR REMOVE_LIQUIDITY GUARDS (Issue #471)
// ============================================================================

#[test]
#[should_panic(expected = "invalid amount")]
fn test_remove_liquidity_rejects_zero_shares() {
    let (env, contract_id, _, provider, _) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    client.add_liquidity(&provider, &0, &1, &10_000, &10_000);
    
    // Attempt to remove zero shares - should panic with InvalidAmount
    client.remove_liquidity(&provider, &0, &1, &0);
}

#[test]
#[should_panic(expected = "invalid amount")]
fn test_remove_liquidity_rejects_negative_shares() {
    let (env, contract_id, _, provider, _) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    client.add_liquidity(&provider, &0, &1, &10_000, &10_000);
    
    // Attempt to remove negative shares - should panic with InvalidAmount
    client.remove_liquidity(&provider, &0, &1, &-1);
}

#[test]
#[should_panic(expected = "insufficient shares")]
fn test_remove_liquidity_rejects_excessive_shares() {
    let (env, contract_id, _, provider, _) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    // Provider adds 100 LP tokens
    client.add_liquidity(&provider, &0, &1, &10_000, &10_000);
    assert_eq!(client.get_lp_position(&provider, &0, &1), 10_000);
    
    // Attempt to remove 10_001 shares (exceeds balance of 10_000) - should panic with InsufficientShares
    client.remove_liquidity(&provider, &0, &1, &10_001);
}

#[test]
#[should_panic(expected = "insufficient shares")]
fn test_remove_liquidity_rejects_zero_share_provider_positive_amount() {
    let (env, contract_id, _, provider, _) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);
    let other_provider = Address::generate(&env);

    // Setup: provider1 adds liquidity
    client.add_liquidity(&provider, &0, &1, &10_000, &10_000);
    
    // other_provider has zero LP shares (never added liquidity)
    assert_eq!(client.get_lp_position(&other_provider, &0, &1), 0);
    
    // Attempt to remove positive shares as other_provider (who has 0 balance) - should panic with InsufficientShares
    client.remove_liquidity(&other_provider, &0, &1, &1);
}

#[test]
fn test_remove_liquidity_valid_exact_balance() {
    let (env, contract_id, _, provider, _) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    // Setup: provider adds 10_000 LP tokens
    client.add_liquidity(&provider, &0, &1, &10_000, &10_000);
    assert_eq!(client.get_lp_position(&provider, &0, &1), 10_000);

    // Remove exact balance (10_000 shares)
    let (amount_a, amount_b) = client.remove_liquidity(&provider, &0, &1, &10_000);
    
    // Verify correct amounts returned (should be proportional to 100% of reserves)
    assert_eq!(amount_a, 10_000);
    assert_eq!(amount_b, 10_000);
    
    // Verify provider's balance is now 0
    assert_eq!(client.get_lp_position(&provider, &0, &1), 0);
    
    // Verify pool reserves are depleted
    let pool = client.get_pool(&0, &1);
    assert_eq!(pool.reserve_a, 0);
    assert_eq!(pool.reserve_b, 0);
    assert_eq!(pool.total_lp_supply, 0);
}

#[test]
fn test_remove_liquidity_valid_partial_removal() {
    let (env, contract_id, _, provider, _) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    // Setup: provider adds 10_000 LP tokens
    client.add_liquidity(&provider, &0, &1, &10_000, &10_000);
    assert_eq!(client.get_lp_position(&provider, &0, &1), 10_000);

    // Remove 50% (5_000 shares)
    let (amount_a, amount_b) = client.remove_liquidity(&provider, &0, &1, &5_000);
    
    // Verify correct amounts returned (50% of reserves)
    assert_eq!(amount_a, 5_000);
    assert_eq!(amount_b, 5_000);
    
    // Verify provider's remaining balance is 50%
    assert_eq!(client.get_lp_position(&provider, &0, &1), 5_000);
    
    // Verify pool reserves are reduced by 50%
    let pool = client.get_pool(&0, &1);
    assert_eq!(pool.reserve_a, 5_000);
    assert_eq!(pool.reserve_b, 5_000);
    assert_eq!(pool.total_lp_supply, 5_000);
}

#[test]
fn test_remove_liquidity_state_unchanged_on_invalid_amount_guard() {
    let (env, contract_id, _, provider, _) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    // Setup: provider adds 10_000 LP tokens
    client.add_liquidity(&provider, &0, &1, &10_000, &10_000);
    
    // Record initial state
    let initial_balance = client.get_lp_position(&provider, &0, &1);
    let initial_pool = client.get_pool(&0, &1);
    
    // Attempt invalid removal (zero shares) - will panic
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.remove_liquidity(&provider, &0, &1, &0);
    }));
    assert!(result.is_err());
    
    // Verify state is unchanged after failed guard
    assert_eq!(client.get_lp_position(&provider, &0, &1), initial_balance);
    let pool_after = client.get_pool(&0, &1);
    assert_eq!(pool_after.reserve_a, initial_pool.reserve_a);
    assert_eq!(pool_after.reserve_b, initial_pool.reserve_b);
    assert_eq!(pool_after.total_lp_supply, initial_pool.total_lp_supply);
}

#[test]
fn test_remove_liquidity_state_unchanged_on_insufficient_shares_guard() {
    let (env, contract_id, _, provider, _) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    // Setup: provider adds 10_000 LP tokens
    client.add_liquidity(&provider, &0, &1, &10_000, &10_000);
    
    // Record initial state
    let initial_balance = client.get_lp_position(&provider, &0, &1);
    let initial_pool = client.get_pool(&0, &1);
    
    // Attempt invalid removal (balance exceeded) - will panic
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.remove_liquidity(&provider, &0, &1, &10_001);
    }));
    assert!(result.is_err());
    
    // Verify state is unchanged after failed guard
    assert_eq!(client.get_lp_position(&provider, &0, &1), initial_balance);
    let pool_after = client.get_pool(&0, &1);
    assert_eq!(pool_after.reserve_a, initial_pool.reserve_a);
    assert_eq!(pool_after.reserve_b, initial_pool.reserve_b);
    assert_eq!(pool_after.total_lp_supply, initial_pool.total_lp_supply);
}