use soroban_sdk::{Address, Env, Symbol};

pub fn emit_proposal_created(
    env: &Env,
    id: u64,
    proposer: &Address,
    target: &Address,
    requested_amount: i128,
) {
    env.events().publish(
        (Symbol::new(env, "ProposalCreated"), id),
        (proposer.clone(), target.clone(), requested_amount),
    );
}

pub fn emit_stake_updated(env: &Env, staker: &Address, proposal_id: u64, amount: i128) {
    env.events().publish(
        (Symbol::new(env, "StakeUpdated"), proposal_id),
        (staker.clone(), amount),
    );
}

pub fn emit_conviction_updated(env: &Env, proposal_id: u64, conviction: i128) {
    env.events().publish(
        (Symbol::new(env, "ConvictionUpdated"), proposal_id),
        conviction,
    );
}

pub fn emit_proposal_executed(env: &Env, proposal_id: u64) {
    env.events()
        .publish((Symbol::new(env, "ProposalExecuted"), proposal_id), ());
}

pub fn emit_proposal_cancelled(env: &Env, proposal_id: u64, caller: &Address) {
    env.events().publish(
        (Symbol::new(env, "ProposalCancelled"), proposal_id),
        caller.clone(),
    );
}
