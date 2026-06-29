#[test]
#[should_panic(expected = "AlreadyInitialized")]
fn test_initialize_fails_if_called_twice() {
    let env = Env::default();
    env.mock_all_auths();
    
    // 1. Setup contract and generate test addresses
    let contract_id = env.register_contract(None, GovernorContract);
    let client = GovernorContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    
    // 2. First initialization (should succeed)
    client.initialize(&admin, /* provide dummy args for other params */);
    
    // 3. Second initialization (should panic with AlreadyInitialized)
    let attacker = Address::generate(&env);
    client.initialize(&attacker, /* provide dummy args for other params */);
}
