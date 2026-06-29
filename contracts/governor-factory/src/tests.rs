use super::*;
use soroban_sdk::{testutils::Address as _, token, Address, BytesN, Env};

use sorogov_governor::GovernorContract;
use sorogov_timelock::TimelockContract;
use sorogov_token_votes::TokenVotesContract;

// Import the WASM binaries for the contracts we want to deploy.
// These are built via `stellar contract build`
mod wasm {
    soroban_sdk::contractimport!(file = "../../target/wasm32v1-none/release/sorogov_governor.wasm");
}

mod timelock_wasm {
    soroban_sdk::contractimport!(file = "../../target/wasm32v1-none/release/sorogov_timelock.wasm");
}

mod token_votes_wasm {
    soroban_sdk::contractimport!(
        file = "../../target/wasm32v1-none/release/sorogov_token_votes.wasm"
    );
}

/// Helper: upload WASMs to the test environment and return their hashes.
fn upload_wasms(env: &Env) -> (BytesN<32>, BytesN<32>, BytesN<32>) {
    let governor_hash = env.deployer().upload_contract_wasm(wasm::WASM);
    let timelock_hash = env.deployer().upload_contract_wasm(timelock_wasm::WASM);
    let token_votes_hash = env.deployer().upload_contract_wasm(token_votes_wasm::WASM);
    (governor_hash, timelock_hash, token_votes_hash)
}

// ─── GovernorDeployed event ───────────────────────────────────────────────────

#[test]
fn test_deploy_emits_governor_deployed_event_with_all_addresses() {
    use crate::events::GovernorDeployedEvent;
    use soroban_sdk::testutils::Events;
    use soroban_sdk::TryIntoVal;

    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    env.register(GovernorContract, ());
    env.register(TimelockContract, ());
    env.register(TokenVotesContract, ());

    let (governor_hash, timelock_hash, token_votes_hash) = upload_wasms(&env);

    let admin = Address::generate(&env);
    let deployer = Address::generate(&env);
    let token = Address::generate(&env);
    let guardian = Address::generate(&env);

    let factory_id = env.register(GovernorFactoryContract, ());
    let factory = GovernorFactoryContractClient::new(&env, &factory_id);
    factory.initialize(&admin, &governor_hash, &timelock_hash, &token_votes_hash);

    env.ledger().with_mut(|l| l.timestamp = 12_345);

    let id = factory.deploy(
        &deployer,
        &token,
        &100u32,
        &1000u32,
        &50u32,
        &0i128,
        &3600u64,
        &guardian,
        &1u32,
        &120_960u32,
    );
    let entry = factory.get_governor(&id);

    let events = env.events().all();
    let (_, _, event_data) = events
        .iter()
        .find(|(addr, _, _)| *addr == factory_id)
        .expect("expected a GovernorDeployed event from the factory");

    let decoded: GovernorDeployedEvent = event_data
        .try_into_val(&env)
        .expect("event data should decode as GovernorDeployedEvent");

    assert_eq!(decoded.id, id);
    assert_eq!(decoded.governor, entry.governor);
    assert_eq!(decoded.timelock, entry.timelock);
    assert_eq!(decoded.token_votes, entry.token);
    assert_eq!(decoded.deployer, deployer);
    assert_eq!(decoded.timestamp, 12_345);
}



#[test]
#[should_panic(expected = "already initialized")]
fn test_initialize_twice_panics() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let admin = Address::generate(&env);
    let hash = BytesN::from_array(&env, &[0u8; 32]);

    let factory_id = env.register(GovernorFactoryContract, ());
    let factory = GovernorFactoryContractClient::new(&env, &factory_id);

    factory.initialize(&admin, &hash, &hash, &hash);
    // Second call must panic
    factory.initialize(&admin, &hash, &hash, &hash);
}
// ─── deploy full stack ────────────────────────────────────────────────────────

#[test]
fn test_deploy_full_stack() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    // Register the sibling contracts so their WASM is available in the env.
    // We don't need the returned addresses here; we just need the WASM hash.
    env.register(GovernorContract, ());
    env.register(TimelockContract, ());
    env.register(TokenVotesContract, ());

    let (governor_hash, timelock_hash, token_votes_hash) = upload_wasms(&env);

    let admin = Address::generate(&env);
    let deployer = Address::generate(&env);
    let token = Address::generate(&env); // underlying SEP-41 token placeholder

    let factory_id = env.register(GovernorFactoryContract, ());
    let factory = GovernorFactoryContractClient::new(&env, &factory_id);

    factory.initialize(&admin, &governor_hash, &timelock_hash, &token_votes_hash);
    assert_eq!(factory.governor_count(), 0);

    // Deploy a governance stack
    let guardian = Address::generate(&env);
    let id = factory.deploy(
        &deployer,
        &token,
        &100u32,     // voting_delay
        &1000u32,    // voting_period
        &50u32,      // quorum_numerator
        &1000i128,   // proposal_threshold
        &3600u64,    // timelock_delay
        &guardian,   // guardian
        &1u32,       // vote_type (1=Extended)
        &120_960u32, // proposal_grace_period (~7 days)
    );

    assert_eq!(id, 1);
    assert_eq!(factory.governor_count(), 1);

    // Verify the stored entry
    let entry = factory.get_governor(&id);
    assert_eq!(entry.id, 1);
    assert_eq!(entry.deployer, deployer);

    // All three addresses must be distinct and non-zero (non-factory)
    assert_ne!(entry.governor, factory_id);
    assert_ne!(entry.timelock, factory_id);
    assert_ne!(entry.token, factory_id);
    assert_ne!(entry.governor, entry.timelock);
    assert_ne!(entry.governor, entry.token);
    assert_ne!(entry.timelock, entry.token);

    // --- Cross-check initialisation via the sibling contract clients ---
    let timelock_client = sorogov_timelock::TimelockContractClient::new(&env, &entry.timelock);
    // Governor is correctly wired as the timelock's governor
    assert_eq!(timelock_client.governor(), entry.governor);
    // min_delay was set to the value we passed in
    assert_eq!(timelock_client.min_delay(), 3600u64);

    let governor_client = sorogov_governor::GovernorContractClient::new(&env, &entry.governor);
    assert_eq!(governor_client.voting_delay(), 100u32);
    assert_eq!(governor_client.voting_period(), 1000u32);
    assert_eq!(governor_client.proposal_threshold(), 1000i128);

    let votes_client = sorogov_token_votes::TokenVotesContractClient::new(&env, &entry.token);
    // token-votes was initialised with the caller-supplied SEP-41 token address
    assert_eq!(votes_client.token(), token);
}

#[test]
fn test_estimate_deploy_cost_returns_three_contract_reserve() {
    let env = Env::default();
    let factory_id = env.register(GovernorFactoryContract, ());
    let factory = GovernorFactoryContractClient::new(&env, &factory_id);

    assert_eq!(factory.estimate_deploy_cost(), 15_000_000i128);
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_deploy_rejects_insufficient_native_balance_before_deploy() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    env.register(GovernorContract, ());
    env.register(TimelockContract, ());
    env.register(TokenVotesContract, ());

    let (governor_hash, timelock_hash, token_votes_hash) = upload_wasms(&env);

    let admin = Address::generate(&env);
    let deployer = Address::generate(&env);
    let token = Address::generate(&env);
    let native_sac = env.register_stellar_asset_contract_v2(admin.clone());

    let factory_id = env.register(GovernorFactoryContract, ());
    let factory = GovernorFactoryContractClient::new(&env, &factory_id);

    factory.initialize(&admin, &governor_hash, &timelock_hash, &token_votes_hash);
    factory.set_native_token(&admin, &native_sac.address());

    let guardian = Address::generate(&env);
    factory.deploy(
        &deployer,
        &token,
        &100u32,
        &1000u32,
        &50u32,
        &0i128,
        &3600u64,
        &guardian,
        &1u32,
        &120_960u32,
    );
}

#[test]
fn test_deploy_allows_sufficient_native_balance() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    env.register(GovernorContract, ());
    env.register(TimelockContract, ());
    env.register(TokenVotesContract, ());

    let (governor_hash, timelock_hash, token_votes_hash) = upload_wasms(&env);

    let admin = Address::generate(&env);
    let deployer = Address::generate(&env);
    let token = Address::generate(&env);
    let native_sac = env.register_stellar_asset_contract_v2(admin.clone());
    let native_admin = token::StellarAssetClient::new(&env, &native_sac.address());

    let factory_id = env.register(GovernorFactoryContract, ());
    let factory = GovernorFactoryContractClient::new(&env, &factory_id);

    factory.initialize(&admin, &governor_hash, &timelock_hash, &token_votes_hash);
    factory.set_native_token(&admin, &native_sac.address());
    native_admin.mint(&deployer, &factory.estimate_deploy_cost());

    let guardian = Address::generate(&env);
    let id = factory.deploy(
        &deployer,
        &token,
        &100u32,
        &1000u32,
        &50u32,
        &0i128,
        &3600u64,
        &guardian,
        &1u32,
        &120_960u32,
    );

    assert_eq!(id, 1);
}

// ─── second deploy produces a distinct stack ──────────────────────────────────

#[test]
fn test_second_deploy_has_different_addresses() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    env.register(GovernorContract, ());
    env.register(TimelockContract, ());
    env.register(TokenVotesContract, ());

    let (governor_hash, timelock_hash, token_votes_hash) = upload_wasms(&env);

    let admin = Address::generate(&env);
    let deployer = Address::generate(&env);
    let token = Address::generate(&env);

    let factory_id = env.register(GovernorFactoryContract, ());
    let factory = GovernorFactoryContractClient::new(&env, &factory_id);
    factory.initialize(&admin, &governor_hash, &timelock_hash, &token_votes_hash);

    let guardian = Address::generate(&env);
    let id1 = factory.deploy(
        &deployer,
        &token,
        &100u32,
        &1000u32,
        &50u32,
        &0i128,
        &86400u64,
        &guardian,
        &1u32,
        &120_960u32,
    );
    let id2 = factory.deploy(
        &deployer,
        &token,
        &200u32,
        &2000u32,
        &40u32,
        &0i128,
        &43200u64,
        &guardian,
        &1u32,
        &120_960u32,
    );

    assert_eq!(id1, 1);
    assert_eq!(id2, 2);
    assert_eq!(factory.governor_count(), 2);

    let e1 = factory.get_governor(&id1);
    let e2 = factory.get_governor(&id2);

    assert_eq!(e1.id, 1);
    assert_eq!(e2.id, 2);
}

// ─── settings validation tests (issue #477) ───────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn test_deploy_rejects_zero_voting_period() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    env.register(GovernorContract, ());
    env.register(TimelockContract, ());
    env.register(TokenVotesContract, ());

    let (governor_hash, timelock_hash, token_votes_hash) = upload_wasms(&env);

    let admin = Address::generate(&env);
    let deployer = Address::generate(&env);
    let token = Address::generate(&env);

    let factory_id = env.register(GovernorFactoryContract, ());
    let factory = GovernorFactoryContractClient::new(&env, &factory_id);
    factory.initialize(&admin, &governor_hash, &timelock_hash, &token_votes_hash);

    let guardian = Address::generate(&env);
    factory.deploy(
        &deployer,
        &token,
        &100u32,
        &0u32, // zero voting_period — must be rejected
        &50u32,
        &0i128,
        &3600u64,
        &guardian,
        &1u32,
        &120_960u32,
    );
}

#[test]
fn test_deploy_accepts_zero_quorum_numerator() {
    // quorum_numerator == 0 is valid: the governor contract short-circuits to 0
    // (any positive vote count satisfies quorum), useful for signaling protocols.
    // The factory must not block this valid configuration.
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    env.register(GovernorContract, ());
    env.register(TimelockContract, ());
    env.register(TokenVotesContract, ());

    let (governor_hash, timelock_hash, token_votes_hash) = upload_wasms(&env);

    let admin = Address::generate(&env);
    let deployer = Address::generate(&env);
    let token = Address::generate(&env);

    let factory_id = env.register(GovernorFactoryContract, ());
    let factory = GovernorFactoryContractClient::new(&env, &factory_id);
    factory.initialize(&admin, &governor_hash, &timelock_hash, &token_votes_hash);

    let guardian = Address::generate(&env);
    let id = factory.deploy(
        &deployer,
        &token,
        &100u32,
        &1000u32,
        &0u32, // zero quorum_numerator — must be accepted
        &0i128,
        &3600u64,
        &guardian,
        &1u32,
        &120_960u32,
    );
    assert_eq!(id, 1, "deploy with quorum_numerator=0 must succeed");
    assert_eq!(factory.governor_count(), 1);
}

#[test]
#[should_panic(expected = "Error(Contract, #2)")]
fn test_deploy_rejects_quorum_numerator_above_100() {
    // quorum_numerator > 100 is invalid: the governor's validate_settings also
    // rejects values above 100 (it would mean more than 100% of supply required).
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    env.register(GovernorContract, ());
    env.register(TimelockContract, ());
    env.register(TokenVotesContract, ());

    let (governor_hash, timelock_hash, token_votes_hash) = upload_wasms(&env);

    let admin = Address::generate(&env);
    let deployer = Address::generate(&env);
    let token = Address::generate(&env);

    let factory_id = env.register(GovernorFactoryContract, ());
    let factory = GovernorFactoryContractClient::new(&env, &factory_id);
    factory.initialize(&admin, &governor_hash, &timelock_hash, &token_votes_hash);

    let guardian = Address::generate(&env);
    factory.deploy(
        &deployer,
        &token,
        &100u32,
        &1000u32,
        &101u32, // quorum_numerator > 100 — must be rejected
        &0i128,
        &3600u64,
        &guardian,
        &1u32,
        &120_960u32,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn test_deploy_rejects_zero_timelock_delay() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    env.register(GovernorContract, ());
    env.register(TimelockContract, ());
    env.register(TokenVotesContract, ());

    let (governor_hash, timelock_hash, token_votes_hash) = upload_wasms(&env);

    let admin = Address::generate(&env);
    let deployer = Address::generate(&env);
    let token = Address::generate(&env);

    let factory_id = env.register(GovernorFactoryContract, ());
    let factory = GovernorFactoryContractClient::new(&env, &factory_id);
    factory.initialize(&admin, &governor_hash, &timelock_hash, &token_votes_hash);

    let guardian = Address::generate(&env);
    factory.deploy(
        &deployer,
        &token,
        &100u32,
        &1000u32,
        &50u32,
        &0i128,
        &0u64, // zero timelock_delay — must be rejected
        &guardian,
        &1u32,
        &120_960u32,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn test_deploy_rejects_invalid_vote_type() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    env.register(GovernorContract, ());
    env.register(TimelockContract, ());
    env.register(TokenVotesContract, ());

    let (governor_hash, timelock_hash, token_votes_hash) = upload_wasms(&env);

    let admin = Address::generate(&env);
    let deployer = Address::generate(&env);
    let token = Address::generate(&env);

    let factory_id = env.register(GovernorFactoryContract, ());
    let factory = GovernorFactoryContractClient::new(&env, &factory_id);
    factory.initialize(&admin, &governor_hash, &timelock_hash, &token_votes_hash);

    let guardian = Address::generate(&env);
    factory.deploy(
        &deployer,
        &token,
        &100u32,
        &1000u32,
        &50u32,
        &0i128,
        &3600u64,
        &guardian,
        &99u32, // invalid vote_type — must be rejected
        &120_960u32,
    );
}
