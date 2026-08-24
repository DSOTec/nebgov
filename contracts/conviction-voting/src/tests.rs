extern crate std;

use super::*;
use soroban_sdk::{
    contract, contractimpl, contracttype, testutils::Address as _, testutils::Ledger, Address, Env,
};

#[contracttype]
enum VotesKey {
    Votes(Address),
    Supply,
}

#[contract]
struct MockVotes;

#[contractimpl]
impl MockVotes {
    pub fn set_votes(env: Env, account: Address, votes: i128) {
        env.storage()
            .instance()
            .set(&VotesKey::Votes(account), &votes);
    }

    pub fn set_supply(env: Env, supply: i128) {
        env.storage().instance().set(&VotesKey::Supply, &supply);
    }

    pub fn get_votes(env: Env, account: Address) -> i128 {
        env.storage()
            .instance()
            .get(&VotesKey::Votes(account))
            .unwrap_or(0)
    }

    pub fn get_past_total_supply(env: Env, _ledger: u32) -> i128 {
        env.storage().instance().get(&VotesKey::Supply).unwrap_or(0)
    }
}

#[contract]
struct Target;

#[contractimpl]
impl Target {
    pub fn execute(env: Env) -> u32 {
        let calls: u32 = env.storage().instance().get(&0u32).unwrap_or(0);
        env.storage().instance().set(&0u32, &(calls + 1));
        calls + 1
    }

    pub fn calls(env: Env) -> u32 {
        env.storage().instance().get(&0u32).unwrap_or(0)
    }
}

struct Fixture {
    env: Env,
    contract_id: Address,
    target_id: Address,
    proposer: Address,
    staker: Address,
    admin: Address,
}

fn setup(minimum: i128) -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|ledger| ledger.sequence_number = 1);
    let votes_id = env.register(MockVotes, ());
    let contract_id = env.register(ConvictionVotingContract, ());
    let target_id = env.register(Target, ());
    let admin = Address::generate(&env);
    let proposer = Address::generate(&env);
    let staker = Address::generate(&env);
    let client = ConvictionVotingContractClient::new(&env, &contract_id);
    let votes = MockVotesClient::new(&env, &votes_id);
    votes.set_supply(&1_000_000);
    votes.set_votes(&staker, &100_000);
    client.initialize(&admin, &votes_id, &9_000, &2_000, &minimum, &10_000);
    Fixture {
        env,
        contract_id,
        target_id,
        proposer,
        staker,
        admin,
    }
}

fn proposal(fixture: &Fixture, requested: i128) -> u64 {
    ConvictionVotingContractClient::new(&fixture.env, &fixture.contract_id).create_proposal(
        &fixture.proposer,
        &fixture.target_id,
        &Symbol::new(&fixture.env, "execute"),
        &Bytes::new(&fixture.env),
        &requested,
    )
}

#[test]
fn sustained_stake_converges_to_steady_state() {
    let f = setup(i128::MAX / 4);
    let client = ConvictionVotingContractClient::new(&f.env, &f.contract_id);
    let id = proposal(&f, 0);
    client.stake(&f.staker, &id, &1_000);
    f.env
        .ledger()
        .with_mut(|ledger| ledger.sequence_number = 101);
    let conviction = client.checkpoint_conviction(&id);
    assert!(conviction > 9_990 && conviction <= 10_000);
}

#[test]
fn conviction_decays_after_withdrawal() {
    let f = setup(i128::MAX / 4);
    let client = ConvictionVotingContractClient::new(&f.env, &f.contract_id);
    let id = proposal(&f, 0);
    client.stake(&f.staker, &id, &1_000);
    f.env
        .ledger()
        .with_mut(|ledger| ledger.sequence_number = 11);
    let before = client.checkpoint_conviction(&id);
    client.withdraw_stake(&f.staker);
    f.env
        .ledger()
        .with_mut(|ledger| ledger.sequence_number = 21);
    assert!(client.checkpoint_conviction(&id) < before);
}

#[test]
fn threshold_increases_toward_max_ratio() {
    let f = setup(100);
    let client = ConvictionVotingContractClient::new(&f.env, &f.contract_id);
    let small = client.get_required_threshold(&10_000);
    let large = client.get_required_threshold(&190_000);
    assert!(large > small);
    assert_eq!(client.get_required_threshold(&200_000), i128::MAX);
}

#[test]
fn permissionless_checkpoint_executes_exactly_once() {
    let f = setup(100);
    let client = ConvictionVotingContractClient::new(&f.env, &f.contract_id);
    let id = proposal(&f, 0);
    client.stake(&f.staker, &id, &1_000);
    f.env.ledger().with_mut(|ledger| ledger.sequence_number = 2);
    client.checkpoint_conviction(&id);
    client.checkpoint_conviction(&id);
    assert_eq!(TargetClient::new(&f.env, &f.target_id).calls(), 1);
    assert!(client.get_proposal(&id).executed);
}

#[test]
fn moving_stake_updates_both_proposals() {
    let f = setup(i128::MAX / 4);
    let client = ConvictionVotingContractClient::new(&f.env, &f.contract_id);
    let first = proposal(&f, 0);
    let second = proposal(&f, 0);
    client.stake(&f.staker, &first, &1_000);
    client.stake(&f.staker, &second, &800);
    assert!(client.get_stakes(&first).is_empty());
    assert_eq!(client.get_stakes(&second).get(0).unwrap().amount, 800);
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")]
fn cancelled_proposal_rejects_stakes() {
    let f = setup(100);
    let client = ConvictionVotingContractClient::new(&f.env, &f.contract_id);
    let id = proposal(&f, 0);
    client.cancel_proposal(&f.admin, &id);
    client.stake(&f.staker, &id, &1_000);
}

#[test]
#[should_panic(expected = "Error(Contract, #8)")]
fn withdraw_stake_rejects_never_staked() {
    let f = setup(100);
    let client = ConvictionVotingContractClient::new(&f.env, &f.contract_id);
    let never_staked = Address::generate(&f.env);
    client.withdraw_stake(&never_staked);
}

#[test]
#[should_panic(expected = "Error(Contract, #8)")]
fn withdraw_stake_rejects_after_withdrawal() {
    let f = setup(100);
    let client = ConvictionVotingContractClient::new(&f.env, &f.contract_id);
    let id = proposal(&f, 0);
    client.stake(&f.staker, &id, &1_000);
    client.withdraw_stake(&f.staker);
    client.withdraw_stake(&f.staker);
}

#[test]
fn zero_amount_uses_minimum_threshold() {
    let f = setup(777);
    assert_eq!(
        ConvictionVotingContractClient::new(&f.env, &f.contract_id).get_required_threshold(&0),
        777
    );
}
