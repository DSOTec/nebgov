//! Tests for the delegation registry (issue #769): entry/history bookkeeping,
//! received-delegation lists, delegator counts, chain resolution, cycle
//! detection, depth-limit enforcement, historical snapshots, delegate
//! profiles, and pagination.

use crate::{TokenVotesContract, TokenVotesContractClient};
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{token, Address, Env};

fn setup(env: &Env, admin: &Address) -> (Address, Address) {
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();
    let contract_id = env.register(TokenVotesContract, ());
    let client = TokenVotesContractClient::new(env, &contract_id);
    client.initialize(admin, &token_addr);
    (contract_id, token_addr)
}

fn set_ledger(env: &Env, seq: u32) {
    env.ledger().with_mut(|l| {
        l.sequence_number = seq;
    });
}

#[test]
fn test_delegation_entry_written_on_delegate_call() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let delegator = Address::generate(&env);
    let delegatee = Address::generate(&env);

    let (contract_id, token_addr) = setup(&env, &admin);
    let client = TokenVotesContractClient::new(&env, &contract_id);
    token::StellarAssetClient::new(&env, &token_addr).mint(&delegator, &1000i128);

    set_ledger(&env, 10);
    client.delegate(&delegator, &delegatee);

    let entries = client.get_received_delegations(&delegatee, &0, &10);
    assert_eq!(entries.len(), 1);
    let entry = entries.get(0).unwrap();
    assert_eq!(entry.delegator, delegator);
    assert_eq!(entry.delegatee, delegatee);
    assert_eq!(entry.delegated_at_ledger, 10);
    assert_eq!(entry.voting_power_at_delegation, 1000);
    assert!(entry.active);
    assert_eq!(entry.revoked_at_ledger, None);

    let history = client.get_delegation_history(&delegator);
    assert_eq!(history.len(), 1);
    assert_eq!(history.get(0).unwrap().delegatee, delegatee);
}

#[test]
fn test_delegation_history_append_on_re_delegation() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let delegator = Address::generate(&env);
    let a = Address::generate(&env);
    let b = Address::generate(&env);

    let (contract_id, _token_addr) = setup(&env, &admin);
    let client = TokenVotesContractClient::new(&env, &contract_id);

    set_ledger(&env, 10);
    client.delegate(&delegator, &a);

    set_ledger(&env, 20);
    client.delegate(&delegator, &b);

    let history = client.get_delegation_history(&delegator);
    assert_eq!(history.len(), 2);

    let first = history.get(0).unwrap();
    assert_eq!(first.delegatee, a);
    assert_eq!(first.delegated_at_ledger, 10);
    assert_eq!(first.revoked_at_ledger, Some(20));

    let second = history.get(1).unwrap();
    assert_eq!(second.delegatee, b);
    assert_eq!(second.delegated_at_ledger, 20);
    assert_eq!(second.revoked_at_ledger, None);
}

#[test]
fn test_delegation_history_records_revocation_ledger() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let delegator = Address::generate(&env);
    let a = Address::generate(&env);

    let (contract_id, _token_addr) = setup(&env, &admin);
    let client = TokenVotesContractClient::new(&env, &contract_id);

    set_ledger(&env, 5);
    client.delegate(&delegator, &a);

    set_ledger(&env, 42);
    client.undelegate(&delegator);

    let history = client.get_delegation_history(&delegator);
    assert_eq!(history.len(), 1);
    assert_eq!(history.get(0).unwrap().revoked_at_ledger, Some(42));
}

#[test]
fn test_received_delegations_updated_on_delegate() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let delegator = Address::generate(&env);
    let delegatee = Address::generate(&env);

    let (contract_id, _token_addr) = setup(&env, &admin);
    let client = TokenVotesContractClient::new(&env, &contract_id);

    client.delegate(&delegator, &delegatee);

    let delegators = client.get_delegators(&delegatee, &0, &10);
    assert_eq!(delegators.len(), 1);
    assert_eq!(delegators.get(0).unwrap().address, delegator);
}

#[test]
fn test_received_delegations_updated_on_re_delegation() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let delegator = Address::generate(&env);
    let a = Address::generate(&env);
    let b = Address::generate(&env);

    let (contract_id, _token_addr) = setup(&env, &admin);
    let client = TokenVotesContractClient::new(&env, &contract_id);

    client.delegate(&delegator, &a);
    set_ledger(&env, 2);
    client.delegate(&delegator, &b);

    assert_eq!(client.get_delegators(&a, &0, &10).len(), 0);
    let b_delegators = client.get_delegators(&b, &0, &10);
    assert_eq!(b_delegators.len(), 1);
    assert_eq!(b_delegators.get(0).unwrap().address, delegator);
}

#[test]
fn test_delegator_count_increments_and_decrements() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let delegator = Address::generate(&env);
    let delegatee = Address::generate(&env);

    let (contract_id, _token_addr) = setup(&env, &admin);
    let client = TokenVotesContractClient::new(&env, &contract_id);

    assert_eq!(client.get_delegator_count(&delegatee), 0);

    client.delegate(&delegator, &delegatee);
    assert_eq!(client.get_delegator_count(&delegatee), 1);

    set_ledger(&env, 2);
    client.undelegate(&delegator);
    assert_eq!(client.get_delegator_count(&delegatee), 0);
}

#[test]
fn test_delegation_chain_single_hop() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let delegator = Address::generate(&env);
    let delegatee = Address::generate(&env);

    let (contract_id, _token_addr) = setup(&env, &admin);
    let client = TokenVotesContractClient::new(&env, &contract_id);

    client.delegate(&delegator, &delegatee);

    let chain = client.get_delegation_chain(&delegator);
    assert_eq!(chain.len(), 2);
    assert_eq!(chain.get(0).unwrap(), delegator);
    assert_eq!(chain.get(1).unwrap(), delegatee);
    assert_eq!(client.get_chain_depth(&delegator), 1);
}

/// A -> B, then B attempts to delegate to A: this loops the chain back onto
/// itself (B -> A -> B) and must be rejected.
#[test]
#[should_panic(expected = "delegation would create a cycle")]
fn test_cycle_detection_self_delegation_blocked() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let a = Address::generate(&env);
    let b = Address::generate(&env);

    let (contract_id, _token_addr) = setup(&env, &admin);
    let client = TokenVotesContractClient::new(&env, &contract_id);

    client.delegate(&a, &b);
    client.delegate(&b, &a);
}

/// A -> B -> C, then C attempts to delegate to A: a 3-node cycle must be
/// rejected.
#[test]
#[should_panic(expected = "delegation would create a cycle")]
fn test_cycle_detection_indirect_cycle_blocked() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    let c = Address::generate(&env);

    let (contract_id, _token_addr) = setup(&env, &admin);
    let client = TokenVotesContractClient::new(&env, &contract_id);

    client.set_delegation_depth_limit(&admin, &3);

    client.delegate(&a, &b);
    set_ledger(&env, 2);
    client.delegate(&b, &c);
    set_ledger(&env, 3);
    client.delegate(&c, &a);
}

/// Default depth limit is 1: B -> C first (fine, single hop from B). A -> B
/// would then create a 2-hop chain (A -> B -> C), exceeding the default
/// limit, and must be rejected.
#[test]
#[should_panic(expected = "delegation would exceed max chain depth")]
fn test_chain_depth_limit_enforced() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    let c = Address::generate(&env);

    let (contract_id, _token_addr) = setup(&env, &admin);
    let client = TokenVotesContractClient::new(&env, &contract_id);

    client.delegate(&b, &c);
    client.delegate(&a, &b);
}

/// Raising the depth limit via the admin function allows a deeper chain that
/// would otherwise be rejected.
#[test]
fn test_chain_depth_limit_can_be_raised_by_admin() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    let c = Address::generate(&env);

    let (contract_id, _token_addr) = setup(&env, &admin);
    let client = TokenVotesContractClient::new(&env, &contract_id);

    client.delegate(&b, &c);

    set_ledger(&env, 2);
    client.set_delegation_depth_limit(&admin, &2);
    client.delegate(&a, &b);

    assert_eq!(client.get_chain_depth(&a), 2);
    let chain = client.get_delegation_chain(&a);
    assert_eq!(chain.len(), 3);
    assert_eq!(chain.get(2).unwrap(), c);
}

#[test]
fn test_delegation_snapshot_at_past_ledger() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let delegator = Address::generate(&env);
    let a = Address::generate(&env);
    let b = Address::generate(&env);

    let (contract_id, token_addr) = setup(&env, &admin);
    let client = TokenVotesContractClient::new(&env, &contract_id);
    token::StellarAssetClient::new(&env, &token_addr).mint(&delegator, &777i128);

    set_ledger(&env, 10);
    client.delegate(&delegator, &a);

    set_ledger(&env, 20);
    client.delegate(&delegator, &b);

    set_ledger(&env, 25);
    let snapshot_at_15 = client.get_delegation_snapshot(&a, &15, &0, &100);
    assert_eq!(snapshot_at_15.len(), 1);
    assert_eq!(snapshot_at_15.get(0).unwrap().address, delegator);
    assert_eq!(snapshot_at_15.get(0).unwrap().delegated_power, 777);

    let snapshot_at_20 = client.get_delegation_snapshot(&a, &20, &0, &100);
    assert_eq!(snapshot_at_20.len(), 0);
}

#[test]
fn test_delegate_profile_aggregates_all_fields() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let delegator1 = Address::generate(&env);
    let delegator2 = Address::generate(&env);
    let delegatee = Address::generate(&env);

    let (contract_id, token_addr) = setup(&env, &admin);
    let client = TokenVotesContractClient::new(&env, &contract_id);
    let sac_client = token::StellarAssetClient::new(&env, &token_addr);
    sac_client.mint(&delegator1, &300i128);
    sac_client.mint(&delegator2, &700i128);

    set_ledger(&env, 5);
    client.delegate(&delegator1, &delegatee);
    set_ledger(&env, 8);
    client.delegate(&delegator2, &delegatee);

    let profile = client.get_delegate_profile(&delegatee);
    assert_eq!(profile.address, delegatee);
    assert_eq!(profile.total_delegators, 2);
    assert_eq!(profile.total_delegated_power, 1000);
    assert_eq!(profile.current_voting_power, 1000);
    assert_eq!(profile.base_voting_power, 1000);
    assert_eq!(profile.delegation_depth_limit, 1);
    assert_eq!(profile.first_delegated_at_ledger, Some(5));
}

#[test]
fn test_get_delegators_pagination() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let delegatee = Address::generate(&env);
    let d1 = Address::generate(&env);
    let d2 = Address::generate(&env);
    let d3 = Address::generate(&env);

    let (contract_id, _token_addr) = setup(&env, &admin);
    let client = TokenVotesContractClient::new(&env, &contract_id);

    client.delegate(&d1, &delegatee);
    set_ledger(&env, 2);
    client.delegate(&d2, &delegatee);
    set_ledger(&env, 3);
    client.delegate(&d3, &delegatee);

    assert_eq!(client.get_delegator_count(&delegatee), 3);

    let page = client.get_delegators(&delegatee, &1, &1);
    assert_eq!(page.len(), 1);
    assert_eq!(page.get(0).unwrap().address, d2);

    let all = client.get_delegators(&delegatee, &0, &100);
    assert_eq!(all.len(), 3);
}

#[test]
fn test_delegation_depth_limit_update_by_admin() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);

    let (contract_id, _token_addr) = setup(&env, &admin);
    let client = TokenVotesContractClient::new(&env, &contract_id);

    assert_eq!(client.get_delegation_depth_limit(), 1);

    client.set_delegation_depth_limit(&admin, &5);
    assert_eq!(client.get_delegation_depth_limit(), 5);
}

#[test]
#[should_panic(expected = "unauthorized")]
fn test_delegation_depth_limit_update_rejects_non_admin() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let not_admin = Address::generate(&env);

    let (contract_id, _token_addr) = setup(&env, &admin);
    let client = TokenVotesContractClient::new(&env, &contract_id);

    client.set_delegation_depth_limit(&not_admin, &10);
}

/// Test that demonstrates the silent truncation bug when the delegation depth
/// limit exceeds MAX_CHAIN_WALK (64). This test creates a 64-hop chain, sets
/// the depth limit to 65, then attempts to add one more hop. The delegation
/// should be rejected because it would create a 65-hop chain exceeding the
/// configured limit of 65, but due to the bug in resolve_chain (which truncates
/// at MAX_CHAIN_WALK), the validation incorrectly passes.
#[test]
#[should_panic(expected = "delegation would exceed max chain depth")]
fn test_chain_depth_limit_above_max_chain_walk() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);

    let (contract_id, _token_addr) = setup(&env, &admin);
    let client = TokenVotesContractClient::new(&env, &contract_id);

    // Create a chain of exactly 64 hops: A0 -> A1 -> A2 -> ... -> A64
    // This is at the MAX_CHAIN_WALK boundary
    let mut addresses: Vec<Address> = Vec::new(&env);
    for i in 0..=64 {
        addresses.push_back(Address::generate(&env));
    }

    // Build the chain by delegating each address to the next
    for i in 0..64 {
        let current = addresses.get(i).unwrap();
        let next = addresses.get(i + 1).unwrap();
        set_ledger(&env, i as u32);
        client.delegate(current, next);
    }

    // Set the depth limit to 65 (above MAX_CHAIN_WALK)
    set_ledger(&env, 100);
    client.set_delegation_depth_limit(&admin, &65);

    // Verify the chain is exactly 64 hops
    let chain = client.get_delegation_chain(&addresses.get(0).unwrap());
    assert_eq!(chain.len(), 65); // 64 hops means 65 addresses in the chain

    // Now attempt to add one more hop by delegating a new address to A0
    // This would create a 65-hop chain: A_new -> A0 -> A1 -> ... -> A64
    // This should be rejected because it exceeds the configured limit of 65
    let new_address = Address::generate(&env);
    set_ledger(&env, 101);
    client.delegate(&new_address, &addresses.get(0).unwrap());
}
