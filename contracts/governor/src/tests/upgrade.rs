use crate::{GovernorContract, GovernorContractClient, VoteType, MigrateData};
use soroban_sdk::{
    testutils::{Address as _, MockAuth, MockAuthInvoke},
    Address, BytesN, Env, IntoVal,
};

#[test]
fn test_governance_upgrade_flow() {
    let env = Env::default();
    env.mock_all_auths();
    
    let admin = Address::generate(&env);
    let contract_id = env.register(GovernorContract, ());
    let client = GovernorContractClient::new(&env, &contract_id);
    
    client.initialize(
        &admin,
        &Address::generate(&env),
        &Address::generate(&env),
        &10, &100, &1, &0,
        &Address::generate(&env),
        &VoteType::Extended,
        &100
    );

    let new_wasm_hash = BytesN::from_array(&env, &[1u8; 32]);
    
    // Simulate upgrade call from contract itself (as if from execution)
    env.as_contract(&contract_id, || {
        client.upgrade(&new_wasm_hash);
    });

    // Upgrade completed without panic; settings should still be accessible.
    let settings = client.get_settings();
    assert_eq!(settings.voting_delay, 10);
}

#[test]
#[should_panic]
fn test_unauthorized_upgrade_fails() {
    let env = Env::default();
    let contract_id = env.register(GovernorContract, ());
    let client = GovernorContractClient::new(&env, &contract_id);
    
    let attacker = Address::generate(&env);
    let new_wasm_hash = BytesN::from_array(&env, &[2u8; 32]);
    
    // Attempt upgrade from attacker address
    env.mock_auths(&[MockAuth {
        address: &attacker,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "upgrade",
            args: (new_wasm_hash.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    
    client.upgrade(&new_wasm_hash);
}

#[test]
fn test_state_preserved_after_upgrade() {
    let env = Env::default();
    env.mock_all_auths();
    
    let admin = Address::generate(&env);
    let contract_id = env.register(GovernorContract, ());
    let client = GovernorContractClient::new(&env, &contract_id);
    
    client.initialize(
        &admin,
        &Address::generate(&env),
        &Address::generate(&env),
        &123, // special delay to verify persistence
        &100, &1, &0,
        &Address::generate(&env),
        &VoteType::Extended,
        &100
    );

    let new_wasm_hash = BytesN::from_array(&env, &[3u8; 32]);
    env.as_contract(&contract_id, || {
        client.upgrade(&new_wasm_hash);
    });

    let settings = client.get_settings();
    assert_eq!(settings.voting_delay, 123);
}

#[test]
fn test_migrate_executed() {
    let env = Env::default();
    env.mock_all_auths();
    
    let admin = Address::generate(&env);
    let contract_id = env.register(GovernorContract, ());
    let client = GovernorContractClient::new(&env, &contract_id);
    
    client.initialize(
        &admin,
        &Address::generate(&env),
        &Address::generate(&env),
        &10, &100, &1, &0,
        &Address::generate(&env),
        &VoteType::Extended,
        &100
    );

    let migrate_data = MigrateData {
        new_version: 2,
    };

    env.as_contract(&contract_id, || {
        client.migrate(&migrate_data);
    });

    // Migration completed without panic; settings must remain intact.
    let settings = client.get_settings();
    assert_eq!(settings.voting_delay, 10);
}
