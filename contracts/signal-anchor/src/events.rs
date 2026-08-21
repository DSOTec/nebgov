use soroban_sdk::{Address, BytesN, Env, Symbol};

pub const RESULT_ANCHORED_TOPIC: &str = "ResultAnchored";

pub fn emit_result_anchored(
    env: &Env,
    poll_id: u64,
    result_hash: &BytesN<32>,
    anchored_ledger: u32,
    anchorer: &Address,
) {
    env.events().publish(
        (Symbol::new(env, RESULT_ANCHORED_TOPIC), anchorer.clone()),
        (poll_id, result_hash.clone(), anchored_ledger),
    );
}
