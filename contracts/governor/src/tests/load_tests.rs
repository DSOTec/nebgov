use crate::{GovernorContract, GovernorContractClient, ProposalState, VoteSupport, VoteType};
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger},
    token, Address, Bytes, Env, Symbol,
};

use sorogov_timelock::{TimelockContract, TimelockContractClient};
use sorogov_token_votes::{TokenVotesContract, TokenVotesContractClient};

const VOTE_BUDGET_MS: u128 = 5000;

#[contract]
pub struct LoadTestTarget;

#[contractimpl]
impl LoadTestTarget {
    pub fn exec_gov(_env: Env) {}
}

fn deploy_and_init(env: &Env) -> (GovernorContractClient, Address) {
    let admin = Address::generate(env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();
    let token_admin = token::StellarAssetClient::new(env, &token_addr);

    let votes_id = env.register(TokenVotesContract, ());
    let votes_client = TokenVotesContractClient::new(env, &votes_id);
    votes_client.initialize(&admin, &token_addr);

    let timelock_id = env.register(TimelockContract, ());
    let timelock_client = TimelockContractClient::new(env, &timelock_id);

    let governor_id = env.register(GovernorContract, ());
    let governor_client = GovernorContractClient::new(env, &governor_id);

    timelock_client.initialize(&admin, &governor_id, &1, &1_209_600);

    let guardian = Address::generate(env);
    governor_client.initialize(
        &admin,
        &votes_id,
        &timelock_id,
        &10_u32,
        &200_u32,
        &0_u32,
        &0_i128,
        &guardian,
        &VoteType::Extended,
        &120_960u32,
    );

    let proposer = Address::generate(env);
    token_admin.mint(&proposer, &10_000_i128);
    votes_client.delegate(&proposer, &proposer);

    (governor_client, proposer)
}

fn create_voter(env: &Env, votes_client: &TokenVotesContractClient, balance: i128) -> Address {
    let admin = Address::generate(env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_admin = token::StellarAssetClient::new(env, &sac.address());
    let user = Address::generate(env);
    token_admin.mint(&user, &balance);
    votes_client.delegate(&user, &user);
    user
}

fn create_proposal(
    env: &Env,
    governor_client: &GovernorContractClient,
    proposer: &Address,
) -> u64 {
    let target_id = env.register(LoadTestTarget, ());
    let description = soroban_sdk::String::from_str(env, "Load test proposal");
    let description_hash = env.crypto().sha256(&Bytes::from_slice(env, b"load-test")).into();
    let metadata_uri = soroban_sdk::String::from_str(env, "ipfs://load-test");

    let mut targets = soroban_sdk::Vec::new(env);
    targets.push_back(target_id);

    let mut fn_names = soroban_sdk::Vec::new(env);
    fn_names.push_back(Symbol::new(env, "exec_gov"));

    let mut calldatas = soroban_sdk::Vec::new(env);
    calldatas.push_back(Bytes::new(env));

    governor_client.propose(
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
fn load_test_1000_votes() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();
    let token_admin = token::StellarAssetClient::new(&env, &token_addr);

    let votes_id = env.register(TokenVotesContract, ());
    let votes_client = TokenVotesContractClient::new(&env, &votes_id);
    votes_client.initialize(&admin, &token_addr);

    let timelock_id = env.register(TimelockContract, ());
    let timelock_client = TimelockContractClient::new(&env, &timelock_id);

    let governor_id = env.register(GovernorContract, ());
    let governor_client = GovernorContractClient::new(&env, &governor_id);

    timelock_client.initialize(&admin, &governor_id, &1, &1_209_600);

    let guardian = Address::generate(&env);
    governor_client.initialize(
        &admin,
        &votes_id,
        &timelock_id,
        &10_u32,
        &200_u32,
        &0_u32,
        &0_i128,
        &guardian,
        &VoteType::Extended,
        &120_960u32,
    );

    let proposer = Address::generate(&env);
    token_admin.mint(&proposer, &10_000_i128);
    votes_client.delegate(&proposer, &proposer);

    let proposal_id = create_proposal(&env, &governor_client, &proposer);

    env.ledger().set(Ledger::new().with(Ledger::close_at_ledger(11)));

    let voters: Vec<Address> = (0..1000)
        .map(|_| create_voter(&env, &votes_client, 100))
        .collect();

    let start = std::time::Instant::now();
    for voter in &voters {
        governor_client.cast_vote(voter, &proposal_id, &VoteSupport::For);
    }
    let elapsed = start.elapsed();

    assert!(
        elapsed.as_millis() < VOTE_BUDGET_MS,
        "1000 votes took too long: {:?} (budget: {}ms)",
        elapsed,
        VOTE_BUDGET_MS,
    );
}

#[test]
fn load_test_concurrent_votes_round_robin() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();
    let token_admin = token::StellarAssetClient::new(&env, &token_addr);

    let votes_id = env.register(TokenVotesContract, ());
    let votes_client = TokenVotesContractClient::new(&env, &votes_id);
    votes_client.initialize(&admin, &token_addr);

    let timelock_id = env.register(TimelockContract, ());
    let timelock_client = TimelockContractClient::new(&env, &timelock_id);

    let governor_id = env.register(GovernorContract, ());
    let governor_client = GovernorContractClient::new(&env, &governor_id);

    timelock_client.initialize(&admin, &governor_id, &1, &1_209_600);

    let guardian = Address::generate(&env);
    governor_client.initialize(
        &admin,
        &votes_id,
        &timelock_id,
        &10_u32,
        &200_u32,
        &0_u32,
        &0_i128,
        &guardian,
        &VoteType::Extended,
        &120_960u32,
    );

    let proposer = Address::generate(&env);
    token_admin.mint(&proposer, &10_000_i128);
    votes_client.delegate(&proposer, &proposer);

    let proposals: Vec<u64> = (0..5)
        .map(|_| create_proposal(&env, &governor_client, &proposer))
        .collect();

    env.ledger().set(Ledger::new().with(Ledger::close_at_ledger(11)));

    let voters: Vec<Address> = (0..100)
        .map(|_| create_voter(&env, &votes_client, 100))
        .collect();

    let start = std::time::Instant::now();
    for (i, voter) in voters.iter().enumerate() {
        let pid = proposals[i % proposals.len()];
        governor_client.cast_vote(voter, &pid, &VoteSupport::For);
    }
    let elapsed = start.elapsed();

    for pid in &proposals {
        let state = governor_client.state(pid);
        assert_eq!(state, ProposalState::Active, "proposal {} should be Active after voting", pid);
    }

    assert!(
        elapsed.as_millis() < VOTE_BUDGET_MS,
        "100 votes across 5 proposals took too long: {:?}",
        elapsed,
    );
}
