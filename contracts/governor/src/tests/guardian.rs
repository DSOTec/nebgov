use crate::{GovernorContract, GovernorContractClient, ProposalState, VoteSupport, VoteType};
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Events, Ledger as _},
    Address, Bytes, BytesN, Env, IntoVal, String, Symbol, TryIntoVal,
};

use super::MockTimelockContract;

/// Minimal mock votes contract sufficient for guardian tests.
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

/// Initialise the governor and return (client, admin, guardian, timelock_id, votes_id).
fn setup(env: &Env) -> (GovernorContractClient, Address, Address, Address, Address) {
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
    (client, admin, guardian, timelock_id, votes_id)
}

/// Create a minimal valid proposal and return its id.
fn create_proposal(env: &Env, client: &GovernorContractClient, proposer: &Address) -> u64 {
    let target = Address::generate(env);
    let fn_name = Symbol::new(env, "exec");
    let calldata = Bytes::new(env);
    let description = String::from_str(env, "Guardian test proposal");
    let description_hash: BytesN<32> = env
        .crypto()
        .sha256(&Bytes::from_slice(env, b"Guardian test proposal"))
        .into();
    let metadata_uri = String::from_str(env, "ipfs://QmGuardianTest");
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

// ── set_guardian tests ────────────────────────────────────────────────────────

#[test]
fn test_set_guardian_admin_rotates_guardian() {
    let env = Env::default();
    let (client, admin, _old_guardian, _timelock, _votes) = setup(&env);

    let new_guardian = Address::generate(&env);
    client.set_guardian(&admin, &new_guardian);

    let settings = client.get_settings();
    assert_eq!(settings.guardian, new_guardian);
}

#[test]
fn test_set_guardian_emits_guardian_set_event() {
    let env = Env::default();
    let (client, admin, _old_guardian, _timelock, _votes) = setup(&env);

    let new_guardian = Address::generate(&env);
    client.set_guardian(&admin, &new_guardian);

    let guardian_set_sym = Symbol::new(&env, "GuardianSet");
    let has_event = env.events().all().iter().any(|(_, topics, _)| {
        !topics.is_empty() && {
            let first: Result<Symbol, _> = topics.get(0).unwrap().try_into_val(&env);
            first.is_ok() && first.unwrap() == guardian_set_sym
        }
    });
    assert!(has_event, "GuardianSet event not emitted");
}

#[test]
#[should_panic(expected = "Error(Contract, #8)")]
fn test_set_guardian_non_admin_rejected() {
    let env = Env::default();
    let (client, _admin, _guardian, _timelock, _votes) = setup(&env);

    let attacker = Address::generate(&env);
    let new_guardian = Address::generate(&env);
    client.set_guardian(&attacker, &new_guardian);
}

// ── guardian_cancel tests ─────────────────────────────────────────────────────

#[test]
fn test_guardian_cancel_pending_proposal() {
    let env = Env::default();
    let (client, _admin, guardian, _timelock, _votes) = setup(&env);

    let proposer = Address::generate(&env);
    let proposal_id = create_proposal(&env, &client, &proposer);

    assert_eq!(client.state(&proposal_id), ProposalState::Pending);

    let reason = String::from_str(&env, "Governance attack detected");
    client.guardian_cancel(&proposal_id, &reason);

    assert_eq!(client.state(&proposal_id), ProposalState::Cancelled);
    let _ = guardian;
}

#[test]
fn test_guardian_cancel_active_proposal() {
    let env = Env::default();
    let (client, _admin, _guardian, _timelock, _votes) = setup(&env);

    let proposer = Address::generate(&env);
    let proposal_id = create_proposal(&env, &client, &proposer);

    env.ledger().with_mut(|li| li.sequence_number += 101);
    assert_eq!(client.state(&proposal_id), ProposalState::Active);

    let reason = String::from_str(&env, "Malicious proposal during vote");
    client.guardian_cancel(&proposal_id, &reason);

    assert_eq!(client.state(&proposal_id), ProposalState::Cancelled);
}

#[test]
fn test_guardian_cancel_succeeded_proposal() {
    let env = Env::default();
    let (client, _admin, _guardian, _timelock, _votes) = setup(&env);

    let proposer = Address::generate(&env);
    let voter = Address::generate(&env);
    let proposal_id = create_proposal(&env, &client, &proposer);

    env.ledger().with_mut(|li| li.sequence_number += 101);
    client.cast_vote(&voter, &proposal_id, &VoteSupport::For);

    env.ledger().with_mut(|li| li.sequence_number += 1001);
    assert_eq!(client.state(&proposal_id), ProposalState::Succeeded);

    let reason = String::from_str(
        &env,
        "Flash loan attack — proposal passed quorum fraudulently",
    );
    client.guardian_cancel(&proposal_id, &reason);

    assert_eq!(client.state(&proposal_id), ProposalState::Cancelled);
}

#[test]
#[should_panic(expected = "Error(Contract, #16)")]
fn test_guardian_cancel_already_executed_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let guardian = Address::generate(&env);
    let votes_id = env.register(MockVotes, ());
    let timelock_id = env.register(MockTimelockContract, ());
    let governor_id = env.register(GovernorContract, ());
    let client = GovernorContractClient::new(&env, &governor_id);
    client.initialize(
        &admin,
        &votes_id,
        &timelock_id,
        &0_u32,
        &100_u32,
        &0_u32,
        &0_i128,
        &guardian,
        &VoteType::Extended,
        &120_960_u32,
    );

    let proposer = Address::generate(&env);
    let proposal_id = create_proposal(&env, &client, &proposer);

    env.as_contract(&governor_id, || {
        let key = crate::DataKey::Proposal(proposal_id);
        let mut p: crate::Proposal = env.storage().persistent().get(&key).unwrap();
        p.executed = true;
        env.storage().persistent().set(&key, &p);
    });

    let reason = String::from_str(&env, "Too late");
    client.guardian_cancel(&proposal_id, &reason);
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn test_guardian_cancel_already_cancelled_rejected() {
    let env = Env::default();
    let (client, _admin, _guardian, _timelock, _votes) = setup(&env);

    let proposer = Address::generate(&env);
    let proposal_id = create_proposal(&env, &client, &proposer);

    let reason = String::from_str(&env, "First cancellation");
    client.guardian_cancel(&proposal_id, &reason);

    let reason2 = String::from_str(&env, "Second attempt");
    client.guardian_cancel(&proposal_id, &reason2);
}

#[test]
#[should_panic]
fn test_guardian_cancel_non_guardian_rejected() {
    let env = Env::default();

    let admin = Address::generate(&env);
    let guardian = Address::generate(&env);
    let votes_id = env.register(MockVotes, ());
    let timelock_id = env.register(MockTimelockContract, ());
    let governor_id = env.register(GovernorContract, ());
    let client = GovernorContractClient::new(&env, &governor_id);

    env.mock_all_auths();
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

    let proposer = Address::generate(&env);
    let proposal_id = create_proposal(&env, &client, &proposer);

    let attacker = Address::generate(&env);
    env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &attacker,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &governor_id,
            fn_name: "guardian_cancel",
            args: (proposal_id, String::from_str(&env, "attack")).into_val(&env),
            sub_invokes: &[],
        },
    }]);

    client.guardian_cancel(&proposal_id, &String::from_str(&env, "attack"));
}

#[test]
fn test_guardian_cancel_emits_guardian_cancelled_event() {
    let env = Env::default();
    let (client, _admin, _guardian, _timelock, _votes) = setup(&env);

    let proposer = Address::generate(&env);
    let proposal_id = create_proposal(&env, &client, &proposer);

    let reason = String::from_str(&env, "Emergency veto");
    client.guardian_cancel(&proposal_id, &reason);

    let topic_sym = Symbol::new(&env, "GuardianCancelled");
    let has_event = env.events().all().iter().any(|(_, topics, _)| {
        !topics.is_empty() && {
            let first: Result<Symbol, _> = topics.get(0).unwrap().try_into_val(&env);
            first.is_ok() && first.unwrap() == topic_sym
        }
    });
    assert!(has_event, "GuardianCancelled event not emitted");
}
