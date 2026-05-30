use crate::{GovernorContract, GovernorContractClient, ProposalState, VoteSupport, VoteType};
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger as _},
    token, Address, Bytes, Env, Symbol,
};

use sorogov_timelock::{TimelockContract, TimelockContractClient};
use sorogov_token_votes::{TokenVotesContract, TokenVotesContractClient};

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

fn create_proposal(env: &Env, governor_client: &GovernorContractClient, proposer: &Address) -> u64 {
    let target_id = env.register(LoadTestTarget, ());
    let description = soroban_sdk::String::from_str(env, "Load test proposal");
    let description_hash = env
        .crypto()
        .sha256(&Bytes::from_slice(env, b"load-test"))
        .into();
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

    // Pre-create voters at ledger 0 using the SAME token the votes contract tracks,
    // so their delegation checkpoints exist before start_ledger (10) with non-zero power.
    let mut voters = soroban_sdk::Vec::new(&env);
    for _ in 0..1000 {
        let voter = Address::generate(&env);
        token_admin.mint(&voter, &100_i128);
        votes_client.delegate(&voter, &voter);
        voters.push_back(voter);
    }

    env.ledger().with_mut(|li| li.sequence_number = 11);

    for i in 0..voters.len() {
        let voter = voters.get(i).unwrap();
        governor_client.cast_vote(&voter, &proposal_id, &VoteSupport::For);
    }

    let (votes_for, _, _) = governor_client.proposal_votes(&proposal_id);
    assert!(
        votes_for > 0,
        "votes should have been recorded after 1000 casts"
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

    let p1 = Address::generate(&env);
    let p2 = Address::generate(&env);
    let p3 = Address::generate(&env);
    let p4 = Address::generate(&env);
    let pid0 = create_proposal(&env, &governor_client, &proposer);
    let pid1 = create_proposal(&env, &governor_client, &p1);
    let pid2 = create_proposal(&env, &governor_client, &p2);
    let pid3 = create_proposal(&env, &governor_client, &p3);
    let pid4 = create_proposal(&env, &governor_client, &p4);
    let proposal_ids = [pid0, pid1, pid2, pid3, pid4];

    env.ledger().with_mut(|li| li.sequence_number = 11);

    for i in 0..100_u32 {
        let voter = create_voter(&env, &votes_client, 100);
        let pid = proposal_ids[(i % 5) as usize];
        governor_client.cast_vote(&voter, &pid, &VoteSupport::For);
    }

    for pid in &proposal_ids {
        let state = governor_client.state(pid);
        assert_eq!(
            state,
            ProposalState::Active,
            "proposal {} should be Active after voting",
            pid
        );
    }
}
