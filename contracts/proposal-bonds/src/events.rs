use soroban_sdk::{Address, BytesN, Env, Symbol};

pub const BOND_LOCKED_TOPIC: &str = "BondLocked";
pub const BOND_REFUNDED_TOPIC: &str = "BondRefunded";
pub const BOND_SLASHED_TOPIC: &str = "BondSlashed";

pub fn emit_bond_locked(env: &Env, proposer: &Address, description_hash: &BytesN<32>, amount: i128) {
    env.events().publish(
        (Symbol::new(env, BOND_LOCKED_TOPIC), proposer.clone()),
        (description_hash.clone(), amount),
    );
}

pub fn emit_bond_refunded(env: &Env, description_hash: &BytesN<32>, proposer: &Address, amount: i128) {
    env.events().publish(
        (Symbol::new(env, BOND_REFUNDED_TOPIC), proposer.clone()),
        (description_hash.clone(), amount),
    );
}

pub fn emit_bond_slashed(
    env: &Env,
    description_hash: &BytesN<32>,
    proposer: &Address,
    amount: i128,
    recipient: &Address,
) {
    env.events().publish(
        (Symbol::new(env, BOND_SLASHED_TOPIC), proposer.clone()),
        (description_hash.clone(), amount, recipient.clone()),
    );
}
