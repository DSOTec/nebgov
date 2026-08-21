#![no_std]

pub mod error;
mod events;

use crate::error::SignalAnchorError;
use soroban_sdk::{contract, contractimpl, contracttype, Address, BytesN, Env};

/// An anchor is written once and never touched again by any other entrypoint,
/// so unlike every other persistent record in this repo (which gets its TTL
/// bumped on each subsequent state-changing call), it has no other chance to
/// avoid archival. Extended to the practical ~1 year ceiling (same constant
/// as `contracts/liquidity`'s `TTL_LEDGERS`) on both the write path
/// (`anchor_result`) and the read path (`get_anchor`) — the read-path bump
/// keeps a frequently-queried anchor alive indefinitely, since `get_anchor`
/// is exactly the query the indexer and `SignalingClient` call periodically.
const ANCHOR_TTL_LEDGERS: u32 = 6_307_200;

/// An immutable record anchoring the finalized result of an off-chain
/// signaling poll (see `backend/src/signaling/`). Deliberately minimal —
/// this contract does not tally votes or store poll metadata; it exists
/// purely so a finalized off-chain result can't be silently edited after
/// publication.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AnchorRecord {
    pub poll_id: u64,
    pub result_hash: BytesN<32>,
    pub anchored_ledger: u32,
    pub anchorer: Address,
}

#[contracttype]
pub enum DataKey {
    Admin,
    Anchor(u64),
}

#[contract]
pub struct SignalAnchorContract;

#[contractimpl]
impl SignalAnchorContract {
    pub fn initialize(env: Env, admin: Address) {
        admin.require_auth();
        if env.storage().instance().has(&DataKey::Admin) {
            env.panic_with_error(SignalAnchorError::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    /// Anchor the finalized `result_hash` for `poll_id`. Only the configured
    /// admin (the backend's signaling service account) may anchor, and only
    /// once per `poll_id` — a second call for the same `poll_id` panics,
    /// making a published result immutable.
    pub fn anchor_result(env: Env, anchorer: Address, poll_id: u64, result_hash: BytesN<32>) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| env.panic_with_error(SignalAnchorError::NotInitialized));
        if anchorer != admin {
            env.panic_with_error(SignalAnchorError::Unauthorized);
        }
        admin.require_auth();

        let key = DataKey::Anchor(poll_id);
        if env.storage().persistent().has(&key) {
            env.panic_with_error(SignalAnchorError::AlreadyAnchored);
        }

        let anchored_ledger = env.ledger().sequence();
        let record = AnchorRecord {
            poll_id,
            result_hash: result_hash.clone(),
            anchored_ledger,
            anchorer: anchorer.clone(),
        };
        env.storage().persistent().set(&key, &record);
        env.storage()
            .persistent()
            .extend_ttl(&key, ANCHOR_TTL_LEDGERS, ANCHOR_TTL_LEDGERS);

        events::emit_result_anchored(&env, poll_id, &result_hash, anchored_ledger, &anchorer);
    }

    pub fn get_anchor(env: Env, poll_id: u64) -> Option<AnchorRecord> {
        let key = DataKey::Anchor(poll_id);
        let record = env.storage().persistent().get(&key);
        if record.is_some() {
            env.storage()
                .persistent()
                .extend_ttl(&key, ANCHOR_TTL_LEDGERS, ANCHOR_TTL_LEDGERS);
        }
        record
    }
}

#[cfg(test)]
mod tests;
