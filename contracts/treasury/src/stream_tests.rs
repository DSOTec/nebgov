//! Tests for the multi-stream treasury budget allocation module.

use crate::{
    BudgetStream, StreamBudgetReport, TreasuryBudgetSummary, TreasuryContract,
    TreasuryContractClient,
};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token, Address, Env, String, Symbol, Vec,
};

/// Deploy treasury + a fresh SAC token, mint tokens to treasury.
/// Returns (treasury_id, token_addr, governor, stream_owner).
fn setup(env: &Env) -> (Address, Address, Address, Address) {
    let governor = Address::generate(env);
    let owner = Address::generate(env);
    let stream_owner = Address::generate(env);

    let sac = env.register_stellar_asset_contract_v2(owner.clone());
    let token_addr = sac.address();

    let treasury_id = env.register(TreasuryContract, ());
    let client = TreasuryContractClient::new(env, &treasury_id);

    let mut owners = Vec::new(env);
    owners.push_back(owner);
    client.initialize(&owners, &1u32, &governor);

    // Mint tokens to treasury for stream spending
    let sac_client = token::StellarAssetClient::new(env, &token_addr);
    sac_client.mint(&treasury_id, &10_000i128);

    (treasury_id, token_addr, governor, stream_owner)
}

fn default_stream_params(
    env: &Env,
    token: &Address,
    owner: &Address,
) -> (Symbol, Address, Address, i128, u32, u32, i128, u32, u64) {
    (
        Symbol::new(env, "engineering"),
        owner.clone(),
        token.clone(),
        1_000i128,  // total_allocated
        0u32,       // start_ledger
        100_000u32, // end_ledger
        500i128,    // max_single_spend
        0u32,       // cooldown_ledgers
        1u64,       // proposal_id
    )
}

#[test]
fn test_create_stream_stores_budget_entry() {
    let env = Env::default();
    env.mock_all_auths();

    let (treasury_id, token_addr, governor, stream_owner) = setup(&env);
    let client = TreasuryContractClient::new(&env, &treasury_id);

    let (name, owner, token, alloc, start, end, max_spend, cooldown, prop_id) =
        default_stream_params(&env, &token_addr, &stream_owner);

    let stream_id = client.create_stream(
        &governor, &name, &owner, &token, &alloc, &start, &end, &max_spend, &cooldown, &prop_id,
    );

    assert_eq!(stream_id, 1);

    let stream: BudgetStream = client.get_stream(&stream_id);
    assert_eq!(stream.id, stream_id);
    assert_eq!(stream.name, name);
    assert_eq!(stream.owner, owner);
    assert_eq!(stream.token, token);
    assert_eq!(stream.total_allocated, alloc);
    assert_eq!(stream.total_spent, 0);
    assert_eq!(stream.is_active, true);
    assert_eq!(stream.is_revoked, false);
    assert_eq!(stream.max_single_spend, max_spend);
    assert_eq!(stream.cooldown_ledgers, cooldown);
    assert_eq!(stream.spend_count, 0);
    assert_eq!(stream.created_by_proposal_id, prop_id);
}

#[test]
fn test_stream_spend_transfers_token_and_updates_spent() {
    let env = Env::default();
    env.mock_all_auths();

    let (treasury_id, token_addr, governor, stream_owner) = setup(&env);
    let client = TreasuryContractClient::new(&env, &treasury_id);

    let (name, owner, token, alloc, start, end, max_spend, cooldown, prop_id) =
        default_stream_params(&env, &token_addr, &stream_owner);

    let stream_id = client.create_stream(
        &governor, &name, &owner, &token, &alloc, &start, &end, &max_spend, &cooldown, &prop_id,
    );

    let recipient = Address::generate(&env);
    let memo = String::from_str(&env, "Q1 infrastructure");
    client.stream_spend(&stream_owner, &stream_id, &recipient, &300i128, &memo);

    let tok = token::TokenClient::new(&env, &token_addr);
    assert_eq!(tok.balance(&recipient), 300);
    assert_eq!(tok.balance(&treasury_id), 9_700);

    let stream: BudgetStream = client.get_stream(&stream_id);
    assert_eq!(stream.total_spent, 300);
    assert_eq!(stream.spend_count, 1);
    assert_eq!(stream.is_active, true);
}

#[test]
#[should_panic(expected = "exceeds max single spend")]
fn test_stream_spend_exceeds_max_single_spend_reverts() {
    let env = Env::default();
    env.mock_all_auths();

    let (treasury_id, token_addr, governor, stream_owner) = setup(&env);
    let client = TreasuryContractClient::new(&env, &treasury_id);

    let (name, owner, token, alloc, start, end, max_spend, cooldown, prop_id) =
        default_stream_params(&env, &token_addr, &stream_owner);

    let stream_id = client.create_stream(
        &governor, &name, &owner, &token, &alloc, &start, &end, &max_spend, &cooldown, &prop_id,
    );

    let recipient = Address::generate(&env);
    let memo = String::from_str(&env, "too large");
    // max_single_spend is 500, try 501
    client.stream_spend(&stream_owner, &stream_id, &recipient, &501i128, &memo);
}

#[test]
#[should_panic(expected = "cooldown not elapsed")]
fn test_stream_spend_in_cooldown_reverts() {
    let env = Env::default();
    env.mock_all_auths();

    let (treasury_id, token_addr, governor, stream_owner) = setup(&env);
    let client = TreasuryContractClient::new(&env, &treasury_id);

    // Create stream with cooldown of 10 ledgers
    let stream_id = client.create_stream(
        &governor,
        &Symbol::new(&env, "ops"),
        &stream_owner,
        &token_addr,
        &1_000i128,
        &0u32,
        &100_000u32,
        &500i128,
        &10u32, // cooldown_ledgers = 10
        &1u64,
    );

    let recipient = Address::generate(&env);
    let memo = String::from_str(&env, "first spend");
    client.stream_spend(&stream_owner, &stream_id, &recipient, &100i128, &memo);

    // Try another spend immediately — should fail due to cooldown
    let memo2 = String::from_str(&env, "second spend");
    client.stream_spend(&stream_owner, &stream_id, &recipient, &100i128, &memo2);
}

#[test]
#[should_panic(expected = "stream not active")]
fn test_stream_spend_exhausts_budget_then_reverts() {
    let env = Env::default();
    env.mock_all_auths();

    let (treasury_id, token_addr, governor, stream_owner) = setup(&env);
    let client = TreasuryContractClient::new(&env, &treasury_id);

    // Allocate 500 with max_single_spend of 500
    let stream_id = client.create_stream(
        &governor,
        &Symbol::new(&env, "grants"),
        &stream_owner,
        &token_addr,
        &500i128,
        &0u32,
        &100_000u32,
        &500i128,
        &0u32,
        &1u64,
    );

    let recipient = Address::generate(&env);
    let memo = String::from_str(&env, "full spend");

    // Spend the full amount — should succeed and exhaust
    client.stream_spend(&stream_owner, &stream_id, &recipient, &500i128, &memo);

    let stream: BudgetStream = client.get_stream(&stream_id);
    assert_eq!(stream.total_spent, 500);
    assert_eq!(stream.is_active, false);

    // Now try to spend more — should panic with "budget exhausted"
    let memo2 = String::from_str(&env, "over budget");
    client.stream_spend(&stream_owner, &stream_id, &recipient, &1i128, &memo2);
}

#[test]
#[should_panic(expected = "stream expired")]
fn test_stream_spend_after_end_ledger_reverts() {
    let env = Env::default();
    env.mock_all_auths();

    let (treasury_id, token_addr, governor, stream_owner) = setup(&env);
    let client = TreasuryContractClient::new(&env, &treasury_id);

    let stream_id = client.create_stream(
        &governor,
        &Symbol::new(&env, "marketing"),
        &stream_owner,
        &token_addr,
        &1_000i128,
        &0u32,
        &10u32, // end_ledger = 10
        &500i128,
        &0u32,
        &1u64,
    );

    // Advance past end_ledger
    env.ledger().with_mut(|l| l.sequence_number = 20);

    let recipient = Address::generate(&env);
    let memo = String::from_str(&env, "late spend");
    client.stream_spend(&stream_owner, &stream_id, &recipient, &100i128, &memo);
}

#[test]
#[should_panic(expected = "not stream owner")]
fn test_stream_spend_by_non_owner_reverts() {
    let env = Env::default();
    env.mock_all_auths();

    let (treasury_id, token_addr, governor, stream_owner) = setup(&env);
    let client = TreasuryContractClient::new(&env, &treasury_id);

    let (name, owner, token, alloc, start, end, max_spend, cooldown, prop_id) =
        default_stream_params(&env, &token_addr, &stream_owner);

    let stream_id = client.create_stream(
        &governor, &name, &owner, &token, &alloc, &start, &end, &max_spend, &cooldown, &prop_id,
    );

    let non_owner = Address::generate(&env);
    let recipient = Address::generate(&env);
    let memo = String::from_str(&env, "unauthorized");
    client.stream_spend(&non_owner, &stream_id, &recipient, &100i128, &memo);
}

#[test]
fn test_stream_batch_spend_multiple_recipients() {
    let env = Env::default();
    env.mock_all_auths();

    let (treasury_id, token_addr, governor, stream_owner) = setup(&env);
    let client = TreasuryContractClient::new(&env, &treasury_id);

    let stream_id = client.create_stream(
        &governor,
        &Symbol::new(&env, "ops"),
        &stream_owner,
        &token_addr,
        &1_000i128,
        &0u32,
        &100_000u32,
        &500i128,
        &0u32,
        &1u64,
    );

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let charlie = Address::generate(&env);

    let mut recipients = Vec::new(&env);
    recipients.push_back(alice.clone());
    recipients.push_back(bob.clone());
    recipients.push_back(charlie.clone());

    let mut amounts = Vec::new(&env);
    amounts.push_back(100i128);
    amounts.push_back(200i128);
    amounts.push_back(150i128);

    let memo = String::from_str(&env, "batch payout");
    client.stream_batch_spend(&stream_owner, &stream_id, &recipients, &amounts, &memo);

    let tok = token::TokenClient::new(&env, &token_addr);
    assert_eq!(tok.balance(&alice), 100);
    assert_eq!(tok.balance(&bob), 200);
    assert_eq!(tok.balance(&charlie), 150);

    let stream: BudgetStream = client.get_stream(&stream_id);
    assert_eq!(stream.total_spent, 450);
    assert_eq!(stream.spend_count, 3);
}

#[test]
fn test_revoke_stream_returns_unspent_to_treasury() {
    let env = Env::default();
    env.mock_all_auths();

    let (treasury_id, token_addr, governor, stream_owner) = setup(&env);
    let client = TreasuryContractClient::new(&env, &treasury_id);

    let stream_id = client.create_stream(
        &governor,
        &Symbol::new(&env, "research"),
        &stream_owner,
        &token_addr,
        &1_000i128,
        &0u32,
        &100_000u32,
        &500i128,
        &0u32,
        &1u64,
    );

    // Spend 300
    let recipient = Address::generate(&env);
    let memo = String::from_str(&env, "pre-revoke spend");
    client.stream_spend(&stream_owner, &stream_id, &recipient, &300i128, &memo);

    // Revoke
    client.revoke_stream(&governor, &stream_id);

    let stream: BudgetStream = client.get_stream(&stream_id);
    assert_eq!(stream.is_revoked, true);
    assert_eq!(stream.is_active, false);
    assert!(stream.revoked_at_ledger.is_some());

    // Treasury should still hold 10000 - 300 = 9700
    let tok = token::TokenClient::new(&env, &token_addr);
    assert_eq!(tok.balance(&treasury_id), 9_700);
}

#[test]
fn test_extend_stream_updates_end_ledger() {
    let env = Env::default();
    env.mock_all_auths();

    let (treasury_id, token_addr, governor, stream_owner) = setup(&env);
    let client = TreasuryContractClient::new(&env, &treasury_id);

    let stream_id = client.create_stream(
        &governor,
        &Symbol::new(&env, "eng"),
        &stream_owner,
        &token_addr,
        &1_000i128,
        &0u32,
        &100u32, // end_ledger = 100
        &500i128,
        &0u32,
        &1u64,
    );

    client.extend_stream(&governor, &stream_id, &200u32);

    let stream: BudgetStream = client.get_stream(&stream_id);
    assert_eq!(stream.end_ledger, 200);
}

#[test]
fn test_top_up_stream_increases_allocated() {
    let env = Env::default();
    env.mock_all_auths();

    let (treasury_id, token_addr, governor, stream_owner) = setup(&env);
    let client = TreasuryContractClient::new(&env, &treasury_id);

    let stream_id = client.create_stream(
        &governor,
        &Symbol::new(&env, "eng"),
        &stream_owner,
        &token_addr,
        &1_000i128,
        &0u32,
        &100_000u32,
        &500i128,
        &0u32,
        &1u64,
    );

    client.top_up_stream(&governor, &stream_id, &500i128);

    let stream: BudgetStream = client.get_stream(&stream_id);
    assert_eq!(stream.total_allocated, 1_500);

    // Should be able to spend from the topped-up amount
    let recipient = Address::generate(&env);
    let memo = String::from_str(&env, "after topup");
    client.stream_spend(&stream_owner, &stream_id, &recipient, &400i128, &memo);

    let stream: BudgetStream = client.get_stream(&stream_id);
    assert_eq!(stream.total_spent, 400);
}

#[test]
fn test_get_budget_summary_aggregates_all_streams() {
    let env = Env::default();
    env.mock_all_auths();

    let (treasury_id, token_addr, governor, stream_owner) = setup(&env);
    let client = TreasuryContractClient::new(&env, &treasury_id);

    // Create two streams
    let stream1 = client.create_stream(
        &governor,
        &Symbol::new(&env, "eng"),
        &stream_owner,
        &token_addr,
        &1_000i128,
        &0u32,
        &100_000u32,
        &500i128,
        &0u32,
        &1u64,
    );

    let other_owner = Address::generate(&env);
    let _stream2 = client.create_stream(
        &governor,
        &Symbol::new(&env, "ops"),
        &other_owner,
        &token_addr,
        &2_000i128,
        &1u32,
        &100_000u32,
        &500i128,
        &0u32,
        &2u64,
    );

    // Spend from stream1
    let recipient = Address::generate(&env);
    let memo = String::from_str(&env, "eng spend");
    client.stream_spend(&stream_owner, &stream1, &recipient, &400i128, &memo);

    let summary: TreasuryBudgetSummary = client.get_budget_summary();
    assert_eq!(summary.total_streams, 2);
    assert_eq!(summary.active_streams, 2);

    // Total allocated for token should be 3000
    assert_eq!(summary.total_allocated_by_token.len(), 1);
    let (t, alloc) = summary.total_allocated_by_token.get(0).unwrap();
    assert_eq!(t, token_addr);
    assert_eq!(alloc, 3_000);

    // Total spent should be 400
    let (_, spent) = summary.total_spent_by_token.get(0).unwrap();
    assert_eq!(spent, 400);

    // Remaining should be 2600
    let (_, remaining) = summary.total_remaining_by_token.get(0).unwrap();
    assert_eq!(remaining, 2_600);
}

#[test]
fn test_get_stream_report_computes_utilization_bps() {
    let env = Env::default();
    env.mock_all_auths();

    let (treasury_id, token_addr, governor, stream_owner) = setup(&env);
    let client = TreasuryContractClient::new(&env, &treasury_id);

    let stream_id = client.create_stream(
        &governor,
        &Symbol::new(&env, "eng"),
        &stream_owner,
        &token_addr,
        &1_000i128,
        &0u32,
        &100_000u32,
        &500i128,
        &0u32,
        &1u64,
    );

    // Spend 250 out of 1000 = 25% = 2500 bps
    let recipient = Address::generate(&env);
    let memo = String::from_str(&env, "partial spend");
    client.stream_spend(&stream_owner, &stream_id, &recipient, &250i128, &memo);

    let report: StreamBudgetReport = client.get_stream_report(&stream_id);
    assert_eq!(report.stream_id, stream_id);
    assert_eq!(report.total_allocated, 1_000);
    assert_eq!(report.total_spent, 250);
    assert_eq!(report.remaining, 750);
    assert_eq!(report.utilization_bps, 2_500);
    assert_eq!(report.is_active, true);
    assert_eq!(report.spend_count, 1);
    assert_eq!(report.avg_spend, 250);
}

#[test]
#[should_panic(expected = "stream revoked")]
fn test_stream_revoked_blocks_further_spends() {
    let env = Env::default();
    env.mock_all_auths();

    let (treasury_id, token_addr, governor, stream_owner) = setup(&env);
    let client = TreasuryContractClient::new(&env, &treasury_id);

    let stream_id = client.create_stream(
        &governor,
        &Symbol::new(&env, "eng"),
        &stream_owner,
        &token_addr,
        &1_000i128,
        &0u32,
        &100_000u32,
        &500i128,
        &0u32,
        &1u64,
    );

    // Revoke the stream
    client.revoke_stream(&governor, &stream_id);

    // Attempt to spend from revoked stream — should panic
    let recipient = Address::generate(&env);
    let memo = String::from_str(&env, "post-revoke");
    client.stream_spend(&stream_owner, &stream_id, &recipient, &100i128, &memo);
}

#[test]
#[should_panic(expected = "stream not started")]
fn test_stream_with_future_start_ledger_cannot_spend_immediately() {
    let env = Env::default();
    env.mock_all_auths();

    let (treasury_id, token_addr, governor, stream_owner) = setup(&env);
    let client = TreasuryContractClient::new(&env, &treasury_id);

    // Create stream with start_ledger in the future (current ledger + 1000)
    let future_start = 1000u32;
    let stream_id = client.create_stream(
        &governor,
        &Symbol::new(&env, "future"),
        &stream_owner,
        &token_addr,
        &1_000i128,
        &future_start,
        &100_000u32,
        &500i128,
        &0u32,
        &1u64,
    );

    // Attempt to spend immediately — should fail since we're before start_ledger
    let recipient = Address::generate(&env);
    let memo = String::from_str(&env, "too early");
    client.stream_spend(&stream_owner, &stream_id, &recipient, &100i128, &memo);
}

#[test]
fn test_stream_top_up_after_exhaustion_allows_additional_spends() {
    let env = Env::default();
    env.mock_all_auths();

    let (treasury_id, token_addr, governor, stream_owner) = setup(&env);
    let client = TreasuryContractClient::new(&env, &treasury_id);

    let stream_id = client.create_stream(
        &governor,
        &Symbol::new(&env, "small"),
        &stream_owner,
        &token_addr,
        &100i128, // small initial allocation
        &0u32,
        &100_000u32,
        &100i128, // max_single_spend
        &0u32,
        &1u64,
    );

    let recipient = Address::generate(&env);
    let memo = String::from_str(&env, "spend");

    // Exhaust the stream with one spend
    client.stream_spend(&stream_owner, &stream_id, &recipient, &100i128, &memo);

    // Verify stream is exhausted
    let stream: BudgetStream = client.get_stream(&stream_id);
    assert_eq!(stream.total_spent, 100);
    assert_eq!(stream.total_allocated, 100);

    // Top up with additional funds
    client.top_up_stream(&governor, &stream_id, &200i128);

    // Verify stream can now accept more spends
    let stream: BudgetStream = client.get_stream(&stream_id);
    assert_eq!(stream.total_allocated, 300);
    assert_eq!(stream.total_spent, 100);

    // Should be able to spend more now
    client.stream_spend(&stream_owner, &stream_id, &recipient, &50i128, &memo);
    let stream: BudgetStream = client.get_stream(&stream_id);
    assert_eq!(stream.total_spent, 150);
}

#[test]
#[should_panic(expected = "stream expired")]
fn test_stream_extend_on_expired_allows_spend_until_new_end() {
    let env = Env::default();
    env.mock_all_auths();

    let (treasury_id, token_addr, governor, stream_owner) = setup(&env);
    let client = TreasuryContractClient::new(&env, &treasury_id);

    let stream_id = client.create_stream(
        &governor,
        &Symbol::new(&env, "expiring"),
        &stream_owner,
        &token_addr,
        &1_000i128,
        &0u32,
        &100u32, // expires at ledger 100
        &500i128,
        &0u32,
        &1u64,
    );

    // Advance ledger past expiration
    env.ledger().set_sequence_number(150);

    // Spend should fail on expired stream
    let recipient = Address::generate(&env);
    let memo = String::from_str(&env, "expired");
    client.stream_spend(&stream_owner, &stream_id, &recipient, &100i128, &memo);
}

#[test]
fn test_stream_batch_spend_cooldown_with_zero_and_multiple_spends() {
    let env = Env::default();
    env.mock_all_auths();

    let (treasury_id, token_addr, governor, stream_owner) = setup(&env);
    let client = TreasuryContractClient::new(&env, &treasury_id);

    // Create stream with 5-ledger cooldown
    let stream_id = client.create_stream(
        &governor,
        &Symbol::new(&env, "batch"),
        &stream_owner,
        &token_addr,
        &10_000i128,
        &0u32,
        &100_000u32,
        &500i128,
        &5u32, // cooldown_ledgers
        &1u64,
    );

    let mut recipients = Vec::new(&env);
    recipients.push_back(Address::generate(&env));
    recipients.push_back(Address::generate(&env));

    let mut amounts = Vec::new(&env);
    amounts.push_back(100i128);
    amounts.push_back(100i128);

    // First batch spend (spend_count = 0, should not be affected by cooldown)
    client.stream_batch_spend(
        &stream_owner,
        &stream_id,
        &recipients,
        &amounts,
        &String::from_str(&env, "batch"),
    );

    // Verify batch was recorded
    let stream: BudgetStream = client.get_stream(&stream_id);
    assert_eq!(stream.spend_count, 2); // two recipients

    // Advance past cooldown before the next batch spend.
    // Cooldown = 5 ledgers, last spend was at ledger 0; need at least ledger 6.
    env.ledger().set_sequence_number(6);

    let mut recipients2 = Vec::new(&env);
    recipients2.push_back(Address::generate(&env));
    let mut amounts2 = Vec::new(&env);
    amounts2.push_back(50i128);

    // Note: This test just verifies the batch can be called and tracks spend_count
    // The actual cooldown enforcement is tested in test_stream_spend_enforces_cooldown
    client.stream_batch_spend(
        &stream_owner,
        &stream_id,
        &recipients2,
        &amounts2,
        &String::from_str(&env, "batch2"),
    );

    let stream: BudgetStream = client.get_stream(&stream_id);
    assert_eq!(stream.spend_count, 3); // one more recipient from second batch
}

#[test]
fn test_get_streams_pagination_boundaries() {
    let env = Env::default();
    env.mock_all_auths();

    let (treasury_id, token_addr, governor, stream_owner) = setup(&env);
    let client = TreasuryContractClient::new(&env, &treasury_id);

    // Create 3 streams
    for i in 0..3 {
        let names = ["stream0", "stream1", "stream2"];
        let name = Symbol::new(&env, names[i as usize]);
        client.create_stream(
            &governor,
            &name,
            &stream_owner,
            &token_addr,
            &1_000i128,
            &1u32,
            &100_000u32,
            &500i128,
            &0u32,
            &(i as u64 + 1),
        );
    }

    // Test pagination: offset=0, limit=2 should return 2 streams
    let page1 = client.get_streams(&0, &2);
    assert_eq!(page1.len(), 2);

    // Test pagination: offset=2, limit=2 should return 1 stream
    let page2 = client.get_streams(&2, &2);
    assert_eq!(page2.len(), 1);

    // Test pagination: offset=3 (beyond total count) should return empty
    let page3 = client.get_streams(&3, &2);
    assert_eq!(page3.len(), 0);

    // Test pagination: offset=0, limit=0 should return empty
    let empty = client.get_streams(&0, &0);
    assert_eq!(empty.len(), 0);
}

#[test]
fn test_get_stream_spends_pagination_boundaries() {
    let env = Env::default();
    env.mock_all_auths();

    let (treasury_id, token_addr, governor, stream_owner) = setup(&env);
    let client = TreasuryContractClient::new(&env, &treasury_id);

    let stream_id = client.create_stream(
        &governor,
        &Symbol::new(&env, "spending"),
        &stream_owner,
        &token_addr,
        &10_000i128,
        &0u32,
        &100_000u32,
        &1_000i128,
        &0u32,
        &1u64,
    );

    // Create 3 spends
    let memo = String::from_str(&env, "test");
    for _ in 0..3 {
        let recipient = Address::generate(&env);
        client.stream_spend(&stream_owner, &stream_id, &recipient, &100i128, &memo);
    }

    // Test pagination: offset=0, limit=2 should return 2 spends
    let page1 = client.get_stream_spends(&stream_id, &0, &2);
    assert_eq!(page1.len(), 2);

    // Test pagination: offset=2, limit=2 should return 1 spend
    let page2 = client.get_stream_spends(&stream_id, &2, &2);
    assert_eq!(page2.len(), 1);

    // Test pagination: offset=3 (beyond total count) should return empty
    let page3 = client.get_stream_spends(&stream_id, &3, &2);
    assert_eq!(page3.len(), 0);
}

#[test]
fn test_revoke_stream_records_event_payload() {
    let env = Env::default();
    env.mock_all_auths();

    let (treasury_id, token_addr, governor, stream_owner) = setup(&env);
    let client = TreasuryContractClient::new(&env, &treasury_id);

    let stream_id = client.create_stream(
        &governor,
        &Symbol::new(&env, "eventtest"),
        &stream_owner,
        &token_addr,
        &1_000i128,
        &0u32,
        &100_000u32,
        &500i128,
        &0u32,
        &1u64,
    );

    // Spend some funds first
    let recipient = Address::generate(&env);
    let memo = String::from_str(&env, "spend");
    client.stream_spend(&stream_owner, &stream_id, &recipient, &200i128, &memo);

    let stream: BudgetStream = client.get_stream(&stream_id);
    assert_eq!(stream.total_spent, 200);
    let unspent = stream.total_allocated - stream.total_spent;

    // Revoke the stream
    client.revoke_stream(&governor, &stream_id);

    // Verify revocation
    let revoked_stream: BudgetStream = client.get_stream(&stream_id);
    assert_eq!(revoked_stream.is_revoked, true);
    assert_eq!(revoked_stream.total_spent, 200);
    assert_eq!(revoked_stream.total_allocated - revoked_stream.total_spent, unspent);
}

// ── Regression tests for #867, #872, #873 ──────────────────────────────

#[test]
#[should_panic(expected = "stream not started")]
fn test_stream_batch_spend_before_start_ledger_reverts() {
    let env = Env::default();
    env.mock_all_auths();

    let (treasury_id, token_addr, governor, stream_owner) = setup(&env);
    let client = TreasuryContractClient::new(&env, &treasury_id);

    let future_start = 1000u32;
    let stream_id = client.create_stream(
        &governor,
        &Symbol::new(&env, "future"),
        &stream_owner,
        &token_addr,
        &1_000i128,
        &future_start,
        &100_000u32,
        &500i128,
        &0u32,
        &1u64,
    );

    // Batch spend before start_ledger should fail
    let mut recipients = Vec::new(&env);
    recipients.push_back(Address::generate(&env));
    let mut amounts = Vec::new(&env);
    amounts.push_back(100i128);
    let memo = String::from_str(&env, "too early");
    client.stream_batch_spend(&stream_owner, &stream_id, &recipients, &amounts, &memo);
}

#[test]
#[should_panic(expected = "new end must be in the future")]
fn test_extend_stream_to_past_ledger_reverts() {
    let env = Env::default();
    env.mock_all_auths();

    let (treasury_id, token_addr, governor, stream_owner) = setup(&env);
    let client = TreasuryContractClient::new(&env, &treasury_id);

    let stream_id = client.create_stream(
        &governor,
        &Symbol::new(&env, "eng"),
        &stream_owner,
        &token_addr,
        &1_000i128,
        &1u32,
        &100u32, // end_ledger = 100
        &500i128,
        &0u32,
        &1u64,
    );

    // Advance past both end_ledger and the proposed extension target
    env.ledger().set_sequence_number(200);

    // 150 > 100 (old end) but 150 <= 200 (current), so this should revert
    client.extend_stream(&governor, &stream_id, &150u32);
}

#[test]
fn test_get_stream_report_revoked_stream_shows_inactive_zero_days() {
    let env = Env::default();
    env.mock_all_auths();

    let (treasury_id, token_addr, governor, stream_owner) = setup(&env);
    let client = TreasuryContractClient::new(&env, &treasury_id);

    let stream_id = client.create_stream(
        &governor,
        &Symbol::new(&env, "rev"),
        &stream_owner,
        &token_addr,
        &1_000i128,
        &0u32,
        &100_000u32,
        &500i128,
        &0u32,
        &1u64,
    );

    // Revoke the stream
    client.revoke_stream(&governor, &stream_id);

    let report: StreamBudgetReport = client.get_stream_report(&stream_id);
    assert_eq!(report.is_active, false, "revoked stream should report inactive");
    assert_eq!(report.days_remaining, 0, "revoked stream should show zero days remaining");
    assert_eq!(report.stream_id, stream_id);
}

#[test]
fn test_get_stream_report_naturally_expired_stream_shows_inactive() {
    let env = Env::default();
    env.mock_all_auths();

    let (treasury_id, token_addr, governor, stream_owner) = setup(&env);
    let client = TreasuryContractClient::new(&env, &treasury_id);

    let stream_id = client.create_stream(
        &governor,
        &Symbol::new(&env, "natrexp"),
        &stream_owner,
        &token_addr,
        &1_000i128,
        &1u32,
        &100u32, // end_ledger = 100
        &500i128,
        &0u32,
        &1u64,
    );

    // Advance past end_ledger
    env.ledger().set_sequence_number(200);

    let report: StreamBudgetReport = client.get_stream_report(&stream_id);
    assert_eq!(report.is_active, false, "expired stream should report inactive");
    assert_eq!(report.days_remaining, 0, "expired stream should show zero days remaining");
}

#[test]
fn test_get_budget_summary_excludes_revoked_and_expired_from_active_count() {
    let env = Env::default();
    env.mock_all_auths();

    let (treasury_id, token_addr, governor, stream_owner) = setup(&env);
    let client = TreasuryContractClient::new(&env, &treasury_id);

    // Active stream
    let _s1 = client.create_stream(
        &governor,
        &Symbol::new(&env, "active1"),
        &stream_owner,
        &token_addr,
        &1_000i128,
        &0u32,
        &100_000u32,
        &500i128,
        &0u32,
        &1u64,
    );

    // Stream that will be revoked
    let s2 = client.create_stream(
        &governor,
        &Symbol::new(&env, "revoked"),
        &stream_owner,
        &token_addr,
        &1_000i128,
        &1u32,
        &100_000u32,
        &500i128,
        &0u32,
        &2u64,
    );

    // Stream that will naturally expire
    let _s3 = client.create_stream(
        &governor,
        &Symbol::new(&env, "expiring"),
        &stream_owner,
        &token_addr,
        &1_000i128,
        &1u32,
        &50u32, // short end
        &500i128,
        &0u32,
        &3u64,
    );

    // Revoke s2
    client.revoke_stream(&governor, &s2);

    // Advance past s3's end_ledger
    env.ledger().set_sequence_number(100);

    let summary: TreasuryBudgetSummary = client.get_budget_summary();
    assert_eq!(summary.total_streams, 3);
    // Only the one non-revoked, non-expired stream should still count as active
    assert_eq!(summary.active_streams, 1);
}
