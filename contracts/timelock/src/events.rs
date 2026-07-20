use soroban_sdk::{Address, Bytes, Env, Symbol, Vec};

pub const OPERATION_SCHEDULED_TOPIC: &str = "OperationScheduled";
pub const OPERATION_EXECUTED_TOPIC: &str = "OperationExecuted";
pub const OPERATION_CANCELLED_TOPIC: &str = "OperationCancelled";
pub const BATCH_OPERATION_SCHEDULED_TOPIC: &str = "BatchOperationScheduled";
pub const BATCH_OPERATION_EXECUTED_TOPIC: &str = "BatchOperationExecuted";
pub const BATCH_OPERATION_CANCELLED_TOPIC: &str = "BatchOperationCancelled";
pub const MIN_DELAY_UPDATED_TOPIC: &str = "MinDelayUpdated";

#[derive(Clone)]
#[soroban_sdk::contracttype]
pub struct OperationScheduledEvent {
    pub op_id: Bytes,
    pub target: Address,
    pub fn_name: Symbol,
    pub ready_at: u64,
    pub expires_at: u64,
}

#[derive(Clone)]
#[soroban_sdk::contracttype]
pub struct OperationExecutedEvent {
    pub op_id: Bytes,
    pub caller: Address,
}

#[derive(Clone)]
#[soroban_sdk::contracttype]
pub struct OperationCancelledEvent {
    pub op_id: Bytes,
    pub caller: Address,
}

#[derive(Clone)]
#[soroban_sdk::contracttype]
pub struct BatchOperationScheduledEvent {
    pub batch_op_id: Bytes,
    pub targets: Vec<Address>,
    pub fn_names: Vec<Symbol>,
    pub ready_at: u64,
    pub expires_at: u64,
}

#[derive(Clone)]
#[soroban_sdk::contracttype]
pub struct BatchOperationExecutedEvent {
    pub batch_op_id: Bytes,
    pub caller: Address,
}

#[derive(Clone)]
#[soroban_sdk::contracttype]
pub struct BatchOperationCancelledEvent {
    pub batch_op_id: Bytes,
    pub caller: Address,
}

#[derive(Clone)]
#[soroban_sdk::contracttype]
pub struct MinDelayUpdatedEvent {
    pub old_delay: u64,
    pub new_delay: u64,
}

pub fn emit_operation_scheduled(
    env: &Env,
    op_id: &Bytes,
    target: &Address,
    fn_name: &Symbol,
    ready_at: u64,
    expires_at: u64,
) {
    env.events().publish(
        (Symbol::new(env, OPERATION_SCHEDULED_TOPIC),),
        OperationScheduledEvent {
            op_id: op_id.clone(),
            target: target.clone(),
            fn_name: fn_name.clone(),
            ready_at,
            expires_at,
        },
    );
}

pub fn emit_operation_executed(env: &Env, op_id: &Bytes, caller: &Address) {
    env.events().publish(
        (Symbol::new(env, OPERATION_EXECUTED_TOPIC),),
        OperationExecutedEvent {
            op_id: op_id.clone(),
            caller: caller.clone(),
        },
    );
}

pub fn emit_operation_cancelled(env: &Env, op_id: &Bytes, caller: &Address) {
    env.events().publish(
        (Symbol::new(env, OPERATION_CANCELLED_TOPIC),),
        OperationCancelledEvent {
            op_id: op_id.clone(),
            caller: caller.clone(),
        },
    );
}

pub fn emit_batch_operation_scheduled(
    env: &Env,
    batch_op_id: &Bytes,
    targets: &Vec<Address>,
    fn_names: &Vec<Symbol>,
    ready_at: u64,
    expires_at: u64,
) {
    env.events().publish(
        (Symbol::new(env, BATCH_OPERATION_SCHEDULED_TOPIC),),
        BatchOperationScheduledEvent {
            batch_op_id: batch_op_id.clone(),
            targets: targets.clone(),
            fn_names: fn_names.clone(),
            ready_at,
            expires_at,
        },
    );
}

pub fn emit_batch_operation_executed(env: &Env, batch_op_id: &Bytes, caller: &Address) {
    env.events().publish(
        (Symbol::new(env, BATCH_OPERATION_EXECUTED_TOPIC),),
        BatchOperationExecutedEvent {
            batch_op_id: batch_op_id.clone(),
            caller: caller.clone(),
        },
    );
}

pub fn emit_batch_operation_cancelled(env: &Env, batch_op_id: &Bytes, caller: &Address) {
    env.events().publish(
        (Symbol::new(env, BATCH_OPERATION_CANCELLED_TOPIC),),
        BatchOperationCancelledEvent {
            batch_op_id: batch_op_id.clone(),
            caller: caller.clone(),
        },
    );
}

pub fn emit_min_delay_updated(env: &Env, old_delay: u64, new_delay: u64) {
    env.events().publish(
        (Symbol::new(env, MIN_DELAY_UPDATED_TOPIC),),
        MinDelayUpdatedEvent { old_delay, new_delay },
    );
}

pub fn emit_dependency_dag_validated(env: &Env, batch_op_id: &Bytes, op_count: u32) {
    env.events().publish(
        (Symbol::new(env, "DependencyDagValidated"),),
        (batch_op_id.clone(), op_count),
    );
}

pub fn emit_cycle_detected(env: &Env, cycle_path: &Vec<Bytes>) {
    env.events().publish(
        (Symbol::new(env, "CycleDetected"),),
        cycle_path.clone(),
    );
}

pub fn emit_partial_batch_started(env: &Env, batch_op_id: &Bytes, total_ops: u32) {
    env.events().publish(
        (Symbol::new(env, "PartialBatchStarted"),),
        (batch_op_id.clone(), total_ops),
    );
}

pub fn emit_partial_op_succeeded(
    env: &Env,
    batch_op_id: &Bytes,
    op_id: &Bytes,
    completed: u32,
    total: u32,
) {
    env.events().publish(
        (Symbol::new(env, "PartialOpSucceeded"),),
        (batch_op_id.clone(), op_id.clone(), completed, total),
    );
}

pub fn emit_partial_op_failed(env: &Env, batch_op_id: &Bytes, op_id: &Bytes) {
    env.events().publish(
        (Symbol::new(env, "PartialOpFailed"),),
        (batch_op_id.clone(), op_id.clone()),
    );
}

pub fn emit_batch_recovery_entered(env: &Env, batch_op_id: &Bytes, recovery_deadline: u32) {
    env.events().publish(
        (Symbol::new(env, "BatchRecoveryEntered"),),
        (batch_op_id.clone(), recovery_deadline),
    );
}

pub fn emit_failed_op_retried(
    env: &Env,
    batch_op_id: &Bytes,
    op_id: &Bytes,
    retry_count: u32,
    succeeded: bool,
) {
    env.events().publish(
        (Symbol::new(env, "FailedOpRetried"),),
        (
            batch_op_id.clone(),
            op_id.clone(),
            retry_count,
            succeeded,
        ),
    );
}

pub fn emit_failed_op_skipped(env: &Env, batch_op_id: &Bytes, op_id: &Bytes) {
    env.events().publish(
        (Symbol::new(env, "FailedOpSkipped"),),
        (batch_op_id.clone(), op_id.clone()),
    );
}

pub fn emit_batch_fully_complete(env: &Env, batch_op_id: &Bytes) {
    env.events().publish(
        (Symbol::new(env, "BatchFullyComplete"),),
        batch_op_id.clone(),
    );
}
