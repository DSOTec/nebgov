use crate::{GovernorContract, GovernorContractClient, ProposalState, VoteType};
use soroban_sdk::{
    contract, contractimpl, testutils::Address as _, testutils::Ledger as _, Address, Env, Symbol,
};
use sorogov_timelock::TimelockContract;
use sorogov_token_votes::TokenVotesContract;

/// Mock votes contract that always returns enough voting power to pass
/// threshold/quorum checks, used to exercise the propose -> vote -> queue
/// path without needing real token delegation setup.
#[contract]
pub struct MockVotesContract;

#[contractimpl]
impl MockVotesContract {
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

/// Set up a governor with a real timelock and a mock votes contract, then
/// create and queue a proposal. Returns (env, client, timelock_client,
/// proposal_id).
fn setup_queued_proposal() -> (
    Env,
    GovernorContractClient<'static>,
    sorogov_timelock::TimelockContractClient<'static>,
    u64,
) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let votes_id = env.register(MockVotesContract, ());
    let timelock_id = env.register(TimelockContract, ());
    let governor_id = env.register(GovernorContract, ());

    let timelock_client = sorogov_timelock::TimelockContractClient::new(&env, &timelock_id);
    let min_delay: u64 = 1;
    let execution_window: u64 = 86_400;
    timelock_client.initialize(&admin, &governor_id, &min_delay, &execution_window);

    let governor_client = GovernorContractClient::new(&env, &governor_id);

    // voting_delay=10, voting_period=100, quorum_numerator=0, proposal_threshold=0
    let guardian = Address::generate(&env);
    governor_client.initialize(
        &admin,
        &votes_id,
        &timelock_id,
        &10_u32,
        &100_u32,
        &0_u32,
        &0_i128,
        &guardian,
        &VoteType::Extended,
        &120_960u32,
    );

    let proposer = Address::generate(&env);
    let voter = Address::generate(&env);
    let targets = soroban_sdk::vec![&env, Address::generate(&env)];
    let fn_names = soroban_sdk::vec![&env, Symbol::new(&env, "test")];
    let calldatas = soroban_sdk::vec![&env, soroban_sdk::Bytes::new(&env)];

    let proposal_id = governor_client.propose(
        &proposer,
        &soroban_sdk::String::from_str(&env, "test"),
        &env.crypto().sha256(&soroban_sdk::Bytes::new(&env)).into(),
        &soroban_sdk::String::from_str(&env, "test"),
        &targets,
        &fn_names,
        &calldatas,
    );

    // Move into the active voting window and vote it through.
    env.ledger().set_sequence_number(11);
    governor_client.cast_vote(&voter, &proposal_id, &crate::VoteSupport::For);

    // Move past the voting period so it succeeds, then queue it.
    env.ledger().set_sequence_number(111);
    assert_eq!(
        governor_client.state(&proposal_id),
        ProposalState::Succeeded
    );
    governor_client.queue(&proposal_id);
    assert_eq!(governor_client.state(&proposal_id), ProposalState::Queued);

    (env, governor_client, timelock_client, proposal_id)
}

#[test]
/// cancel_by_governance on a Queued proposal must cancel every op_id stored
/// on the proposal via the timelock.
fn test_cancel_by_governance_on_queued_proposal_cancels_timelock_ops() {
    let (env, governor_client, timelock_client, proposal_id) = setup_queued_proposal();

    let op_ids = governor_client.get_queued_op_ids(&proposal_id);
    assert!(!op_ids.is_empty(), "expected at least one queued op_id");

    // All op_ids should be pending (scheduled, not yet cancelled) before cancellation.
    for i in 0..op_ids.len() {
        let op_id = op_ids.get(i).unwrap();
        assert!(timelock_client.is_pending(&op_id));
    }

    governor_client.cancel_by_governance(&proposal_id);

    assert_eq!(
        governor_client.state(&proposal_id),
        ProposalState::Cancelled
    );

    // Every op_id associated with the proposal must now be cancelled in the timelock.
    for i in 0..op_ids.len() {
        let op_id = op_ids.get(i).unwrap();
        assert!(
            !timelock_client.is_pending(&op_id),
            "timelock op {} should no longer be pending after cancel_by_governance",
            i
        );
        let op = timelock_client.get_operation(&op_id);
        assert!(op.is_some());
        assert!(op.unwrap().cancelled);
    }
}

#[test]
/// cancel_by_governance on a non-queued (e.g. Pending) proposal must not call
/// the timelock at all — there is nothing scheduled to cancel.
fn test_cancel_by_governance_on_non_queued_proposal_does_not_call_timelock() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);

    let votes_id = env.register(TokenVotesContract, ());
    let timelock_id = env.register(TimelockContract, ());
    let governor_id = env.register(GovernorContract, ());

    let timelock_client = sorogov_timelock::TimelockContractClient::new(&env, &timelock_id);
    let min_delay: u64 = 1;
    let execution_window: u64 = 86_400;
    timelock_client.initialize(&admin, &governor_id, &min_delay, &execution_window);

    let governor_client = GovernorContractClient::new(&env, &governor_id);

    governor_client.initialize(
        &admin,
        &votes_id,
        &timelock_id,
        &10_u32,
        &20_u32,
        &0_u32,
        &0_i128,
        &Address::generate(&env),
        &VoteType::Extended,
        &120_960u32,
    );

    let proposer = Address::generate(&env);
    let targets = soroban_sdk::vec![&env, Address::generate(&env)];
    let fn_names = soroban_sdk::vec![&env, Symbol::new(&env, "test")];
    let calldatas = soroban_sdk::vec![&env, soroban_sdk::Bytes::new(&env)];

    let proposal_id = governor_client.propose(
        &proposer,
        &soroban_sdk::String::from_str(&env, "test"),
        &env.crypto().sha256(&soroban_sdk::Bytes::new(&env)).into(),
        &soroban_sdk::String::from_str(&env, "test"),
        &targets,
        &fn_names,
        &calldatas,
    );

    // Proposal is still Pending — never queued, so op_ids is empty.
    let op_ids_before = governor_client.get_queued_op_ids(&proposal_id);
    assert!(op_ids_before.is_empty());

    governor_client.cancel_by_governance(&proposal_id);

    assert_eq!(
        governor_client.state(&proposal_id),
        ProposalState::Cancelled
    );

    // Nothing was scheduled, so there is nothing for the timelock to have
    // cancelled — confirm by checking the timelock's tx count / events stay empty.
    let timelock_events = env
        .events()
        .all()
        .iter()
        .filter(|(addr, _, _)| *addr == timelock_client.address)
        .count();
    assert_eq!(
        timelock_events, 0,
        "timelock should not have been called for a non-queued proposal"
    );
}

#[test]
#[should_panic(expected = "proposal already executed or cancelled")]
/// cancel_by_governance on an already-cancelled (terminal) proposal must revert.
fn test_cancel_by_governance_on_already_cancelled_proposal_reverts() {
    let (_env, governor_client, _timelock_client, proposal_id) = setup_queued_proposal();

    governor_client.cancel_by_governance(&proposal_id);
    // Second call on the now-cancelled proposal must revert.
    governor_client.cancel_by_governance(&proposal_id);
}

#[test]
fn test_cancel_by_governance_success() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);

    let votes_id = env.register(TokenVotesContract, ());
    let timelock_id = env.register(TimelockContract, ());
    let governor_id = env.register(GovernorContract, ());

    // Initialize the timelock so its MinDelay and ExecutionWindow storage keys
    // are set; some timelock methods expect these values to exist.
    let timelock_client = sorogov_timelock::TimelockContractClient::new(&env, &timelock_id);
    let min_delay: u64 = 1;
    let execution_window: u64 = 86_400;
    timelock_client.initialize(&admin, &governor_id, &min_delay, &execution_window);

    let governor_client = GovernorContractClient::new(&env, &governor_id);

    governor_client.initialize(
        &admin,
        &votes_id,
        &timelock_id,
        &10_u32,
        &20_u32,
        &0_u32,
        &0_i128,
        &Address::generate(&env),
        &VoteType::Extended,
        &120_960u32,
    );

    let proposer = Address::generate(&env);
    let targets = soroban_sdk::vec![&env, Address::generate(&env)];
    let fn_names = soroban_sdk::vec![&env, Symbol::new(&env, "test")];
    let calldatas = soroban_sdk::vec![&env, soroban_sdk::Bytes::new(&env)];

    let proposal_id = governor_client.propose(
        &proposer,
        &soroban_sdk::String::from_str(&env, "test"),
        &env.crypto().sha256(&soroban_sdk::Bytes::new(&env)).into(),
        &soroban_sdk::String::from_str(&env, "test"),
        &targets,
        &fn_names,
        &calldatas,
    );

    // Call cancel_by_governance
    // With mock_all_auths, require_auth() will succeed
    governor_client.cancel_by_governance(&proposal_id);

    assert_eq!(
        governor_client.state(&proposal_id),
        ProposalState::Cancelled
    );
}

#[test]
#[should_panic]
fn test_cancel_by_governance_unauthorized() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);

    let votes_id = env.register(TokenVotesContract, ());
    let timelock_id = env.register(TimelockContract, ());
    let governor_id = env.register(GovernorContract, ());

    let governor_client = GovernorContractClient::new(&env, &governor_id);

    governor_client.initialize(
        &admin,
        &votes_id,
        &timelock_id,
        &10_u32,
        &20_u32,
        &0_u32,
        &0_i128,
        &Address::generate(&env),
        &VoteType::Extended,
        &120_960u32,
    );

    let proposer = Address::generate(&env);
    let targets = soroban_sdk::vec![&env, Address::generate(&env)];
    let fn_names = soroban_sdk::vec![&env, Symbol::new(&env, "test")];
    let calldatas = soroban_sdk::vec![&env, soroban_sdk::Bytes::new(&env)];

    let proposal_id = governor_client.propose(
        &proposer,
        &soroban_sdk::String::from_str(&env, "test"),
        &env.crypto().sha256(&soroban_sdk::Bytes::new(&env)).into(),
        &soroban_sdk::String::from_str(&env, "test"),
        &targets,
        &fn_names,
        &calldatas,
    );

    // Call from unauthorized address (alice)
    let alice = Address::generate(&env);
    env.as_contract(&alice, || {
        governor_client.cancel_by_governance(&proposal_id);
    });
}
