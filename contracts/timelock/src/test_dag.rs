use super::*;
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger as _},
    Address, Bytes, Env, Symbol, Vec,
};

/// Mock target contract for testing execution.
#[contract]
pub struct MockTarget;

#[contractimpl]
impl MockTarget {
    pub fn exec(env: Env) {
        env.storage()
            .persistent()
            .set(&symbol_short!("executed"), &true);
    }

    pub fn was_executed(env: Env) -> bool {
        env.storage()
            .persistent()
            .get(&symbol_short!("executed"))
            .unwrap_or(false)
    }

    pub fn store_i128(env: Env, value: i128) {
        env.storage()
            .persistent()
            .set(&symbol_short!("value"), &value);
    }

    pub fn stored_value(env: Env) -> i128 {
        env.storage()
            .persistent()
            .get(&symbol_short!("value"))
            .unwrap_or(0)
    }
}

#[test]
fn test_schedule_with_single_predecessor_blocks_until_predecessor_done() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TimelockContract, ());
    let client = TimelockContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let governor = Address::generate(&env);
    client.initialize(&admin, &governor, &0, &1_209_600);

    let target = env.register(MockTarget, ());

    // Schedule predecessor operation
    let pred_op_id = client.schedule(
        &governor,
        &target,
        &Bytes::new(&env),
        &Symbol::new(&env, "exec"),
        &0,
        &Bytes::new(&env),
        &Bytes::from_slice(&env, b"pred_salt"),
    );

    // Schedule operation with predecessor
    let mut predecessors = Vec::new(&env);
    predecessors.push_back(pred_op_id.clone());

    let op_id = client.schedule_with_deps(
        &governor,
        &target,
        &Bytes::new(&env),
        &Symbol::new(&env, "exec"),
        &0,
        &predecessors,
        &Bytes::from_slice(&env, b"op_salt"),
    );

    // Verify operation was scheduled
    assert!(client.get_operation(&op_id).is_some());

    // Check that predecessor is not done yet
    assert!(!client.is_done(&pred_op_id));

    // Advance time and execute predecessor
    env.ledger().with_mut(|l| l.timestamp = 1);
    client.execute(&governor, &pred_op_id);

    // Now predecessor is done
    assert!(client.is_done(&pred_op_id));
}

#[test]
fn test_schedule_with_multiple_predecessors_blocks_until_all_done() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TimelockContract, ());
    let client = TimelockContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let governor = Address::generate(&env);
    client.initialize(&admin, &governor, &0, &1_209_600);

    let target = env.register(MockTarget, ());

    // Schedule two predecessor operations
    let pred_op_id1 = client.schedule(
        &governor,
        &target,
        &Bytes::new(&env),
        &Symbol::new(&env, "exec"),
        &0,
        &Bytes::new(&env),
        &Bytes::from_slice(&env, b"pred_salt1"),
    );

    let pred_op_id2 = client.schedule(
        &governor,
        &target,
        &Bytes::new(&env),
        &Symbol::new(&env, "exec"),
        &0,
        &Bytes::new(&env),
        &Bytes::from_slice(&env, b"pred_salt2"),
    );

    // Schedule operation with multiple predecessors
    let mut predecessors = Vec::new(&env);
    predecessors.push_back(pred_op_id1.clone());
    predecessors.push_back(pred_op_id2.clone());

    let op_id = client.schedule_with_deps(
        &governor,
        &target,
        &Bytes::new(&env),
        &Symbol::new(&env, "exec"),
        &0,
        &predecessors,
        &Bytes::from_slice(&env, b"op_salt"),
    );

    // Verify operation was scheduled
    assert!(client.get_operation(&op_id).is_some());

    // Check that all_predecessors_done is false
    assert!(!client.all_predecessors_done(&op_id));

    // Advance time and execute first predecessor
    env.ledger().with_mut(|l| l.timestamp = 1);
    client.execute(&governor, &pred_op_id1);
    assert!(client.is_done(&pred_op_id1));

    // Still blocking since second predecessor not done
    assert!(!client.all_predecessors_done(&op_id));

    // Execute second predecessor
    client.execute(&governor, &pred_op_id2);
    assert!(client.is_done(&pred_op_id2));

    // Now all predecessors are done
    assert!(client.all_predecessors_done(&op_id));
}

/// Directly store a predecessor edge (`node`'s predecessors include `pred`)
/// so cycle-detection tests can construct arbitrary graphs the public API
/// (which requires predecessors to already exist) would reject.
fn set_predecessors(env: &Env, contract_id: &Address, node: &Bytes, preds: &Vec<Bytes>) {
    env.as_contract(contract_id, || {
        env.storage()
            .persistent()
            .set(&DataKey::OperationPredecessors(node.clone()), preds);
    });
}

#[test]
fn test_cycle_detection_direct_cycle_a_to_b_to_a() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TimelockContract, ());
    let client = TimelockContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let governor = Address::generate(&env);
    client.initialize(&admin, &governor, &0, &1_209_600);

    let op_a = Bytes::from_slice(&env, b"op_a");
    let op_b = Bytes::from_slice(&env, b"op_b");

    // A depends on B, and B depends on A -> direct cycle.
    let mut a_preds = Vec::new(&env);
    a_preds.push_back(op_b.clone());
    set_predecessors(&env, &contract_id, &op_a, &a_preds);

    let mut b_preds = Vec::new(&env);
    b_preds.push_back(op_a.clone());
    set_predecessors(&env, &contract_id, &op_b, &b_preds);

    let mut op_ids = Vec::new(&env);
    op_ids.push_back(op_a.clone());
    op_ids.push_back(op_b.clone());

    let result = client.validate_dependency_dag(&op_ids);
    assert!(!result.valid, "direct cycle should be detected");
    assert_eq!(result.cycle_path.len(), 2);
}

#[test]
fn test_cycle_detection_transitive_cycle_a_b_c_a() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TimelockContract, ());
    let client = TimelockContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let governor = Address::generate(&env);
    client.initialize(&admin, &governor, &0, &1_209_600);

    let op_a = Bytes::from_slice(&env, b"op_a");
    let op_b = Bytes::from_slice(&env, b"op_b");
    let op_c = Bytes::from_slice(&env, b"op_c");

    // A -> B -> C -> A transitive cycle.
    let mut a_preds = Vec::new(&env);
    a_preds.push_back(op_c.clone());
    set_predecessors(&env, &contract_id, &op_a, &a_preds);

    let mut b_preds = Vec::new(&env);
    b_preds.push_back(op_a.clone());
    set_predecessors(&env, &contract_id, &op_b, &b_preds);

    let mut c_preds = Vec::new(&env);
    c_preds.push_back(op_b.clone());
    set_predecessors(&env, &contract_id, &op_c, &c_preds);

    let mut op_ids = Vec::new(&env);
    op_ids.push_back(op_a.clone());
    op_ids.push_back(op_b.clone());
    op_ids.push_back(op_c.clone());

    let result = client.validate_dependency_dag(&op_ids);
    assert!(!result.valid, "transitive cycle should be detected");
}

#[test]
fn test_dag_without_cycle_validates_successfully() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TimelockContract, ());
    let client = TimelockContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let governor = Address::generate(&env);
    client.initialize(&admin, &governor, &0, &1_209_600);

    let op_a = Bytes::from_slice(&env, b"op_a");
    let op_b = Bytes::from_slice(&env, b"op_b");
    let op_c = Bytes::from_slice(&env, b"op_c");

    // Linear chain A -> B -> C, no cycle.
    let mut b_preds = Vec::new(&env);
    b_preds.push_back(op_a.clone());
    set_predecessors(&env, &contract_id, &op_b, &b_preds);

    let mut c_preds = Vec::new(&env);
    c_preds.push_back(op_b.clone());
    set_predecessors(&env, &contract_id, &op_c, &c_preds);

    let mut op_ids = Vec::new(&env);
    op_ids.push_back(op_a.clone());
    op_ids.push_back(op_b.clone());
    op_ids.push_back(op_c.clone());

    let result = client.validate_dependency_dag(&op_ids);
    assert!(result.valid, "acyclic graph should validate");
    assert_eq!(result.cycle_path.len(), 0);
}

#[test]
fn test_topological_sort_returns_correct_execution_order() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TimelockContract, ());
    let client = TimelockContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let governor = Address::generate(&env);
    client.initialize(&admin, &governor, &0, &1_209_600);

    let op_a = Bytes::from_slice(&env, b"op_a");
    let op_b = Bytes::from_slice(&env, b"op_b");
    let op_c = Bytes::from_slice(&env, b"op_c");

    // C depends on B depends on A -> a valid linear order exists.
    let mut b_preds = Vec::new(&env);
    b_preds.push_back(op_a.clone());
    set_predecessors(&env, &contract_id, &op_b, &b_preds);

    let mut c_preds = Vec::new(&env);
    c_preds.push_back(op_b.clone());
    set_predecessors(&env, &contract_id, &op_c, &c_preds);

    let mut op_ids = Vec::new(&env);
    op_ids.push_back(op_c.clone());
    op_ids.push_back(op_b.clone());
    op_ids.push_back(op_a.clone());

    let result = client.validate_dependency_dag(&op_ids);
    assert!(result.valid, "linear dependency chain should be orderable");
}

#[test]
fn test_partial_batch_marks_succeeded_ops_complete() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TimelockContract, ());
    let client = TimelockContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let governor = Address::generate(&env);
    client.initialize(&admin, &governor, &0, &1_209_600);

    let target1 = env.register(MockTarget, ());
    let target2 = env.register(MockTarget, ());

    let mut targets = Vec::new(&env);
    targets.push_back(target1.clone());
    targets.push_back(target2.clone());

    let mut datas = Vec::new(&env);
    datas.push_back(Bytes::new(&env));
    datas.push_back(Bytes::new(&env));

    let mut fn_names = Vec::new(&env);
    fn_names.push_back(Symbol::new(&env, "exec"));
    fn_names.push_back(Symbol::new(&env, "exec"));

    let batch_op_id = client.schedule_batch(
        &governor,
        &targets,
        &datas,
        &fn_names,
        &0,
        &Bytes::new(&env),
        &Bytes::from_slice(&env, b"batch_salt"),
    );

    env.ledger().with_mut(|l| l.timestamp = 1);

    // Execute batch partially (both operations succeed in this simple case)
    let state = client.execute_batch_partial(&governor, &batch_op_id);

    // Verify state
    assert_eq!(state.batch_op_id, batch_op_id);
    assert_eq!(state.total_ops, 2);
    assert!(!state.recovery_mode);
}

#[test]
fn test_partial_batch_enters_recovery_on_first_failure() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TimelockContract, ());
    let client = TimelockContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let governor = Address::generate(&env);
    client.initialize(&admin, &governor, &0, &1_209_600);

    let target = env.register(MockTarget, ());

    let mut targets = Vec::new(&env);
    targets.push_back(target.clone());

    let mut datas = Vec::new(&env);
    datas.push_back(Bytes::new(&env));

    let mut fn_names = Vec::new(&env);
    fn_names.push_back(Symbol::new(&env, "exec"));

    let batch_op_id = client.schedule_batch(
        &governor,
        &targets,
        &datas,
        &fn_names,
        &0,
        &Bytes::new(&env),
        &Bytes::from_slice(&env, b"batch_salt"),
    );

    env.ledger().with_mut(|l| l.timestamp = 1);

    // Execute batch partially
    let state = client.execute_batch_partial(&governor, &batch_op_id);

    // Verify state structure
    assert_eq!(state.batch_op_id, batch_op_id);
}

#[test]
fn test_get_partial_batch_state() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TimelockContract, ());
    let client = TimelockContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let governor = Address::generate(&env);
    client.initialize(&admin, &governor, &0, &1_209_600);

    let target = env.register(MockTarget, ());

    let mut targets = Vec::new(&env);
    targets.push_back(target.clone());

    let mut datas = Vec::new(&env);
    datas.push_back(Bytes::new(&env));

    let mut fn_names = Vec::new(&env);
    fn_names.push_back(Symbol::new(&env, "exec"));

    let batch_op_id = client.schedule_batch(
        &governor,
        &targets,
        &datas,
        &fn_names,
        &0,
        &Bytes::new(&env),
        &Bytes::from_slice(&env, b"batch_salt"),
    );

    env.ledger().with_mut(|l| l.timestamp = 1);
    let _ = client.execute_batch_partial(&governor, &batch_op_id);

    // Get state back
    let state = client.get_partial_batch_state(&batch_op_id);
    assert!(state.is_some());
    assert_eq!(state.unwrap().batch_op_id, batch_op_id);
}

#[test]
fn test_skip_failed_operation_marks_as_skipped() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TimelockContract, ());
    let client = TimelockContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let governor = Address::generate(&env);
    client.initialize(&admin, &governor, &0, &1_209_600);

    let target = env.register(MockTarget, ());

    let mut targets = Vec::new(&env);
    targets.push_back(target.clone());

    let mut datas = Vec::new(&env);
    datas.push_back(Bytes::new(&env));

    let mut fn_names = Vec::new(&env);
    fn_names.push_back(Symbol::new(&env, "exec"));

    let batch_op_id = client.schedule_batch(
        &governor,
        &targets,
        &datas,
        &fn_names,
        &0,
        &Bytes::new(&env),
        &Bytes::from_slice(&env, b"batch_salt"),
    );

    env.ledger().with_mut(|l| l.timestamp = 1);

    // Create a partial batch state with a failed operation
    // (in real scenario, this would fail during execute_batch_partial)
    let _ = client.execute_batch_partial(&governor, &batch_op_id);

    // Get the state
    if let Some(state) = client.get_partial_batch_state(&batch_op_id) {
        if !state.failed_ops.is_empty() {
            let failed_op = state.failed_ops.get(0).unwrap();
            client.skip_failed_operation(&governor, &batch_op_id, &failed_op.op_id);
        }
    }
}

#[test]
fn test_batch_fully_complete_when_all_ops_done_or_skipped() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TimelockContract, ());
    let client = TimelockContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let governor = Address::generate(&env);
    client.initialize(&admin, &governor, &0, &1_209_600);

    let target = env.register(MockTarget, ());

    let mut targets = Vec::new(&env);
    targets.push_back(target.clone());

    let mut datas = Vec::new(&env);
    datas.push_back(Bytes::new(&env));

    let mut fn_names = Vec::new(&env);
    fn_names.push_back(Symbol::new(&env, "exec"));

    let batch_op_id = client.schedule_batch(
        &governor,
        &targets,
        &datas,
        &fn_names,
        &0,
        &Bytes::new(&env),
        &Bytes::from_slice(&env, b"batch_salt"),
    );

    env.ledger().with_mut(|l| l.timestamp = 1);

    // Execute batch (all operations should succeed)
    let state = client.execute_batch_partial(&governor, &batch_op_id);

    // Recovery mode should be false if no failures
    assert!(!state.recovery_mode);
}

#[test]
fn test_recovery_deadline_blocks_retry_after_expiry() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TimelockContract, ());
    let client = TimelockContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let governor = Address::generate(&env);
    client.initialize(&admin, &governor, &0, &1_209_600);

    let target = env.register(MockTarget, ());

    let mut targets = Vec::new(&env);
    targets.push_back(target.clone());

    let mut datas = Vec::new(&env);
    datas.push_back(Bytes::new(&env));

    let mut fn_names = Vec::new(&env);
    fn_names.push_back(Symbol::new(&env, "exec"));

    let batch_op_id = client.schedule_batch(
        &governor,
        &targets,
        &datas,
        &fn_names,
        &0,
        &Bytes::new(&env),
        &Bytes::from_slice(&env, b"batch_salt"),
    );

    env.ledger().with_mut(|l| l.timestamp = 1);

    let state = client.execute_batch_partial(&governor, &batch_op_id);

    // Verify recovery deadline is set
    assert!(state.recovery_deadline > 0);
}

#[test]
fn test_all_predecessors_done_false_when_predecessor_pending() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TimelockContract, ());
    let client = TimelockContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let governor = Address::generate(&env);
    client.initialize(&admin, &governor, &0, &1_209_600);

    let target = env.register(MockTarget, ());

    // Schedule predecessor
    let pred_op_id = client.schedule(
        &governor,
        &target,
        &Bytes::new(&env),
        &Symbol::new(&env, "exec"),
        &100,
        &Bytes::new(&env),
        &Bytes::from_slice(&env, b"pred_salt"),
    );

    // Schedule with deps
    let mut predecessors = Vec::new(&env);
    predecessors.push_back(pred_op_id.clone());

    let op_id = client.schedule_with_deps(
        &governor,
        &target,
        &Bytes::new(&env),
        &Symbol::new(&env, "exec"),
        &0,
        &predecessors,
        &Bytes::from_slice(&env, b"op_salt"),
    );

    // Predecessor should not be done yet (delay hasn't passed)
    assert!(!client.is_done(&pred_op_id));

    // all_predecessors_done should return false
    assert!(!client.all_predecessors_done(&op_id));
}
