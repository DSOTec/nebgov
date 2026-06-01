use crate::{GovernorContract, GovernorContractClient, ProposalState, VoteSupport, VoteType};
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Events, Ledger as _},
    Address, Bytes, BytesN, Env, IntoVal, String, Symbol, TryIntoVal,
};

/// Mock timelock with longer min_delay for veto window testing
#[contract]
struct MockTimelockContract;

#[contractimpl]
impl MockTimelockContract {
    pub fn min_delay(_env: Env) -> u64 {
        100 // 100 seconds = 10 ledgers for veto window
    }

    pub fn execution_window(_env: Env) -> u64 {
        60
    }

    #[allow(clippy::too_many_arguments)]
    pub fn schedule(
        _env: Env,
        _caller: Address,
        _target: Address,
        _data: Bytes,
        _fn_name: Symbol,
        _delay: u64,
        _predecessor: Bytes,
        _salt: Bytes,
    ) -> Bytes {
        Bytes::from_slice(&_env, &[1])
    }

    #[allow(clippy::too_many_arguments)]
    pub fn schedule_batch(
        _env: Env,
        _caller: Address,
        _targets: soroban_sdk::Vec<Address>,
        _datas: soroban_sdk::Vec<Bytes>,
        _fn_names: soroban_sdk::Vec<Symbol>,
        _delay: u64,
        _predecessor: Bytes,
        _salt: Bytes,
    ) -> Bytes {
        Bytes::from_slice(&_env, &[1])
    }

    pub fn cancel(_env: Env, _caller: Address, _op_id: Bytes) {}

    pub fn execute(_env: Env, _caller: Address, _op_id: Bytes) {}

    pub fn execute_batch(_env: Env, _caller: Address, _batch_op_id: Bytes) {}

    pub fn is_done(_env: Env, _op_id: Bytes) -> bool {
        false
    }

    pub fn is_batch_done(_env: Env, _batch_op_id: Bytes) -> bool {
        false
    }
}

/// Minimal mock votes contract sufficient for veto tests.
#[contract]
struct MockVotes;

#[contractimpl]
impl MockVotes {
    pub fn get_votes(_env: Env, _account: Address) -> i128 {
        1_000_000
    }

    pub fn get_past_votes(_env: Env, _account: Address, _ledger: u32) -> i128 {
        1_000_000
    }

    pub fn get_past_total_supply(_env: Env, _ledger: u32) -> i128 {
        10_000_000
    }
}

/// Initialise the governor and return (client, admin, timelock_id, votes_id).
fn setup(env: &Env) -> (GovernorContractClient, Address, Address, Address) {
    env.mock_all_auths();
    let admin = Address::generate(env);
    let guardian = Address::generate(env);
    let votes_id = env.register(MockVotes, ());
    let timelock_id = env.register(MockTimelockContract, ());
    let governor_id = env.register(GovernorContract, ());
    let client = GovernorContractClient::new(env, &governor_id);
    client.initialize(
        &admin,
        &votes_id,
        &timelock_id,
        &100_u32,
        &1000_u32,
        &0_u32,
        &0_i128,
        &guardian,
        &VoteType::Extended,
        &120_960_u32,
    );
    (client, admin, timelock_id, votes_id)
}

/// Create a minimal valid proposal and return its id.
fn create_proposal(env: &Env, client: &GovernorContractClient, proposer: &Address) -> u64 {
    let target = Address::generate(env);
    let fn_name = Symbol::new(env, "exec");
    let calldata = Bytes::new(env);
    let description = String::from_str(env, "Veto test proposal");
    let description_hash: BytesN<32> = env
        .crypto()
        .sha256(&Bytes::from_slice(env, b"Veto test proposal"))
        .into();
    let metadata_uri = String::from_str(env, "ipfs://QmVetoTest");
    client.propose(
        proposer,
        &description,
        &description_hash,
        &metadata_uri,
        &soroban_sdk::vec![env, target],
        &soroban_sdk::vec![env, fn_name],
        &soroban_sdk::vec![env, calldata],
    )
}

// ── cast_veto tests ─────────────────────────────────────────────────────────────

#[test]
fn test_cast_veto_during_window_succeeds() {
    let env = Env::default();
    let (client, admin, _timelock, _votes) = setup(&env);

    // Set veto threshold to 10%
    client.set_veto_threshold(&10_u32);

    let proposer = Address::generate(&env);
    let proposal_id = create_proposal(&env, &client, &proposer);

    // Advance to voting period and cast votes to pass the proposal
    env.ledger().with_mut(|li| li.sequence_number = 101);
    let voter = Address::generate(&env);
    client.cast_vote(&voter, &proposal_id, &VoteSupport::For);

    // Advance past voting period
    env.ledger().with_mut(|li| li.sequence_number = 1200);

    // Queue the proposal
    client.queue(&proposal_id);
    assert_eq!(client.state(&proposal_id), ProposalState::Queued);

    // Cast veto during the veto window
    let vetoer = Address::generate(&env);
    client.cast_veto(&vetoer, &proposal_id);

    // Verify veto was recorded
    let proposal = client.get_proposal(&proposal_id);
    assert_eq!(proposal.veto_weight, 1_000_000);
}

#[test]
fn test_cast_veto_after_window_fails() {
    let env = Env::default();
    let (client, admin, _timelock, _votes) = setup(&env);

    client.set_veto_threshold(&10_u32);

    let proposer = Address::generate(&env);
    let proposal_id = create_proposal(&env, &client, &proposer);

    // Advance and vote
    env.ledger().with_mut(|li| li.sequence_number = 101);
    let voter = Address::generate(&env);
    client.cast_vote(&voter, &proposal_id, &VoteSupport::For);

    // Advance past voting period
    env.ledger().with_mut(|li| li.sequence_number = 1200);

    // Queue the proposal
    client.queue(&proposal_id);

    // Advance past veto window (timelock delay is 1 second = ~0.1 ledgers, so jump to 2000)
    env.ledger().with_mut(|li| li.sequence_number = 2000);

    // Attempt to veto should fail
    let vetoer = Address::generate(&env);
    let result = client.try_cast_veto(&vetoer, &proposal_id);
    assert!(result.is_err());
}

#[test]
fn test_cast_veto_threshold_met_cancels_proposal() {
    let env = Env::default();
    let (client, admin, _timelock, _votes) = setup(&env);

    // Set veto threshold to 10% (1,000,000 of 10,000,000 total supply)
    client.set_veto_threshold(&10_u32);

    let proposer = Address::generate(&env);
    let proposal_id = create_proposal(&env, &client, &proposer);

    // Advance and vote
    env.ledger().with_mut(|li| li.sequence_number = 101);
    let voter = Address::generate(&env);
    client.cast_vote(&voter, &proposal_id, &VoteSupport::For);

    // Advance past voting period
    env.ledger().with_mut(|li| li.sequence_number = 1200);

    // Queue the proposal
    client.queue(&proposal_id);

    // Cast veto with exactly 10% of supply (1,000,000)
    let vetoer = Address::generate(&env);
    client.cast_veto(&vetoer, &proposal_id);

    // Proposal should be cancelled
    assert_eq!(client.state(&proposal_id), ProposalState::Cancelled);
}

#[test]
fn test_cast_veto_prevents_double_veto() {
    let env = Env::default();
    let (client, admin, _timelock, _votes) = setup(&env);

    client.set_veto_threshold(&10_u32);

    let proposer = Address::generate(&env);
    let proposal_id = create_proposal(&env, &client, &proposer);

    // Advance and vote
    env.ledger().with_mut(|li| li.sequence_number = 101);
    let voter = Address::generate(&env);
    client.cast_vote(&voter, &proposal_id, &VoteSupport::For);

    // Advance past voting period
    env.ledger().with_mut(|li| li.sequence_number = 1200);

    // Queue the proposal
    client.queue(&proposal_id);

    // Cast veto
    let vetoer = Address::generate(&env);
    client.cast_veto(&vetoer, &proposal_id);

    // Attempt to veto again should fail
    let result = client.try_cast_veto(&vetoer, &proposal_id);
    assert!(result.is_err());
}

#[test]
fn test_cast_veto_not_queued_fails() {
    let env = Env::default();
    let (client, admin, _timelock, _votes) = setup(&env);

    client.set_veto_threshold(&10_u32);

    let proposer = Address::generate(&env);
    let proposal_id = create_proposal(&env, &client, &proposer);

    // Try to veto before queueing
    let vetoer = Address::generate(&env);
    let result = client.try_cast_veto(&vetoer, &proposal_id);
    assert!(result.is_err());
}

#[test]
fn test_set_veto_threshold_governance_gated() {
    let env = Env::default();
    let (client, _admin, _timelock, _votes) = setup(&env);

    // set_veto_threshold is governance-gated (requires current_contract_address().require_auth())
    // In test mode with mock_all_auths, it should succeed
    client.set_veto_threshold(&10_u32);

    let settings = client.get_settings();
    assert_eq!(settings.veto_threshold_numerator, 10);
}

#[test]
fn test_cast_veto_emits_event() {
    let env = Env::default();
    let (client, admin, _timelock, _votes) = setup(&env);

    client.set_veto_threshold(&10_u32);

    let proposer = Address::generate(&env);
    let proposal_id = create_proposal(&env, &client, &proposer);

    // Advance and vote
    env.ledger().with_mut(|li| li.sequence_number = 101);
    let voter = Address::generate(&env);
    client.cast_vote(&voter, &proposal_id, &VoteSupport::For);

    // Advance past voting period
    env.ledger().with_mut(|li| li.sequence_number = 1200);

    // Queue the proposal
    client.queue(&proposal_id);

    // Cast veto
    let vetoer = Address::generate(&env);
    client.cast_veto(&vetoer, &proposal_id);

    // Verify VetoCast event was emitted
    let veto_cast_sym = Symbol::new(&env, "VetoCast");
    let has_event = env.events().all().iter().any(|(_, topics, _)| {
        !topics.is_empty() && {
            let first: Result<Symbol, _> = topics.get(0).unwrap().try_into_val(&env);
            first.is_ok() && first.unwrap() == veto_cast_sym
        }
    });
    assert!(has_event);
}
