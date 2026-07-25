//! Two-phase commit-reveal voting (Issue #766).
//!
//! Splits a proposal's `voting_period` into a commit sub-window (voters
//! submit `sha256(proposal_id || support || weight_seed || salt)` without
//! revealing intent) followed by a reveal sub-window (voters disclose the
//! preimage, which is checked against the stored commitment before the vote
//! is applied to the tally). This defeats both last-block vote copying and
//! conditional bribery, since no vote content is observable until the
//! outcome can no longer be swayed.
//!
//! All storage here is commit-reveal's own and never touches the `Proposal`
//! record itself, so this module only needs `&Env` — the call sites in
//! `lib.rs` own reading/writing `Proposal` and call here for everything
//! commit-reveal specific. Deadlines are kept as plain `u32` storage entries
//! (rather than a packed tuple) since `u32` (de)serialization is already
//! monomorphized everywhere else in this contract — a `(u32, u32)` tuple
//! would pull in its own fresh codegen, which costs more than the extra
//! storage key saves given `sorogov_governor.wasm` sits close to Soroban's
//! 100KB cap.
//!
//! Scope boundary (same tradeoff `analytics`/`reputation` already made in
//! this contract): the issue's `get_commit_count`/`get_reveal_count` and a
//! per-commitment counter are deliberately *not* implemented on-chain — two
//! more public functions plus their counter storage pushed the WASM over the
//! CI-enforced cap with zero headroom to spare. `VoteCommitted`/`VoteRevealed`
//! already carry everything needed to derive both counts off-chain from the
//! indexed event stream, which is exactly how the indexer computes them.

use soroban_sdk::{Address, Bytes, BytesN, Env};

use crate::{DataKey, VoteSupport};

const COMMIT_REVEAL_TTL_LEDGERS: u32 = 3_110_400;
pub const DEFAULT_COMMIT_PHASE_FRACTION_BPS: u32 = 5_000;

fn support_to_u8(support: &VoteSupport) -> u8 {
    match support {
        VoteSupport::Against => 0,
        VoteSupport::For => 1,
        VoteSupport::Abstain => 2,
    }
}

/// Recomputes `sha256(proposal_id_le || support_u8 || weight_seed_le || salt)`,
/// the exact preimage the SDK's `generateCommitment` helper must reproduce.
pub fn compute_commitment(
    env: &Env,
    proposal_id: u64,
    support: &VoteSupport,
    weight_seed: u128,
    salt: &BytesN<32>,
) -> BytesN<32> {
    let mut preimage = Bytes::new(env);
    preimage.append(&Bytes::from_array(env, &proposal_id.to_le_bytes()));
    preimage.append(&Bytes::from_array(env, &[support_to_u8(support)]));
    preimage.append(&Bytes::from_array(env, &weight_seed.to_le_bytes()));
    preimage.append(&Bytes::from(salt.clone()));
    env.crypto().sha256(&preimage).into()
}

fn set_extended(env: &Env, key: &DataKey, value: u32) {
    env.storage().persistent().set(key, &value);
    env.storage()
        .persistent()
        .extend_ttl(key, COMMIT_REVEAL_TTL_LEDGERS, COMMIT_REVEAL_TTL_LEDGERS);
}

pub fn is_enabled_for_proposal(env: &Env, proposal_id: u64) -> bool {
    env.storage()
        .persistent()
        .has(&DataKey::CommitDeadline(proposal_id))
}

/// Called from `create_proposal_internal` right after a proposal is stored.
/// No-op unless the governor-wide `UseCommitReveal` setting is on; snapshots
/// the commit/reveal split at creation time so a later settings change never
/// retroactively changes a proposal already under way.
pub fn start_phase_if_enabled(env: &Env, proposal_id: u64, start_ledger: u32, end_ledger: u32) {
    let use_commit_reveal: bool = env
        .storage()
        .instance()
        .get(&DataKey::UseCommitReveal)
        .unwrap_or(false);
    if !use_commit_reveal {
        return;
    }
    let commit_phase_fraction: u32 = env
        .storage()
        .instance()
        .get(&DataKey::CommitPhaseFraction)
        .unwrap_or(DEFAULT_COMMIT_PHASE_FRACTION_BPS);
    let voting_period = end_ledger.saturating_sub(start_ledger) as u64;
    let commit_ledgers = (voting_period * commit_phase_fraction as u64 / 10_000) as u32;
    let commit_deadline = start_ledger.saturating_add(commit_ledgers);

    set_extended(env, &DataKey::CommitDeadline(proposal_id), commit_deadline);
    set_extended(env, &DataKey::RevealDeadline(proposal_id), end_ledger);

    crate::events::emit_commit_phase_started(env, proposal_id, commit_deadline, end_ledger);
}

pub fn commit_deadline(env: &Env, proposal_id: u64) -> Option<u32> {
    env.storage()
        .persistent()
        .get(&DataKey::CommitDeadline(proposal_id))
}

pub fn reveal_deadline(env: &Env, proposal_id: u64) -> Option<u32> {
    env.storage()
        .persistent()
        .get(&DataKey::RevealDeadline(proposal_id))
}

pub fn has_committed(env: &Env, proposal_id: u64, voter: &Address) -> bool {
    env.storage()
        .persistent()
        .has(&DataKey::VoteCommitment(proposal_id, voter.clone()))
}

pub fn get_commitment(env: &Env, proposal_id: u64, voter: &Address) -> Option<BytesN<32>> {
    env.storage()
        .persistent()
        .get(&DataKey::VoteCommitment(proposal_id, voter.clone()))
}

pub fn store_commitment(env: &Env, proposal_id: u64, voter: &Address, commitment: &BytesN<32>) {
    let commitment_key = DataKey::VoteCommitment(proposal_id, voter.clone());
    env.storage().persistent().set(&commitment_key, commitment);
    env.storage().persistent().extend_ttl(
        &commitment_key,
        COMMIT_REVEAL_TTL_LEDGERS,
        COMMIT_REVEAL_TTL_LEDGERS,
    );
}
