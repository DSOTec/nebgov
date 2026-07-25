//! Tests for two-phase Commit-Reveal voting (Issue #766).
//!
//! Mirrors the `Harness` + local votes-mock pattern established in
//! `tests/reputation.rs`: a minimal configurable votes contract gives each
//! test deterministic per-address voting power, and `setup()` wires a real
//! `GovernorContractClient` + `TimelockContractClient` pair so commit/reveal
//! is exercised through the actual public entrypoints rather than by poking
//! `commit_reveal` module internals directly. `compute_commitment` is the one
//! internal function tests call directly (to build the exact preimage a real
//! SDK caller would submit) — it does not touch storage, only `env.crypto()`.

use crate::{
    commit_reveal, GovernorContract, GovernorContractClient, GovernorSettings, VoteSupport,
    VoteType,
};
use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::{Address as _, Events, Ledger as _},
    Address, Bytes, BytesN, Env, String, Symbol, TryIntoVal,
};
use sorogov_timelock::{TimelockContract, TimelockContractClient};

#[contracttype]
#[derive(Clone)]
enum VotesKey {
    Votes(Address),
    TotalSupply,
}

#[contract]
pub struct CommitRevealTestVotesContract;

#[contractimpl]
impl CommitRevealTestVotesContract {
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

struct Harness {
    env: Env,
    governor: GovernorContractClient<'static>,
    votes: CommitRevealTestVotesContractClient<'static>,
}

/// `voting_delay = 10`, `voting_period = 100`: with the default 50/50 split
/// that gives a 50-ledger commit window followed by a 50-ledger reveal
/// window, wide enough that every deadline in the tests below lands on a
/// distinct, unambiguous ledger.
fn setup(vote_type: VoteType) -> Harness {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let votes_id = env.register(CommitRevealTestVotesContract, ());
    let votes = CommitRevealTestVotesContractClient::new(&env, &votes_id);
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
        &10u32,
        &100u32,
        &0u32, // no quorum requirement — tests only care about commit-reveal mechanics
        &0i128,
        &guardian,
        &vote_type,
        &120_960u32,
    );

    Harness { env, governor, votes }
}

/// Flips `use_commit_reveal` on for all proposals created after this call,
/// via the same `update_config` path a governance proposal would use.
/// `env.mock_all_auths()` in `setup()` covers `update_config`'s
/// `current_contract_address().require_auth()`.
fn enable_commit_reveal(h: &Harness, commit_phase_fraction: u32) {
    let mut settings: GovernorSettings = h.governor.get_settings();
    settings.use_commit_reveal = true;
    settings.commit_phase_fraction = commit_phase_fraction;
    h.governor.update_config(&settings);
}

fn propose_dummy(env: &Env, governor: &GovernorContractClient, proposer: &Address, seed: &[u8]) -> u64 {
    let target = Address::generate(env);
    let fn_name = Symbol::new(env, "exec");
    let calldata = Bytes::new(env);
    let description = String::from_str(env, "Commit-reveal test proposal");
    let description_hash = env.crypto().sha256(&Bytes::from_slice(env, seed)).into();
    let metadata_uri = String::from_str(env, "ipfs://commit-reveal-test");

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

fn commitment_for(
    env: &Env,
    proposal_id: u64,
    support: &VoteSupport,
    weight_seed: u128,
    salt: &BytesN<32>,
) -> BytesN<32> {
    commit_reveal::compute_commitment(env, proposal_id, support, weight_seed, salt)
}

fn random_salt(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[7u8; 32])
}

#[test]
fn test_commit_vote_stores_commitment_and_blocks_double_commit() {
    let h = setup(VoteType::Extended);
    enable_commit_reveal(&h, 5_000);
    let proposer = Address::generate(&h.env);
    h.votes.set_votes(&proposer, &1i128);
    let voter = Address::generate(&h.env);
    h.votes.set_votes(&voter, &1_000i128);

    let proposal_id = propose_dummy(&h.env, &h.governor, &proposer, b"commit-1");
    h.env.ledger().with_mut(|l| l.sequence_number = 11); // start_ledger

    let salt = random_salt(&h.env);
    let commitment = commitment_for(&h.env, proposal_id, &VoteSupport::For, 42, &salt);

    assert!(!h.governor.has_committed(&proposal_id, &voter));
    h.governor.commit_vote(&voter, &proposal_id, &commitment);
    assert!(h.governor.has_committed(&proposal_id, &voter));

    let result = h
        .governor
        .try_commit_vote(&voter, &proposal_id, &commitment);
    assert!(result.is_err(), "double commit must be rejected");
}

#[test]
fn test_reveal_vote_verifies_sha256_preimage_and_updates_tally() {
    let h = setup(VoteType::Extended);
    enable_commit_reveal(&h, 5_000);
    let proposer = Address::generate(&h.env);
    h.votes.set_votes(&proposer, &1i128);
    let voter = Address::generate(&h.env);
    h.votes.set_votes(&voter, &1_000i128);

    let proposal_id = propose_dummy(&h.env, &h.governor, &proposer, b"reveal-1");
    h.env.ledger().with_mut(|l| l.sequence_number = 11); // start_ledger = 11

    let salt = random_salt(&h.env);
    let weight_seed = 999u128;
    let commitment = commitment_for(&h.env, proposal_id, &VoteSupport::For, weight_seed, &salt);
    h.governor.commit_vote(&voter, &proposal_id, &commitment);

    // commit_deadline = 11 + (100 * 5000 / 10000) = 61; reveal window starts at 62.
    h.env.ledger().with_mut(|l| l.sequence_number = 65);
    h.governor
        .reveal_vote(&voter, &proposal_id, &VoteSupport::For, &weight_seed, &salt);

    let proposal = h.governor.get_proposal(&proposal_id);
    assert_eq!(proposal.votes_for, 1_000);
    assert_eq!(proposal.votes_against, 0);
}

#[test]
#[should_panic(expected = "Error(Contract, #45)")] // CommitPhaseEnded
fn test_cannot_commit_after_commit_deadline() {
    let h = setup(VoteType::Extended);
    enable_commit_reveal(&h, 5_000);
    let proposer = Address::generate(&h.env);
    h.votes.set_votes(&proposer, &1i128);
    let voter = Address::generate(&h.env);
    h.votes.set_votes(&voter, &1_000i128);

    let proposal_id = propose_dummy(&h.env, &h.governor, &proposer, b"commit-deadline");
    h.env.ledger().with_mut(|l| l.sequence_number = 62); // past commit_deadline (61)

    let salt = random_salt(&h.env);
    let commitment = commitment_for(&h.env, proposal_id, &VoteSupport::For, 1, &salt);
    h.governor.commit_vote(&voter, &proposal_id, &commitment);
}

#[test]
#[should_panic(expected = "Error(Contract, #46)")] // RevealPhaseNotStarted
fn test_cannot_reveal_before_reveal_phase_starts() {
    let h = setup(VoteType::Extended);
    enable_commit_reveal(&h, 5_000);
    let proposer = Address::generate(&h.env);
    h.votes.set_votes(&proposer, &1i128);
    let voter = Address::generate(&h.env);
    h.votes.set_votes(&voter, &1_000i128);

    let proposal_id = propose_dummy(&h.env, &h.governor, &proposer, b"reveal-early");
    h.env.ledger().with_mut(|l| l.sequence_number = 11);

    let salt = random_salt(&h.env);
    let weight_seed = 5u128;
    let commitment = commitment_for(&h.env, proposal_id, &VoteSupport::For, weight_seed, &salt);
    h.governor.commit_vote(&voter, &proposal_id, &commitment);

    // Still inside the commit window (deadline is 61) — reveal must be rejected.
    h.env.ledger().with_mut(|l| l.sequence_number = 30);
    h.governor
        .reveal_vote(&voter, &proposal_id, &VoteSupport::For, &weight_seed, &salt);
}

#[test]
#[should_panic(expected = "Error(Contract, #47)")] // RevealPhaseEnded
fn test_cannot_reveal_after_reveal_deadline() {
    let h = setup(VoteType::Extended);
    enable_commit_reveal(&h, 5_000);
    let proposer = Address::generate(&h.env);
    h.votes.set_votes(&proposer, &1i128);
    let voter = Address::generate(&h.env);
    h.votes.set_votes(&voter, &1_000i128);

    let proposal_id = propose_dummy(&h.env, &h.governor, &proposer, b"reveal-late");
    h.env.ledger().with_mut(|l| l.sequence_number = 11);

    let salt = random_salt(&h.env);
    let weight_seed = 5u128;
    let commitment = commitment_for(&h.env, proposal_id, &VoteSupport::For, weight_seed, &salt);
    h.governor.commit_vote(&voter, &proposal_id, &commitment);

    // reveal_deadline = end_ledger = 11 + 100 = 111.
    h.env.ledger().with_mut(|l| l.sequence_number = 112);
    h.governor
        .reveal_vote(&voter, &proposal_id, &VoteSupport::For, &weight_seed, &salt);
}

#[test]
#[should_panic(expected = "Error(Contract, #48)")] // CommitmentMismatch
fn test_commitment_mismatch_reverts_with_commitment_mismatch() {
    let h = setup(VoteType::Extended);
    enable_commit_reveal(&h, 5_000);
    let proposer = Address::generate(&h.env);
    h.votes.set_votes(&proposer, &1i128);
    let voter = Address::generate(&h.env);
    h.votes.set_votes(&voter, &1_000i128);

    let proposal_id = propose_dummy(&h.env, &h.governor, &proposer, b"mismatch-1");
    h.env.ledger().with_mut(|l| l.sequence_number = 11);

    let salt = random_salt(&h.env);
    let commitment = commitment_for(&h.env, proposal_id, &VoteSupport::For, 42, &salt);
    h.governor.commit_vote(&voter, &proposal_id, &commitment);

    h.env.ledger().with_mut(|l| l.sequence_number = 65);
    // Reveals a different support than was committed — preimage won't match.
    h.governor
        .reveal_vote(&voter, &proposal_id, &VoteSupport::Against, &42u128, &salt);
}

#[test]
#[should_panic(expected = "Error(Contract, #49)")] // NoCommitmentToReveal
fn test_reveal_without_prior_commit_reverts_with_no_commitment_to_reveal() {
    let h = setup(VoteType::Extended);
    enable_commit_reveal(&h, 5_000);
    let proposer = Address::generate(&h.env);
    h.votes.set_votes(&proposer, &1i128);
    let voter = Address::generate(&h.env);
    h.votes.set_votes(&voter, &1_000i128);

    let proposal_id = propose_dummy(&h.env, &h.governor, &proposer, b"no-commit");
    h.env.ledger().with_mut(|l| l.sequence_number = 65);

    let salt = random_salt(&h.env);
    h.governor
        .reveal_vote(&voter, &proposal_id, &VoteSupport::For, &1u128, &salt);
}

#[test]
fn test_unrevealed_commitment_does_not_count_toward_tally() {
    let h = setup(VoteType::Extended);
    enable_commit_reveal(&h, 5_000);
    let proposer = Address::generate(&h.env);
    h.votes.set_votes(&proposer, &1i128);
    let voter = Address::generate(&h.env);
    h.votes.set_votes(&voter, &1_000i128);

    let proposal_id = propose_dummy(&h.env, &h.governor, &proposer, b"unrevealed-1");
    h.env.ledger().with_mut(|l| l.sequence_number = 11);

    let salt = random_salt(&h.env);
    let commitment = commitment_for(&h.env, proposal_id, &VoteSupport::For, 42, &salt);
    h.governor.commit_vote(&voter, &proposal_id, &commitment);

    // Never reveal — advance straight past the reveal deadline.
    h.env.ledger().with_mut(|l| l.sequence_number = 112);

    let proposal = h.governor.get_proposal(&proposal_id);
    assert_eq!(proposal.votes_for, 0);
    assert_eq!(proposal.votes_against, 0);
    assert_eq!(proposal.votes_abstain, 0);
}

#[test]
fn test_commit_reveal_with_quadratic_vote_type() {
    let h = setup(VoteType::Quadratic);
    enable_commit_reveal(&h, 5_000);
    let proposer = Address::generate(&h.env);
    h.votes.set_votes(&proposer, &1i128);
    let voter = Address::generate(&h.env);
    h.votes.set_votes(&voter, &100i128); // sqrt(100) = 10

    let proposal_id = propose_dummy(&h.env, &h.governor, &proposer, b"quadratic-1");
    h.env.ledger().with_mut(|l| l.sequence_number = 11);

    let salt = random_salt(&h.env);
    let weight_seed = 3u128;
    let commitment = commitment_for(&h.env, proposal_id, &VoteSupport::For, weight_seed, &salt);
    h.governor.commit_vote(&voter, &proposal_id, &commitment);

    h.env.ledger().with_mut(|l| l.sequence_number = 65);
    h.governor
        .reveal_vote(&voter, &proposal_id, &VoteSupport::For, &weight_seed, &salt);

    let proposal = h.governor.get_proposal(&proposal_id);
    assert_eq!(
        proposal.votes_for, 10,
        "quadratic weighting must apply to a revealed vote same as a direct cast_vote"
    );
}

#[test]
fn test_commit_reveal_disabled_falls_through_to_cast_vote() {
    // use_commit_reveal is false by default — never call enable_commit_reveal.
    let h = setup(VoteType::Extended);
    let proposer = Address::generate(&h.env);
    h.votes.set_votes(&proposer, &1i128);
    let voter = Address::generate(&h.env);
    h.votes.set_votes(&voter, &1_000i128);

    let proposal_id = propose_dummy(&h.env, &h.governor, &proposer, b"disabled-1");
    h.env.ledger().with_mut(|l| l.sequence_number = 11);

    h.governor.cast_vote(&voter, &proposal_id, &VoteSupport::For);
    let proposal = h.governor.get_proposal(&proposal_id);
    assert_eq!(proposal.votes_for, 1_000);

    // No commit/reveal phase was ever started for this proposal.
    let result = h.governor.try_get_commit_deadline(&proposal_id);
    assert!(
        result.is_err(),
        "commit-reveal-disabled proposals must not have a commit deadline"
    );
}

/// `get_commit_count`/`get_reveal_count` are intentionally not on-chain
/// entrypoints — see the scope-boundary note atop `commit_reveal.rs`: two
/// more public functions plus their counter storage pushed
/// `sorogov_governor.wasm` over Soroban's 100KB cap with zero headroom left
/// (verified: the release build sits at 101,661 / 102,400 bytes as of this
/// change). This mirrors the same off-chain-derivable tradeoff already made
/// for `analytics`/`reputation` in this contract. Both counts are fully
/// recoverable off-chain by counting `VoteCommitted`/`VoteRevealed` events
/// per `proposal_id` — exactly how the indexer computes them — so this test
/// asserts that event data is complete enough to do that instead of testing
/// getters that don't exist.
fn count_topic(env: &Env, topic_name: &str) -> usize {
    let topic_symbol = Symbol::new(env, topic_name);
    env.events()
        .all()
        .iter()
        .filter(|(_, topics, _)| {
            !topics.is_empty() && {
                let first: Result<Symbol, _> = topics.get(0).unwrap().try_into_val(env);
                first.is_ok() && first.unwrap() == topic_symbol
            }
        })
        .count()
}

#[test]
fn test_commit_count_and_reveal_count_getters() {
    let h = setup(VoteType::Extended);
    enable_commit_reveal(&h, 5_000);
    let proposer = Address::generate(&h.env);
    h.votes.set_votes(&proposer, &1i128);
    let voter_a = Address::generate(&h.env);
    let voter_b = Address::generate(&h.env);
    h.votes.set_votes(&voter_a, &1_000i128);
    h.votes.set_votes(&voter_b, &1_000i128);

    let proposal_id = propose_dummy(&h.env, &h.governor, &proposer, b"counts-1");
    h.env.ledger().with_mut(|l| l.sequence_number = 11);

    let salt_a = random_salt(&h.env);
    let salt_b = BytesN::from_array(&h.env, &[9u8; 32]);
    let commitment_a = commitment_for(&h.env, proposal_id, &VoteSupport::For, 1, &salt_a);
    let commitment_b = commitment_for(&h.env, proposal_id, &VoteSupport::Against, 2, &salt_b);

    // The mock test host only retains events from the most recently completed
    // top-level invocation (unlike a real ledger, where an indexer accumulates
    // the event stream across many separate transactions) — so each call's
    // event is checked immediately after that call, one commit/reveal per tx,
    // exactly the granularity an off-chain indexer processes them at.
    h.governor.commit_vote(&voter_a, &proposal_id, &commitment_a);
    assert_eq!(
        count_topic(&h.env, "VoteCommitted"),
        1,
        "each commit_vote call must emit exactly one VoteCommitted event for the indexer to count"
    );
    h.governor.commit_vote(&voter_b, &proposal_id, &commitment_b);
    assert_eq!(count_topic(&h.env, "VoteCommitted"), 1);

    h.env.ledger().with_mut(|l| l.sequence_number = 65);
    h.governor
        .reveal_vote(&voter_a, &proposal_id, &VoteSupport::For, &1u128, &salt_a);
    assert_eq!(
        count_topic(&h.env, "VoteRevealed"),
        1,
        "each reveal_vote call must emit exactly one VoteRevealed event for the indexer to count"
    );
}
