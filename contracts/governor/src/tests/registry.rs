use crate::{GovernorContract, GovernorContractClient, ProposalState, VoteType};
use soroban_sdk::{
    contract, contractimpl,
    testutils::Address as _,
    Address, Bytes, Env, String, Symbol,
};

/// Mock votes contract that always returns zero voting power, so a
/// successful `propose_via_registry` call in these tests can only be
/// explained by the registry bypass — a direct `propose()` call from the
/// same proposer would be rejected by the threshold check.
#[contract]
pub struct MockZeroVotesContract;

#[contractimpl]
impl MockZeroVotesContract {
    pub fn get_votes(_env: Env, _account: Address) -> i128 {
        0
    }

    pub fn get_past_votes(_env: Env, _account: Address, _ledger: u32) -> i128 {
        0
    }

    pub fn get_past_total_supply(_env: Env, _ledger: u32) -> i128 {
        10_000_000
    }
}

fn setup(
    threshold: i128,
) -> (Env, GovernorContractClient<'static>, Address /* guardian */) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let votes_id = env.register(MockZeroVotesContract, ());
    let timelock_id = env.register(super::MockTimelockContract, ());
    let governor_id = env.register(GovernorContract, ());
    let client = GovernorContractClient::new(&env, &governor_id);
    let guardian = Address::generate(&env);

    client.initialize(
        &admin,
        &votes_id,
        &timelock_id,
        &10u32,
        &100u32,
        &0u32,
        &threshold,
        &guardian,
        &VoteType::Extended,
        &120_960u32,
    );

    (env, client, guardian)
}

fn dummy_action(
    env: &Env,
) -> (
    soroban_sdk::Vec<Address>,
    soroban_sdk::Vec<Symbol>,
    soroban_sdk::Vec<Bytes>,
) {
    (
        soroban_sdk::vec![env, Address::generate(env)],
        soroban_sdk::vec![env, Symbol::new(env, "test")],
        soroban_sdk::vec![env, Bytes::new(env)],
    )
}

#[test]
#[should_panic(expected = "Error(Contract, #44)")]
fn propose_via_registry_rejects_when_no_registry_configured() {
    let (env, client, _guardian) = setup(1_000);
    let registry = Address::generate(&env);
    let proposer = Address::generate(&env);
    let (targets, fn_names, calldatas) = dummy_action(&env);

    client.propose_via_registry(
        &registry,
        &proposer,
        &String::from_str(&env, "d"),
        &env.crypto().sha256(&Bytes::new(&env)).into(),
        &String::from_str(&env, "u"),
        &targets,
        &fn_names,
        &calldatas,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #44)")]
fn propose_via_registry_rejects_unconfigured_caller() {
    let (env, client, _guardian) = setup(1_000);

    let mut settings = client.get_settings();
    let real_registry = Address::generate(&env);
    settings.co_sponsorship_registry = Some(real_registry);
    client.update_config(&settings);

    let attacker = Address::generate(&env);
    let proposer = Address::generate(&env);
    let (targets, fn_names, calldatas) = dummy_action(&env);

    client.propose_via_registry(
        &attacker,
        &proposer,
        &String::from_str(&env, "d"),
        &env.crypto().sha256(&Bytes::new(&env)).into(),
        &String::from_str(&env, "u"),
        &targets,
        &fn_names,
        &calldatas,
    );
}

#[test]
fn propose_via_registry_bypasses_individual_threshold_for_configured_registry() {
    let (env, client, _guardian) = setup(1_000);

    let mut settings = client.get_settings();
    let registry = Address::generate(&env);
    settings.co_sponsorship_registry = Some(registry.clone());
    client.update_config(&settings);

    let proposer = Address::generate(&env);
    let (targets, fn_names, calldatas) = dummy_action(&env);

    // Direct propose() from the same zero-power proposer must fail the
    // threshold check.
    let direct_result = client.try_propose(
        &proposer,
        &String::from_str(&env, "d"),
        &env.crypto().sha256(&Bytes::new(&env)).into(),
        &String::from_str(&env, "u"),
        &targets,
        &fn_names,
        &calldatas,
    );
    assert!(direct_result.is_err());

    // The same proposer, same action, via the configured registry succeeds.
    let proposal_id = client.propose_via_registry(
        &registry,
        &proposer,
        &String::from_str(&env, "d"),
        &env.crypto().sha256(&Bytes::new(&env)).into(),
        &String::from_str(&env, "u"),
        &targets,
        &fn_names,
        &calldatas,
    );

    assert_eq!(proposal_id, 1);
    assert_eq!(client.state(&proposal_id), ProposalState::Pending);
    let proposal = client.get_proposal(&proposal_id);
    assert_eq!(proposal.proposer, proposer);
}
