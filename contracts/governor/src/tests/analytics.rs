//! Tests for the Governance Analytics Module (Issue #765).
//!
//! Mirrors the harness pattern established in `tests/reputation.rs`: a
//! minimal configurable votes mock gives full control over voting power and
//! total supply so participation/quorum math is deterministic, and most
//! tests drive the real `GovernorContractClient` end-to-end (propose → vote
//! → queue/execute/expire) to verify the analytics wiring at each call site.

use crate::{GovernorContract, GovernorContractClient, ProposalState, VoteSupport, VoteType};
use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::{Address as _, Ledger as _},
    Address, Bytes, Env, String, Symbol,
};
use sorogov_timelock::{TimelockContract, TimelockContractClient};

#[contracttype]
#[derive(Clone)]
enum VotesKey {
    Votes(Address),
    TotalSupply,
}

#[contract]
pub struct AnalyticsTestVotesContract;

#[contractimpl]
impl AnalyticsTestVotesContract {
    pub fn set_votes(env: Env, account: Address, votes: i128) {
        env.storage().instance().set(&VotesKey::Votes(account), &votes);
    }

    pub fn set_total_supply(env: Env, supply: i128) {
        env.storage().instance().set(&VotesKey::TotalSupply, &supply);
    }

    pub fn get_votes(env: Env, account: Address) -> i128 {
        env.storage()
            .instance()
            .get(&VotesKey::Votes(account))
            .unwrap_or(0)
    }

    pub fn get_past_votes(env: Env, account: Address, _ledger: u32) -> i128 {
        Self::get_votes(env, account)
    }

    pub fn get_past_total_supply(env: Env, _ledger: u32) -> i128 {
        env.storage()
            .instance()
            .get(&VotesKey::TotalSupply)
            .unwrap_or(0)
    }

    pub fn token(env: Env) -> Address {
        Address::generate(&env)
    }
}

#[contract]
pub struct AnalyticsMockTarget;

#[contractimpl]
impl AnalyticsMockTarget {
    pub fn exec_gov(_env: Env) {}
}

struct Harness {
    env: Env,
    governor: GovernorContractClient<'static>,
    votes: AnalyticsTestVotesContractClient<'static>,
}

/// Total supply is fixed at 10,000 across all tests; individual voter/
/// proposer voting power is set per-test via `Harness::votes.set_votes`.
fn setup(
    voting_delay: u32,
    voting_period: u32,
    quorum_numerator: u32,
    proposal_grace_period: u32,
) -> Harness {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let votes_id = env.register(AnalyticsTestVotesContract, ());
    let votes = AnalyticsTestVotesContractClient::new(&env, &votes_id);
    votes.set_total_supply(&10_000i128);

    let timelock_id = env.register(TimelockContract, ());
    let governor_id = env.register(GovernorContract, ());
    let timelock = TimelockContractClient::new(&env, &timelock_id);
    let governor = GovernorContractClient::new(&env, &governor_id);

    timelock.initialize(&admin, &governor_id, &1u64, &1_209_600u64);

    let guardian = Address::generate(&env);
    governor.initialize(
        &admin,
        &votes_id,
        &timelock_id,
        &voting_delay,
        &voting_period,
        &quorum_numerator,
        &0i128,
        &guardian,
        &VoteType::Extended,
        &proposal_grace_period,
    );

    Harness { env, governor, votes }
}

fn propose_dummy(env: &Env, governor: &GovernorContractClient, proposer: &Address, seed: &[u8]) -> u64 {
    let target = Address::generate(env);
    let fn_name = Symbol::new(env, "exec");
    let calldata = Bytes::new(env);
    let description = String::from_str(env, "Analytics test proposal");
    let description_hash = env.crypto().sha256(&Bytes::from_slice(env, seed)).into();
    let metadata_uri = String::from_str(env, "ipfs://analytics-test");

    let mut targets = soroban_sdk::Vec::new(env);
    targets.push_back(target);
    let mut fn_names = soroban_sdk::Vec::new(env);
    fn_names.push_back(fn_name);
    let mut calldatas = soroban_sdk::Vec::new(env);
    calldatas.push_back(calldata);

    governor.propose(
        proposer,
        &description,
        &description_hash,
        &metadata_uri,
        &targets,
        &fn_names,
        &calldatas,
    )
}

/// Like `propose_dummy`, but targets a real deployed `AnalyticsMockTarget`
/// contract with a callable `exec_gov` fn — required for tests that drive
/// the proposal all the way through `execute()`, since the real timelock
/// actually invokes the target.
fn propose_executable(
    env: &Env,
    governor: &GovernorContractClient,
    proposer: &Address,
    target: &Address,
    seed: &[u8],
) -> u64 {
    let fn_name = Symbol::new(env, "exec_gov");
    let calldata = Bytes::new(env);
    let description = String::from_str(env, "Analytics executable test proposal");
    let description_hash = env.crypto().sha256(&Bytes::from_slice(env, seed)).into();
    let metadata_uri = String::from_str(env, "ipfs://analytics-test");

    let mut targets = soroban_sdk::Vec::new(env);
    targets.push_back(target.clone());
    let mut fn_names = soroban_sdk::Vec::new(env);
    fn_names.push_back(fn_name);
    let mut calldatas = soroban_sdk::Vec::new(env);
    calldatas.push_back(calldata);

    governor.propose(
        proposer,
        &description,
        &description_hash,
        &metadata_uri,
        &targets,
        &fn_names,
        &calldatas,
    )
}

#[test]
fn test_take_snapshot_after_zero_proposals_returns_zeroed_fields() {
    let h = setup(10, 20, 20, 120_960);
    let caller = Address::generate(&h.env);

    let snapshot = h.governor.take_analytics_snapshot(&caller);

    assert_eq!(snapshot.participation_bps, 0);

    let stats = h.governor.get_all_time_stats();
    assert_eq!(stats.total_proposals, 0);
    assert_eq!(stats.total_votes_cast, 0);
    assert_eq!(stats.unique_voters, 0);
    assert_eq!(stats.pass_rate_bps, 0);
}

#[test]
fn test_take_snapshot_captures_correct_participation() {
    let h = setup(10, 20, 20, 120_960);
    let proposer = Address::generate(&h.env);
    h.votes.set_votes(&proposer, &100_000i128);
    let voter_a = Address::generate(&h.env);
    let voter_b = Address::generate(&h.env);
    h.votes.set_votes(&voter_a, &2_000i128);
    h.votes.set_votes(&voter_b, &1_000i128);

    let proposal_id = propose_dummy(&h.env, &h.governor, &proposer, b"snap-1");
    h.env.ledger().with_mut(|l| l.sequence_number = 11);
    h.governor.cast_vote(&voter_a, &proposal_id, &VoteSupport::For);
    h.governor.cast_vote(&voter_b, &proposal_id, &VoteSupport::Against);

    let caller = Address::generate(&h.env);
    let snapshot = h.governor.take_analytics_snapshot(&caller);

    // 3000 / 10000 supply = 3000 bps.
    assert_eq!(snapshot.participation_bps, 3_000);

    let stats = h.governor.get_all_time_stats();
    assert_eq!(stats.total_proposals, 1);
    assert_eq!(stats.total_votes_cast, 3_000);
    assert_eq!(stats.unique_voters, 2);
}

#[test]
fn test_take_snapshot_reflects_ledger_it_was_taken_at() {
    // The on-chain snapshot mechanism doesn't persist history (the indexer
    // materializes it from the AnalyticsSnapshotTaken event instead) — this
    // just verifies take_analytics_snapshot reports the current ledger each
    // time it's called, independently of call order/count.
    let h = setup(10, 20, 20, 120_960);
    let caller = Address::generate(&h.env);

    h.env.ledger().with_mut(|l| l.sequence_number = 100);
    let snap1 = h.governor.take_analytics_snapshot(&caller);
    assert_eq!(snap1.ledger, 100);

    h.env.ledger().with_mut(|l| l.sequence_number = 200);
    let snap2 = h.governor.take_analytics_snapshot(&caller);
    assert_eq!(snap2.ledger, 200);
}

#[test]
fn test_all_time_stats_accumulates_votes_across_multiple_proposals() {
    let h = setup(10, 20, 0, 120_960);
    let proposer = Address::generate(&h.env);
    h.votes.set_votes(&proposer, &100_000i128);
    let voter = Address::generate(&h.env);
    h.votes.set_votes(&voter, &500i128);

    let proposal_id1 = propose_dummy(&h.env, &h.governor, &proposer, b"vh-1");
    h.env.ledger().with_mut(|l| l.sequence_number = 11);
    h.governor.cast_vote(&voter, &proposal_id1, &VoteSupport::For);

    let stats = h.governor.get_all_time_stats();
    assert_eq!(stats.total_votes_cast, 500);
    assert_eq!(stats.unique_voters, 1);

    // Advance past the default 100-ledger proposal cooldown before the same
    // proposer can create a second proposal.
    h.env.ledger().with_mut(|l| l.sequence_number = 200);
    let proposal_id2 = propose_dummy(&h.env, &h.governor, &proposer, b"vh-2");
    h.env.ledger().with_mut(|l| l.sequence_number = 211);
    h.governor
        .cast_vote(&voter, &proposal_id2, &VoteSupport::Against);

    let stats = h.governor.get_all_time_stats();
    assert_eq!(stats.total_votes_cast, 1_000);
    // Same voter across both proposals — still counted once.
    assert_eq!(stats.unique_voters, 1);
}

#[test]
fn test_proposal_participation_reflects_quorum_reached() {
    let h = setup(10, 20, 20, 120_960);
    let proposer = Address::generate(&h.env);
    h.votes.set_votes(&proposer, &100_000i128);
    let voter_a = Address::generate(&h.env);
    let voter_b = Address::generate(&h.env);
    h.votes.set_votes(&voter_a, &1_500i128);
    h.votes.set_votes(&voter_b, &1_000i128);

    let proposal_id = propose_dummy(&h.env, &h.governor, &proposer, b"part-1");
    h.env.ledger().with_mut(|l| l.sequence_number = 11);
    h.governor.cast_vote(&voter_a, &proposal_id, &VoteSupport::For);

    // Below quorum (2000 required, only 1500 for).
    let participation = h.governor.get_proposal_participation(&proposal_id);
    assert_eq!(participation.proposal_id, proposal_id);
    assert_eq!(participation.quorum_required, 2_000);
    assert_eq!(participation.total_votes_cast, 1_500);
    assert!(!participation.quorum_reached);

    h.governor.cast_vote(&voter_b, &proposal_id, &VoteSupport::Abstain);

    let participation = h.governor.get_proposal_participation(&proposal_id);
    assert_eq!(participation.total_votes_cast, 2_500);
    assert!(participation.quorum_reached);
}

#[test]
fn test_all_time_stats_increments_pass_count_on_execute() {
    let h = setup(10, 20, 20, 120_960);
    let proposer = Address::generate(&h.env);
    h.votes.set_votes(&proposer, &100_000i128);
    let voter_a = Address::generate(&h.env);
    let voter_b = Address::generate(&h.env);
    h.votes.set_votes(&voter_a, &2_000i128);
    h.votes.set_votes(&voter_b, &2_000i128);
    let target = h.env.register(AnalyticsMockTarget, ());

    let proposal_id = propose_executable(&h.env, &h.governor, &proposer, &target, b"execute-1");
    h.env.ledger().with_mut(|l| l.sequence_number = 11);
    h.governor.cast_vote(&voter_a, &proposal_id, &VoteSupport::For);
    h.governor.cast_vote(&voter_b, &proposal_id, &VoteSupport::For);

    h.env.ledger().with_mut(|l| l.sequence_number = 31);
    assert_eq!(h.governor.state(&proposal_id), ProposalState::Succeeded);
    h.governor.queue(&proposal_id);

    let stats = h.governor.get_all_time_stats();
    assert_eq!(stats.total_proposals, 1);
    assert_eq!(stats.quorum_hit_count, 1);
    assert_eq!(stats.pass_rate_bps, 10_000);

    // Advance past the timelock delay and execute.
    h.env.ledger().with_mut(|l| l.timestamp += 2);
    h.governor.execute(&proposal_id);

    let stats = h.governor.get_all_time_stats();
    assert_eq!(stats.total_votes_cast, 4_000);
    assert_eq!(stats.unique_voters, 2);
    // pass_rate_bps is derived from resolved (queue-time) outcomes, not
    // execute() — execute() only bumps the separate executed counter, so
    // a single Succeeded resolution still yields a 100% pass rate.
    assert_eq!(stats.pass_rate_bps, 10_000);
    assert_eq!(h.governor.state(&proposal_id), ProposalState::Executed);
}

#[test]
fn test_all_time_stats_tracks_defeated_proposal() {
    let h = setup(10, 20, 20, 120_960);
    let proposer = Address::generate(&h.env);
    h.votes.set_votes(&proposer, &100_000i128);
    let voter = Address::generate(&h.env);
    h.votes.set_votes(&voter, &500i128); // below the 2000 quorum requirement

    let proposal_id = propose_dummy(&h.env, &h.governor, &proposer, b"defeat-1");
    h.env.ledger().with_mut(|l| l.sequence_number = 11);
    h.governor.cast_vote(&voter, &proposal_id, &VoteSupport::For);

    h.env.ledger().with_mut(|l| l.sequence_number = 31);
    assert_eq!(h.governor.state(&proposal_id), ProposalState::Defeated);

    let stats = h.governor.get_all_time_stats();
    assert_eq!(stats.quorum_miss_count, 1);
    assert_eq!(stats.quorum_hit_count, 0);
    assert_eq!(stats.pass_rate_bps, 0);

    // Re-reading state() again must not double-count the resolution.
    assert_eq!(h.governor.state(&proposal_id), ProposalState::Defeated);
    let stats_again = h.governor.get_all_time_stats();
    assert_eq!(stats_again.quorum_miss_count, 1);
}

#[test]
fn test_all_time_stats_tracks_expired_proposal_once() {
    // Small grace period so the proposal can lapse into Expired quickly.
    let h = setup(10, 20, 20, 5);
    let proposer = Address::generate(&h.env);
    h.votes.set_votes(&proposer, &100_000i128);
    let voter = Address::generate(&h.env);
    h.votes.set_votes(&voter, &3_000i128);

    let proposal_id = propose_dummy(&h.env, &h.governor, &proposer, b"expire-1");
    h.env.ledger().with_mut(|l| l.sequence_number = 11);
    h.governor.cast_vote(&voter, &proposal_id, &VoteSupport::For);

    // end_ledger = 10 + 20 = 30; grace_end = 35. Never queue — advance past
    // the grace period so the proposal lapses from Succeeded into Expired.
    h.env.ledger().with_mut(|l| l.sequence_number = 40);
    assert_eq!(h.governor.state(&proposal_id), ProposalState::Expired);

    let stats = h.governor.get_all_time_stats();
    // Expired-after-succeeded still counts as a quorum hit but not a pass.
    assert_eq!(stats.quorum_hit_count, 1);
    assert_eq!(stats.pass_rate_bps, 0);

    // Re-reading state() again must not double-count the resolution.
    assert_eq!(h.governor.state(&proposal_id), ProposalState::Expired);
    let stats_again = h.governor.get_all_time_stats();
    assert_eq!(stats_again.quorum_hit_count, 1);
}

#[test]
fn test_unique_voters_counted_once_across_multiple_proposals() {
    let h = setup(10, 20, 0, 120_960);
    let proposer = Address::generate(&h.env);
    h.votes.set_votes(&proposer, &100_000i128);
    let voter = Address::generate(&h.env);
    h.votes.set_votes(&voter, &500i128);

    let proposal_id1 = propose_dummy(&h.env, &h.governor, &proposer, b"uniq-1");
    h.env.ledger().with_mut(|l| l.sequence_number = 11);
    h.governor.cast_vote(&voter, &proposal_id1, &VoteSupport::For);

    // Advance past the default 100-ledger proposal cooldown before the same
    // proposer can create a second proposal.
    h.env.ledger().with_mut(|l| l.sequence_number = 200);
    let proposal_id2 = propose_dummy(&h.env, &h.governor, &proposer, b"uniq-2");
    h.env.ledger().with_mut(|l| l.sequence_number = 211);
    h.governor.cast_vote(&voter, &proposal_id2, &VoteSupport::For);

    let stats = h.governor.get_all_time_stats();
    assert_eq!(stats.unique_voters, 1);
    assert_eq!(stats.total_votes_cast, 1_000);
}

#[test]
fn test_zero_weight_vote_still_counts_as_participation() {
    // Proposer has voting power but our test voter has zero, so the vote
    // itself contributes 0 weight yet must still register as a cast.
    let h = setup(10, 20, 0, 120_960);
    let proposer = Address::generate(&h.env);
    h.votes.set_votes(&proposer, &100_000i128);
    let voter = Address::generate(&h.env);

    let proposal_id = propose_dummy(&h.env, &h.governor, &proposer, b"zero-1");
    h.env.ledger().with_mut(|l| l.sequence_number = 11);
    h.governor.cast_vote(&voter, &proposal_id, &VoteSupport::For);

    let stats = h.governor.get_all_time_stats();
    assert_eq!(stats.unique_voters, 1);
    assert_eq!(stats.total_votes_cast, 0);
}
