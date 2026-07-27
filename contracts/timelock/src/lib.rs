#![no_std]
#![allow(clippy::too_many_arguments)]

mod events;
use events::*;

use soroban_sdk::xdr::{FromXdr, ToXdr};
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Bytes, Env, Symbol,
    Val, Vec,
};

/// Timelock error codes.
#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TimelockError {
    /// Operation has not yet been executed but is required as a predecessor.
    PredecessorNotDone = 1,
    /// Operation references a predecessor operation that does not exist.
    PredecessorNotFound = 2,
    /// Operation can no longer be executed because its execution window elapsed.
    OperationExpired = 3,
    /// A cycle was detected in the dependency graph.
    DependencyCycleDetected = 10,
    /// A predecessor has not completed yet.
    PredecessorNotComplete = 11,
    /// Batch is in recovery mode.
    BatchInRecoveryMode = 12,
    /// Batch recovery deadline has expired.
    BatchRecoveryExpired = 13,
    /// Operation is already in a batch.
    OperationAlreadyInBatch = 14,
    /// Invalid predecessor list provided.
    InvalidPredecessorList = 15,
}

/// A scheduled timelock operation.
#[contracttype]
#[derive(Clone)]
pub struct Operation {
    pub target: Address,
    pub data: Bytes,
    pub fn_name: Symbol,
    pub ready_at: u64,
    pub expires_at: u64,
    pub executed: bool,
    pub cancelled: bool,
    pub predecessor: Bytes,
}

/// A scheduled batch timelock operation.
///
/// Stores all sub-operations under a single `batch_op_id`.  Execution is
/// all-or-nothing: if any sub-call panics, the entire batch reverts.
#[contracttype]
#[derive(Clone)]
pub struct BatchOperation {
    pub targets: Vec<Address>,
    pub datas: Vec<Bytes>,
    pub fn_names: Vec<Symbol>,
    pub ready_at: u64,
    pub expires_at: u64,
    pub executed: bool,
    pub cancelled: bool,
    pub predecessor: Bytes,
}

/// Dependency edge in the DAG.
#[contracttype]
#[derive(Clone)]
pub struct DependencyEdge {
    pub from: Bytes,
    pub to: Bytes,
}

/// Dependency graph structure for batch operations.
#[contracttype]
#[derive(Clone)]
pub struct DependencyGraph {
    pub nodes: Vec<Bytes>,
    pub edges: Vec<DependencyEdge>,
}

/// Result of validating a dependency graph for cycles.
///
/// `valid` is true when the operations form a DAG. When false, `cycle_path`
/// contains the operations that could not be topologically ordered (the nodes
/// participating in, or blocked by, a cycle).
#[contracttype]
#[derive(Clone)]
pub struct DagValidationResult {
    pub valid: bool,
    pub cycle_path: Vec<Bytes>,
}

/// Failed operation details for recovery.
#[contracttype]
#[derive(Clone)]
pub struct FailedOperation {
    pub op_id: Bytes,
    pub target: Address,
    pub fn_name: Symbol,
    pub data: Bytes,
    pub failure_reason: Symbol,
    pub failed_at_ledger: u32,
    pub retry_count: u32,
}

/// Partial batch execution state for recovery mode.
#[contracttype]
#[derive(Clone)]
pub struct PartialBatchExecutionState {
    pub batch_op_id: Bytes,
    pub total_ops: u32,
    pub completed_ops: Vec<Bytes>,
    pub failed_ops: Vec<FailedOperation>,
    pub pending_ops: Vec<Bytes>,
    pub recovery_mode: bool,
    pub recovery_deadline: u32,
}

#[contracttype]
pub enum DataKey {
    Operation(Bytes),
    BatchOperation(Bytes),
    MinDelay,
    ExecutionWindow,
    Admin,
    Governor,
    OperationPredecessors(Bytes),
    OperationSuccessors(Bytes),
    BatchDependencyGraph(Bytes),
    PartialBatchState(Bytes),
    FailedOpRetryCount(Bytes),
}

#[contract]
pub struct TimelockContract;

#[contractimpl]
impl TimelockContract {
    /// Initialize timelock with minimum delay, execution window, admin, and governor.
    pub fn initialize(
        env: Env,
        admin: Address,
        governor: Address,
        min_delay: u64,
        execution_window: u64,
    ) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Governor, &governor);
        env.storage().instance().set(&DataKey::MinDelay, &min_delay);
        env.storage()
            .instance()
            .set(&DataKey::ExecutionWindow, &execution_window);
    }

    /// Compute operation ID from target, data, predecessor, and salt.
    pub fn compute_op_id(
        env: Env,
        target: Address,
        data: Bytes,
        predecessor: Bytes,
        salt: Bytes,
    ) -> Bytes {
        let mut combined = Bytes::new(&env);
        combined.append(&target.to_xdr(&env));
        combined.append(&data);
        combined.append(&predecessor);
        combined.append(&salt);

        let hash = env.crypto().sha256(&combined);
        Bytes::from_array(&env, &hash.to_array())
    }

    /// Compute a deterministic batch op_id from all sub-operation tuples combined
    /// with a single predecessor and salt.
    ///
    /// Same inputs always produce the same ID, so scheduling is idempotent.
    pub fn compute_batch_op_id(
        env: Env,
        targets: Vec<Address>,
        datas: Vec<Bytes>,
        fn_names: Vec<Symbol>,
        predecessor: Bytes,
        salt: Bytes,
    ) -> Bytes {
        let mut combined = Bytes::new(&env);
        for i in 0..targets.len() {
            combined.append(&targets.get(i).unwrap().to_xdr(&env));
            combined.append(&datas.get(i).unwrap());
            combined.append(&fn_names.get(i).unwrap().to_xdr(&env));
        }
        combined.append(&predecessor);
        combined.append(&salt);

        let hash = env.crypto().sha256(&combined);
        Bytes::from_array(&env, &hash.to_array())
    }

    /// Schedule an operation with multiple predecessor dependencies.
    #[allow(clippy::too_many_arguments)]
    pub fn schedule_with_deps(
        env: Env,
        caller: Address,
        target: Address,
        data: Bytes,
        fn_name: Symbol,
        delay: u64,
        predecessors: Vec<Bytes>,
        salt: Bytes,
    ) -> Bytes {
        caller.require_auth();
        Self::require_governor(&env, &caller);

        for pred in predecessors.iter() {
            Self::validate_predecessor(&env, &pred);
        }

        let op_id =
            Self::schedule_operation(env.clone(), target, data, fn_name, delay, Bytes::new(&env), salt);

        // Persist the predecessor set so all_predecessors_done() and the
        // topological sort can resolve this operation's dependencies later.
        if !predecessors.is_empty() {
            env.storage()
                .persistent()
                .set(&DataKey::OperationPredecessors(op_id.clone()), &predecessors);
        }

        op_id
    }

    /// Check if all predecessors of an op_id are complete.
    pub fn all_predecessors_done(env: Env, op_id: Bytes) -> bool {
        let pred_key = DataKey::OperationPredecessors(op_id.clone());
        let predecessors: Option<Vec<Bytes>> = env.storage().persistent().get(&pred_key);

        match predecessors {
            None => true,
            Some(preds) => {
                for pred in preds {
                    let is_done =
                        Self::is_done(env.clone(), pred.clone())
                            || Self::is_batch_done(env.clone(), pred.clone());
                    if !is_done {
                        return false;
                    }
                }
                true
            }
        }
    }

    /// Get the full dependency graph for a batch operation.
    pub fn get_batch_dependency_graph(env: Env, batch_op_id: Bytes) -> Option<DependencyGraph> {
        let graph_key = DataKey::BatchDependencyGraph(batch_op_id);
        env.storage().persistent().get(&graph_key)
    }

    /// Validate that a set of operations forms a DAG (no cycles).
    ///
    /// Returns a [`DagValidationResult`] with `valid = true` and an empty
    /// `cycle_path` when the operations can be topologically ordered. When a
    /// cycle is present, `valid = false` and `cycle_path` lists the operations
    /// that could not be ordered.
    pub fn validate_dependency_dag(env: Env, op_ids: Vec<Bytes>) -> DagValidationResult {
        match Self::kahn_topological_sort(&env, &op_ids) {
            Ok(_) => {
                emit_dependency_dag_validated(&env, &Bytes::new(&env), op_ids.len());
                DagValidationResult {
                    valid: true,
                    cycle_path: Vec::new(&env),
                }
            }
            Err(()) => {
                emit_cycle_detected(&env, &op_ids);
                DagValidationResult {
                    valid: false,
                    cycle_path: op_ids,
                }
            }
        }
    }

    /// Execute a batch with partial completion tolerance (queues for recovery on any failure).
    /// Each sub-operation is attempted independently. If one fails, it is recorded in recovery state
    /// and the batch continues to the next operation.
    pub fn execute_batch_partial(env: Env, caller: Address, batch_op_id: Bytes) -> PartialBatchExecutionState {
        caller.require_auth();
        Self::require_governor(&env, &caller);

        let batch: BatchOperation = env
            .storage()
            .persistent()
            .get(&DataKey::BatchOperation(batch_op_id.clone()))
            .unwrap_or_else(|| env.panic_with_error(TimelockError::PredecessorNotFound));

        if batch.executed || batch.cancelled {
            env.panic_with_error(TimelockError::OperationExpired);
        }
        if env.ledger().timestamp() < batch.ready_at {
            env.panic_with_error(TimelockError::PredecessorNotComplete);
        }

        let mut completed_ops: Vec<Bytes> = Vec::new(&env);
        let mut failed_ops: Vec<FailedOperation> = Vec::new(&env);
        let mut recovery_mode = false;

        for i in 0..batch.targets.len() {
            let op_id = Self::hash_op_in_batch(
                &env,
                &batch.targets.get(i).unwrap(),
                &batch.datas.get(i).unwrap(),
                &batch.fn_names.get(i).unwrap(),
                i,
            );

            let target = batch.targets.get(i).unwrap();
            let fn_name = batch.fn_names.get(i).unwrap();
            let data = batch.datas.get(i).unwrap();
            let args = Self::decode_invocation_args(&env, &data);

            let invocation_result = env.try_invoke_contract::<(), soroban_sdk::Error>(&target, &fn_name, args);
            match invocation_result {
                Ok(Ok(_)) => {
                    completed_ops.push_back(op_id.clone());
                    emit_partial_op_succeeded(
                        &env,
                        &batch_op_id,
                        &op_id,
                        completed_ops.len(),
                        batch.targets.len(),
                    );
                }
                Ok(Err(_)) | Err(_) => {
                    let failed_op = FailedOperation {
                        op_id: op_id.clone(),
                        target: target.clone(),
                        fn_name: fn_name.clone(),
                        data: data.clone(),
                        failure_reason: symbol_short!("failed"),
                        failed_at_ledger: env.ledger().sequence(),
                        retry_count: 0,
                    };
                    failed_ops.push_back(failed_op);
                    recovery_mode = true;
                    emit_partial_op_failed(&env, &batch_op_id, &op_id);
                }
            }
        }

        let recovery_deadline = env.ledger().sequence() + 100_000;
        let state = PartialBatchExecutionState {
            batch_op_id: batch_op_id.clone(),
            total_ops: batch.targets.len(),
            completed_ops: completed_ops.clone(),
            failed_ops: failed_ops.clone(),
            pending_ops: Vec::new(&env),
            recovery_mode,
            recovery_deadline,
        };

        let state_key = DataKey::PartialBatchState(batch_op_id.clone());
        env.storage().persistent().set(&state_key, &state);

        if recovery_mode {
            emit_batch_recovery_entered(&env, &batch_op_id, recovery_deadline);
        }

        emit_partial_batch_started(&env, &batch_op_id, batch.targets.len());

        state
    }

    /// Retry a specific failed operation within a batch in recovery mode.
    /// Note: This function attempts to invoke the operation. If it fails again, the transaction reverts.
    pub fn retry_failed_operation(
        env: Env,
        caller: Address,
        batch_op_id: Bytes,
        op_id: Bytes,
    ) {
        caller.require_auth();
        Self::require_governor(&env, &caller);

        let state_key = DataKey::PartialBatchState(batch_op_id.clone());
        let mut state: PartialBatchExecutionState = env
            .storage()
            .persistent()
            .get(&state_key)
            .unwrap_or_else(|| env.panic_with_error(TimelockError::PredecessorNotFound));

        if !state.recovery_mode {
            env.panic_with_error(TimelockError::BatchInRecoveryMode);
        }
        if env.ledger().sequence() >= state.recovery_deadline {
            env.panic_with_error(TimelockError::BatchRecoveryExpired);
        }

        let failed_op_index = Self::failed_op_index(&state.failed_ops, &op_id)
            .unwrap_or_else(|| env.panic_with_error(TimelockError::InvalidPredecessorList));

        let failed_op = state.failed_ops.get(failed_op_index).unwrap().clone();
        let mut retry_count: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::FailedOpRetryCount(op_id.clone()))
            .unwrap_or(0);

        retry_count += 1;
        env.storage()
            .persistent()
            .set(&DataKey::FailedOpRetryCount(op_id.clone()), &retry_count);

        // Invoke the contract with original calldata. If it fails, the transaction reverts (standard behavior).
        let args = Self::decode_invocation_args(&env, &failed_op.data);
        env.invoke_contract::<()>(&failed_op.target, &failed_op.fn_name, args);

        // If we reach here, invocation succeeded
        state.failed_ops.remove(failed_op_index);
        state.completed_ops.push_back(op_id.clone());
        emit_failed_op_retried(&env, &batch_op_id, &op_id, retry_count, true);

        if state.failed_ops.is_empty() {
            state.recovery_mode = false;
            emit_batch_fully_complete(&env, &batch_op_id);
        }

        env.storage().persistent().set(&state_key, &state);
    }

    /// Get current partial execution state for a batch.
    pub fn get_partial_batch_state(env: Env, batch_op_id: Bytes) -> Option<PartialBatchExecutionState> {
        let state_key = DataKey::PartialBatchState(batch_op_id);
        env.storage().persistent().get(&state_key)
    }

    /// Mark a failed operation as permanently skipped.
    pub fn skip_failed_operation(
        env: Env,
        caller: Address,
        batch_op_id: Bytes,
        op_id: Bytes,
    ) {
        caller.require_auth();
        Self::require_governor(&env, &caller);

        let state_key = DataKey::PartialBatchState(batch_op_id.clone());
        let mut state: PartialBatchExecutionState = env
            .storage()
            .persistent()
            .get(&state_key)
            .unwrap_or_else(|| env.panic_with_error(TimelockError::PredecessorNotFound));

        let failed_op_index = Self::failed_op_index(&state.failed_ops, &op_id)
            .unwrap_or_else(|| env.panic_with_error(TimelockError::InvalidPredecessorList));

        state.failed_ops.remove(failed_op_index);
        emit_failed_op_skipped(&env, &batch_op_id, &op_id);

        if state.failed_ops.is_empty() {
            state.recovery_mode = false;
            emit_batch_fully_complete(&env, &batch_op_id);
        }

        env.storage().persistent().set(&state_key, &state);
    }

    /// Schedule a single operation.
    #[allow(clippy::too_many_arguments)]
    pub fn schedule(
        env: Env,
        caller: Address,
        target: Address,
        data: Bytes,
        fn_name: Symbol,
        delay: u64,
        predecessor: Bytes,
        salt: Bytes,
    ) -> Bytes {
        caller.require_auth();
        Self::require_governor(&env, &caller);
        Self::schedule_operation(env, target, data, fn_name, delay, predecessor, salt)
    }

    /// Schedule multiple operations as a single atomic batch.
    ///
    /// Unlike the previous N-op-id design, this returns **one** `batch_op_id`
    /// covering all sub-operations.  Use [`execute_batch`] to run them all at
    /// once.  A single `predecessor` and `salt` apply to the whole batch.
    #[allow(clippy::too_many_arguments)]
    pub fn schedule_batch(
        env: Env,
        caller: Address,
        targets: Vec<Address>,
        datas: Vec<Bytes>,
        fn_names: Vec<Symbol>,
        delay: u64,
        predecessor: Bytes,
        salt: Bytes,
    ) -> Bytes {
        caller.require_auth();
        Self::require_governor(&env, &caller);

        let len = targets.len();
        assert!(len > 0, "empty batch");
        assert!(len == datas.len(), "length mismatch");
        assert!(len == fn_names.len(), "length mismatch");

        Self::validate_predecessor(&env, &predecessor);

        let min_delay = Self::min_delay(env.clone());
        assert!(delay >= min_delay, "delay too short");

        let execution_window = Self::execution_window(env.clone());
        let ready_at = env.ledger().timestamp() + delay;
        let expires_at = ready_at + execution_window;

        let batch_op_id = Self::compute_batch_op_id(
            env.clone(),
            targets.clone(),
            datas.clone(),
            fn_names.clone(),
            predecessor.clone(),
            salt,
        );

        let batch = BatchOperation {
            targets: targets.clone(),
            datas,
            fn_names: fn_names.clone(),
            ready_at,
            expires_at,
            executed: false,
            cancelled: false,
            predecessor,
        };

        env.storage()
            .persistent()
            .set(&DataKey::BatchOperation(batch_op_id.clone()), &batch);

        Self::persist_batch_dependency_graph(env.clone(), &batch_op_id, &batch.predecessor);

        // Extend TTL to cover the full operation lifecycle (delay + execution window)
        // plus a safety buffer. Stellar mainnet closes ledgers roughly every 5 seconds.
        let seconds_until_expiry = delay + execution_window;
        let ttl_ledgers = ((seconds_until_expiry / 5) + 1000) as u32;
        env.storage()
            .persistent()
            .extend_ttl(
                &DataKey::BatchOperation(batch_op_id.clone()),
                ttl_ledgers,
                ttl_ledgers,
            );

        env.events()
            .publish((symbol_short!("schbatch"),), batch_op_id.clone());
        emit_batch_operation_scheduled(
            &env,
            &batch_op_id,
            &targets,
            &fn_names,
            ready_at,
            expires_at,
        );

        batch_op_id
    }

    /// Execute a ready operation.
    pub fn execute(env: Env, caller: Address, op_id: Bytes) {
        caller.require_auth();
        Self::require_governor(&env, &caller);

        let mut op: Operation = env
            .storage()
            .persistent()
            .get(&DataKey::Operation(op_id.clone()))
            .unwrap_or_else(|| env.panic_with_error(TimelockError::PredecessorNotFound));

        if op.executed || op.cancelled {
            env.panic_with_error(TimelockError::OperationExpired);
        }
        if env.ledger().timestamp() < op.ready_at {
            env.panic_with_error(TimelockError::PredecessorNotComplete);
        }
        if env.ledger().timestamp() > op.expires_at {
            env.panic_with_error(TimelockError::OperationExpired);
        }

        if !op.predecessor.is_empty() {
            let pred_done = Self::is_done(env.clone(), op.predecessor.clone())
                || Self::is_batch_done(env.clone(), op.predecessor.clone());
            if !pred_done {
                env.panic_with_error(TimelockError::PredecessorNotDone);
            }
        }

        // Also check schedule_with_deps predecessors
        if !Self::all_predecessors_done(env.clone(), op_id.clone()) {
            env.panic_with_error(TimelockError::PredecessorNotDone);
        }

        op.executed = true;
        env.storage()
            .persistent()
            .set(&DataKey::Operation(op_id.clone()), &op);

        let args = Self::decode_invocation_args(&env, &op.data);
        let _: Val = env.invoke_contract(&op.target, &op.fn_name, args);

        env.events().publish((symbol_short!("execute"),), op_id.clone());
        emit_operation_executed(&env, &op_id, &caller);
    }

    /// Execute a batch of operations atomically under a single `batch_op_id`.
    ///
    /// All sub-calls run in order.  If any sub-call panics, the entire
    /// transaction reverts and none of the sub-calls take effect.
    pub fn execute_batch(env: Env, caller: Address, batch_op_id: Bytes) {
        caller.require_auth();
        Self::require_governor(&env, &caller);

        let mut batch: BatchOperation = env
            .storage()
            .persistent()
            .get(&DataKey::BatchOperation(batch_op_id.clone()))
            .unwrap_or_else(|| env.panic_with_error(TimelockError::PredecessorNotFound));

        if batch.executed || batch.cancelled {
            env.panic_with_error(TimelockError::OperationExpired);
        }
        if env.ledger().timestamp() < batch.ready_at {
            env.panic_with_error(TimelockError::PredecessorNotComplete);
        }
        if env.ledger().timestamp() > batch.expires_at {
            env.panic_with_error(TimelockError::OperationExpired);
        }

        if !batch.predecessor.is_empty() {
            let pred_done = Self::is_done(env.clone(), batch.predecessor.clone())
                || Self::is_batch_done(env.clone(), batch.predecessor.clone());
            if !pred_done {
                env.panic_with_error(TimelockError::PredecessorNotDone);
            }
        }

        batch.executed = true;
        env.storage()
            .persistent()
            .set(&DataKey::BatchOperation(batch_op_id.clone()), &batch);

        for i in 0..batch.targets.len() {
            let target = batch.targets.get(i).unwrap();
            let fn_name = batch.fn_names.get(i).unwrap();
            let data = batch.datas.get(i).unwrap();
            let args = Self::decode_invocation_args(&env, &data);
            let _: Val = env.invoke_contract(&target, &fn_name, args);
        }

        env.events()
            .publish((symbol_short!("exbatch"),), batch_op_id.clone());
        emit_batch_operation_executed(&env, &batch_op_id, &caller);
    }

    /// Cancel a pending operation or batch operation.
    pub fn cancel(env: Env, caller: Address, op_id: Bytes) {
        caller.require_auth();

        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        let governor: Address = env
            .storage()
            .instance()
            .get(&DataKey::Governor)
            .expect("not initialized");
        assert!(caller == admin || caller == governor, "not authorized");

        // Try single operation first, then batch operation.
        if let Some(mut op) = env
            .storage()
            .persistent()
            .get::<_, Operation>(&DataKey::Operation(op_id.clone()))
        {
            assert!(!op.executed && !op.cancelled, "invalid state");
            op.cancelled = true;
            env.storage()
                .persistent()
                .set(&DataKey::Operation(op_id.clone()), &op);
            emit_operation_cancelled(&env, &op_id, &caller);
        } else if let Some(mut batch) = env
            .storage()
            .persistent()
            .get::<_, BatchOperation>(&DataKey::BatchOperation(op_id.clone()))
        {
            assert!(!batch.executed && !batch.cancelled, "invalid state");
            batch.cancelled = true;
            env.storage()
                .persistent()
                .set(&DataKey::BatchOperation(op_id.clone()), &batch);
            emit_batch_operation_cancelled(&env, &op_id, &caller);
        } else {
            panic!("operation not found");
        }

        env.events().publish((symbol_short!("cancel"),), op_id);
    }

    /// Check whether an operation is pending.
    pub fn is_pending(env: Env, op_id: Bytes) -> bool {
        let op: Option<Operation> = env.storage().persistent().get(&DataKey::Operation(op_id));
        match op {
            Some(op) => !op.executed && !op.cancelled && env.ledger().timestamp() < op.ready_at,
            None => false,
        }
    }

    /// Check whether an operation is ready.
    pub fn is_ready(env: Env, op_id: Bytes) -> bool {
        let op: Option<Operation> = env.storage().persistent().get(&DataKey::Operation(op_id));
        match op {
            Some(op) => {
                !op.executed
                    && !op.cancelled
                    && env.ledger().timestamp() >= op.ready_at
                    && env.ledger().timestamp() <= op.expires_at
            }
            None => false,
        }
    }

    /// Check whether an operation has been executed.
    pub fn is_done(env: Env, op_id: Bytes) -> bool {
        let op: Option<Operation> = env.storage().persistent().get(&DataKey::Operation(op_id));
        match op {
            Some(op) => op.executed,
            None => false,
        }
    }

    /// Check whether a batch operation has been executed.
    pub fn is_batch_done(env: Env, batch_op_id: Bytes) -> bool {
        let batch: Option<BatchOperation> = env
            .storage()
            .persistent()
            .get(&DataKey::BatchOperation(batch_op_id));
        match batch {
            Some(b) => b.executed,
            None => false,
        }
    }

    /// Get the configured minimum delay in seconds.
    pub fn min_delay(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::MinDelay)
            .unwrap_or(86_400)
    }

    /// Get the configured execution window in seconds.
    pub fn execution_window(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::ExecutionWindow)
            .unwrap_or(1_209_600)
    }

    /// Get the configured governor address.
    pub fn governor(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Governor)
            .expect("not initialized")
    }

    /// Get the configured admin address.
    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized")
    }

    /// Get a single operation by its op_id.
    pub fn get_operation(env: Env, op_id: Bytes) -> Option<Operation> {
        env.storage()
            .persistent()
            .get(&DataKey::Operation(op_id))
    }

    /// Get a batch operation by its batch_op_id.
    pub fn get_batch_operation(env: Env, batch_op_id: Bytes) -> Option<BatchOperation> {
        env.storage()
            .persistent()
            .get(&DataKey::BatchOperation(batch_op_id))
    }

    /// Update the minimum delay. Only admin.
    pub fn update_delay(env: Env, caller: Address, new_delay: u64) {
        caller.require_auth();
        assert!(caller == Self::admin(env.clone()), "only admin");
        let old_delay: u64 = env.storage().instance().get(&DataKey::MinDelay).unwrap_or(86400);
        env.storage().instance().set(&DataKey::MinDelay, &new_delay);
        env.events().publish(
            (symbol_short!("upd_dly"),),
            (old_delay, new_delay),
        );
    }

    /// Update the execution window. Only admin.
    pub fn update_execution_window(env: Env, caller: Address, new_window: u64) {
        caller.require_auth();
        assert!(caller == Self::admin(env.clone()), "only admin");
        let old_window: u64 = env.storage().instance().get(&DataKey::ExecutionWindow).unwrap_or(1209600);
        env.storage()
            .instance()
            .set(&DataKey::ExecutionWindow, &new_window);
        env.events().publish(
            (symbol_short!("upd_win"),),
            (old_window, new_window),
        );
    }

    /// Update the minimum delay. Only governor (governance-gated).
    pub fn update_min_delay(env: Env, caller: Address, new_delay: u64) {
        caller.require_auth();
        Self::require_governor(&env, &caller);
        assert!(new_delay > 0, "delay must be positive");
        let execution_window: u64 = env.storage().instance().get(&DataKey::ExecutionWindow).unwrap_or(1_209_600);
        assert!(
            new_delay.checked_add(execution_window).is_some(),
            "delay + execution_window overflow"
        );
        let old_delay: u64 = env.storage()
            .instance()
            .get(&DataKey::MinDelay)
            .unwrap_or(86_400);
        env.storage().instance().set(&DataKey::MinDelay, &new_delay);
        emit_min_delay_updated(&env, old_delay, new_delay);
    }

    fn require_governor(env: &Env, caller: &Address) {
        let governor: Address = env
            .storage()
            .instance()
            .get(&DataKey::Governor)
            .expect("not initialized");
        assert!(caller == &governor, "only governor");
    }

    fn schedule_operation(
        env: Env,
        target: Address,
        data: Bytes,
        fn_name: Symbol,
        delay: u64,
        predecessor: Bytes,
        salt: Bytes,
    ) -> Bytes {
        Self::validate_predecessor(&env, &predecessor);

        let min_delay = Self::min_delay(env.clone());
        assert!(delay >= min_delay, "delay too short");

        let execution_window = Self::execution_window(env.clone());
        let ready_at = env.ledger().timestamp() + delay;
        let expires_at = ready_at + execution_window;
        let op_id = Self::compute_op_id(
            env.clone(),
            target.clone(),
            data.clone(),
            predecessor.clone(),
            salt,
        );

        let op = Operation {
            target: target.clone(),
            data,
            fn_name: fn_name.clone(),
            ready_at,
            expires_at,
            executed: false,
            cancelled: false,
            predecessor,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Operation(op_id.clone()), &op);

        // Extend TTL to cover the full operation lifecycle (delay + execution window)
        // plus a safety buffer. Stellar mainnet closes ledgers roughly every 5 seconds.
        let seconds_until_expiry = delay + execution_window;
        let ttl_ledgers = ((seconds_until_expiry / 5) + 1000) as u32;
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Operation(op_id.clone()), ttl_ledgers, ttl_ledgers);

        env.events()
            .publish((symbol_short!("schedule"),), op_id.clone());
        emit_operation_scheduled(&env, &op_id, &target, &fn_name, ready_at, expires_at);

        op_id
    }

    fn persist_batch_dependency_graph(env: Env, batch_op_id: &Bytes, predecessor: &Bytes) {
        let mut nodes = Vec::new(&env);
        nodes.push_back(batch_op_id.clone());

        let mut edges = Vec::new(&env);
        if !predecessor.is_empty() {
            nodes.push_back(predecessor.clone());
            edges.push_back(DependencyEdge {
                from: predecessor.clone(),
                to: batch_op_id.clone(),
            });
        }

        let graph = DependencyGraph { nodes, edges };
        env.storage()
            .persistent()
            .set(&DataKey::BatchDependencyGraph(batch_op_id.clone()), &graph);
    }

    fn validate_predecessor(env: &Env, predecessor: &Bytes) {
        if predecessor.is_empty() {
            return;
        }

        let op_exists = env
            .storage()
            .persistent()
            .has(&DataKey::Operation(predecessor.clone()));
        let batch_exists = env
            .storage()
            .persistent()
            .has(&DataKey::BatchOperation(predecessor.clone()));

        if !op_exists && !batch_exists {
            env.panic_with_error(TimelockError::PredecessorNotFound);
        }
    }

    fn decode_invocation_args(env: &Env, data: &Bytes) -> Vec<Val> {
        if data.is_empty() {
            return Vec::new(env);
        }

        if let Ok(args) = Vec::<Val>::from_xdr(env, data) {
            return args;
        }

        // Preserve compatibility with legacy callers that used opaque bytes for
        // no-arg calls before structured calldata decoding was implemented.
        Vec::new(env)
    }

    fn hash_op_in_batch(
        env: &Env,
        target: &Address,
        data: &Bytes,
        fn_name: &Symbol,
        index: u32,
    ) -> Bytes {
        let mut combined = Bytes::new(env);
        combined.append(&target.to_xdr(env));
        combined.append(data);
        combined.append(&fn_name.to_xdr(env));
        combined.append(&index.to_xdr(env));

        let hash = env.crypto().sha256(&combined);
        Bytes::from_array(env, &hash.to_array())
    }

    /// Find the index of `needle` within `haystack`, or `None` if absent.
    ///
    /// Soroban's `Vec` has no `iter_mut`/`position`, so index-based lookups
    /// are used throughout the topological sort helper below.
    fn index_of(haystack: &Vec<Bytes>, needle: &Bytes) -> Option<u32> {
        let len = haystack.len();
        let mut i = 0u32;
        while i < len {
            if &haystack.get(i).unwrap() == needle {
                return Some(i);
            }
            i += 1;
        }
        None
    }

    /// Find the index of the failed operation whose `op_id` matches, if any.
    ///
    /// Returns a `u32` index suitable for Soroban `Vec` get/remove, since the
    /// standard iterator `position()` yields `usize`.
    fn failed_op_index(failed_ops: &Vec<FailedOperation>, op_id: &Bytes) -> Option<u32> {
        let len = failed_ops.len();
        let mut i = 0u32;
        while i < len {
            if &failed_ops.get(i).unwrap().op_id == op_id {
                return Some(i);
            }
            i += 1;
        }
        None
    }

    /// Kahn's algorithm for topological sorting over `nodes`.
    ///
    /// Edges are derived from each node's stored predecessor list: an edge
    /// `pred -> node` means `pred` must complete before `node`.  Returns the
    /// sorted order on success, or an empty `Vec` wrapped in `Err` when a cycle
    /// prevents a full ordering.  The caller reports the offending node set.
    ///
    /// Parallel index-aligned `Vec`s stand in for the `HashMap`s a std
    /// implementation would use, since Soroban's `Vec` exposes only indexed
    /// get/set access.
    fn kahn_topological_sort(env: &Env, nodes: &Vec<Bytes>) -> Result<Vec<Bytes>, ()> {
        let node_count = nodes.len();

        // in_degree[i] corresponds to nodes.get(i).
        let mut in_degree: Vec<u32> = Vec::new(env);
        let mut i = 0u32;
        while i < node_count {
            in_degree.push_back(0);
            i += 1;
        }

        // Build in-degrees. For each node, every stored predecessor that is also
        // part of `nodes` contributes an incoming edge (pred -> node).
        i = 0u32;
        while i < node_count {
            let node = nodes.get(i).unwrap();
            let pred_key = DataKey::OperationPredecessors(node.clone());
            if let Some(preds) = env.storage().persistent().get::<_, Vec<Bytes>>(&pred_key) {
                let pred_len = preds.len();
                let mut p = 0u32;
                while p < pred_len {
                    let pred = preds.get(p).unwrap();
                    if Self::index_of(nodes, &pred).is_some() {
                        let current = in_degree.get(i).unwrap();
                        in_degree.set(i, current + 1);
                    }
                    p += 1;
                }
            }
            i += 1;
        }

        // Seed the queue with all zero-in-degree nodes.
        let mut queue: Vec<Bytes> = Vec::new(env);
        i = 0u32;
        while i < node_count {
            if in_degree.get(i).unwrap() == 0 {
                queue.push_back(nodes.get(i).unwrap());
            }
            i += 1;
        }

        // Process the queue, decrementing successor in-degrees as nodes are
        // removed. A successor is any node listing the processed node as a
        // predecessor.
        let mut sorted: Vec<Bytes> = Vec::new(env);
        while !queue.is_empty() {
            let node = queue.get(0).unwrap();
            queue.remove(0);
            sorted.push_back(node.clone());

            let mut j = 0u32;
            while j < node_count {
                let candidate = nodes.get(j).unwrap();
                let pred_key = DataKey::OperationPredecessors(candidate.clone());
                if let Some(preds) = env.storage().persistent().get::<_, Vec<Bytes>>(&pred_key) {
                    if Self::index_of(&preds, &node).is_some() {
                        let current = in_degree.get(j).unwrap();
                        if current > 0 {
                            let updated = current - 1;
                            in_degree.set(j, updated);
                            if updated == 0 {
                                queue.push_back(candidate.clone());
                            }
                        }
                    }
                }
                j += 1;
            }
        }

        // If not every node was processed, a cycle exists.
        if sorted.len() != node_count {
            return Err(());
        }

        Ok(sorted)
    }
}

#[cfg(test)]
mod test;

#[cfg(test)]
mod test_dag;
