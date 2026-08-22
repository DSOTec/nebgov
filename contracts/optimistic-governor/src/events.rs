use soroban_sdk::{Address, Env, Symbol};

pub fn emit_proposal_created(env: &Env, id: u64, proposer: &Address, challenge_end_ledger: u32) {
    env.events().publish(
        (Symbol::new(env, "ProposalCreated"), id),
        (proposer.clone(), challenge_end_ledger),
    );
}

pub fn emit_objection_cast(
    env: &Env,
    proposal_id: u64,
    objector: &Address,
    weight: i128,
    running_total: i128,
) {
    env.events().publish(
        (Symbol::new(env, "ObjectionCast"), proposal_id),
        (objector.clone(), weight, running_total),
    );
}

pub fn emit_proposal_objected(env: &Env, proposal_id: u64) {
    env.events()
        .publish((Symbol::new(env, "ProposalObjected"), proposal_id), ());
}

pub fn emit_proposal_passed(env: &Env, proposal_id: u64) {
    env.events()
        .publish((Symbol::new(env, "ProposalPassed"), proposal_id), ());
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
