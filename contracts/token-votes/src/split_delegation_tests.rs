//! Tests for split delegation (issue #994): percentage-based delegation
//! across multiple delegatees, interop with the legacy single-delegate path,
//! and registry bookkeeping for fractional contributions.

use crate::{SplitDelegation, TokenVotesContract, TokenVotesContractClient};
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{token, Address, Env, Vec};

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

fn splits(env: &Env, entries: &[(Address, u32)]) -> Vec<SplitDelegation> {
    let mut v = Vec::new(env);
    for (delegatee, weight_bps) in entries {
        v.push_back(SplitDelegation {
            delegatee: delegatee.clone(),
            weight_bps: *weight_bps,
        });
    }
    v
}

#[test]
fn test_two_way_split_divides_voting_power_with_no_rounding_loss() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let delegator = Address::generate(&env);
    let a = Address::generate(&env);
    let b = Address::generate(&env);

    let (contract_id, token_addr) = setup(&env, &admin);
    let client = TokenVotesContractClient::new(&env, &contract_id);
    token::StellarAssetClient::new(&env, &token_addr).mint(&delegator, &1001i128);

    set_ledger(&env, 10);
    client.delegate_split(&delegator, &splits(&env, &[(a.clone(), 6000), (b.clone(), 4000)]));

    let votes_a = client.get_votes(&a);
    let votes_b = client.get_votes(&b);
    assert_eq!(votes_a, 600);
    assert_eq!(votes_b, 401); // 40% of 1001 = 400.4, remainder credited to last entry
    assert_eq!(votes_a + votes_b, 1001);
}

#[test]
fn test_legacy_delegate_unchanged_after_split_module_added() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let delegator = Address::generate(&env);
    let a = Address::generate(&env);
    let b = Address::generate(&env);

    let (contract_id, token_addr) = setup(&env, &admin);
    let client = TokenVotesContractClient::new(&env, &contract_id);
    token::StellarAssetClient::new(&env, &token_addr).mint(&delegator, &1000i128);

    set_ledger(&env, 10);
    client.delegate(&delegator, &a);
    assert_eq!(client.get_votes(&a), 1000);
    assert_eq!(client.delegates(&delegator), Some(a.clone()));

    set_ledger(&env, 20);
    client.delegate(&delegator, &b);
    assert_eq!(client.get_votes(&a), 0);
    assert_eq!(client.get_votes(&b), 1000);
    assert_eq!(client.delegates(&delegator), Some(b));

    set_ledger(&env, 30);
    client.undelegate(&delegator);
    assert_eq!(client.get_votes(&delegator), 1000);
    assert_eq!(client.delegates(&delegator), Some(delegator.clone()));
}

#[test]
#[should_panic(expected = "Error(Contract, #21)")]
fn test_delegate_split_rejects_weights_not_summing_to_10000() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let delegator = Address::generate(&env);
    let a = Address::generate(&env);
    let b = Address::generate(&env);

    let (contract_id, token_addr) = setup(&env, &admin);
    let client = TokenVotesContractClient::new(&env, &contract_id);
    token::StellarAssetClient::new(&env, &token_addr).mint(&delegator, &1000i128);

    client.delegate_split(&delegator, &splits(&env, &[(a, 6000), (b, 3000)]));
}

#[test]
#[should_panic(expected = "Error(Contract, #19)")]
fn test_delegate_split_rejects_duplicate_delegatees() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let delegator = Address::generate(&env);
    let a = Address::generate(&env);

    let (contract_id, token_addr) = setup(&env, &admin);
    let client = TokenVotesContractClient::new(&env, &contract_id);
    token::StellarAssetClient::new(&env, &token_addr).mint(&delegator, &1000i128);

    client.delegate_split(&delegator, &splits(&env, &[(a.clone(), 5000), (a, 5000)]));
}

#[test]
#[should_panic(expected = "Error(Contract, #18)")]
fn test_delegate_split_rejects_more_entries_than_max_split_targets() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let delegator = Address::generate(&env);

    let (contract_id, token_addr) = setup(&env, &admin);
    let client = TokenVotesContractClient::new(&env, &contract_id);
    token::StellarAssetClient::new(&env, &token_addr).mint(&delegator, &1000i128);

    client.set_max_split_targets(&admin, &2);

    let a = Address::generate(&env);
    let b = Address::generate(&env);
    let c = Address::generate(&env);
    client.delegate_split(
        &delegator,
        &splits(&env, &[(a, 3400), (b, 3300), (c, 3300)]),
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #20)")]
fn test_delegate_split_rejects_zero_weight_entry() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let delegator = Address::generate(&env);
    let a = Address::generate(&env);
    let b = Address::generate(&env);

    let (contract_id, token_addr) = setup(&env, &admin);
    let client = TokenVotesContractClient::new(&env, &contract_id);
    token::StellarAssetClient::new(&env, &token_addr).mint(&delegator, &1000i128);

    client.delegate_split(&delegator, &splits(&env, &[(a, 0), (b, 10000)]));
}

#[test]
fn test_resplitting_replaces_not_merges_prior_split() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let delegator = Address::generate(&env);
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    let c = Address::generate(&env);

    let (contract_id, token_addr) = setup(&env, &admin);
    let client = TokenVotesContractClient::new(&env, &contract_id);
    token::StellarAssetClient::new(&env, &token_addr).mint(&delegator, &1000i128);

    set_ledger(&env, 10);
    client.delegate_split(&delegator, &splits(&env, &[(a.clone(), 5000), (b.clone(), 5000)]));
    assert_eq!(client.get_votes(&a), 500);
    assert_eq!(client.get_votes(&b), 500);

    set_ledger(&env, 20);
    client.delegate_split(&delegator, &splits(&env, &[(c.clone(), 10000)]));

    // Prior split fully removed, not merged with the new one.
    assert_eq!(client.get_votes(&a), 0);
    assert_eq!(client.get_votes(&b), 0);
    assert_eq!(client.get_votes(&c), 1000);

    let current = client.get_split_delegations(&delegator);
    assert_eq!(current.len(), 1);
    assert_eq!(current.get(0).unwrap().delegatee, c);
}

#[test]
fn test_undelegate_split_returns_full_power_across_all_prior_entries() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let delegator = Address::generate(&env);
    let a = Address::generate(&env);
    let b = Address::generate(&env);

    let (contract_id, token_addr) = setup(&env, &admin);
    let client = TokenVotesContractClient::new(&env, &contract_id);
    token::StellarAssetClient::new(&env, &token_addr).mint(&delegator, &1000i128);

    set_ledger(&env, 10);
    client.delegate_split(&delegator, &splits(&env, &[(a.clone(), 6000), (b.clone(), 4000)]));

    set_ledger(&env, 20);
    client.undelegate_split(&delegator);

    assert_eq!(client.get_votes(&a), 0);
    assert_eq!(client.get_votes(&b), 0);
    assert_eq!(client.get_votes(&delegator), 1000);
    assert_eq!(client.get_delegator_count(&a), 0);
    assert_eq!(client.get_delegator_count(&b), 0);
}

#[test]
fn test_delegator_count_and_received_delegations_reflect_fractional_split() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let delegator = Address::generate(&env);
    let a = Address::generate(&env);
    let b = Address::generate(&env);

    let (contract_id, token_addr) = setup(&env, &admin);
    let client = TokenVotesContractClient::new(&env, &contract_id);
    token::StellarAssetClient::new(&env, &token_addr).mint(&delegator, &1000i128);

    set_ledger(&env, 10);
    client.delegate_split(&delegator, &splits(&env, &[(a.clone(), 7000), (b.clone(), 3000)]));

    assert_eq!(client.get_delegator_count(&a), 1);
    assert_eq!(client.get_delegator_count(&b), 1);

    let received_a = client.get_received_delegations(&a, &0, &10);
    assert_eq!(received_a.len(), 1);
    assert_eq!(received_a.get(0).unwrap().delegator, delegator);
    assert_eq!(received_a.get(0).unwrap().voting_power_at_delegation, 700);

    let received_b = client.get_received_delegations(&b, &0, &10);
    assert_eq!(received_b.len(), 1);
    assert_eq!(received_b.get(0).unwrap().voting_power_at_delegation, 300);
}
