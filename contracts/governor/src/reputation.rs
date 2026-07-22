//! Proposer Reputation System (Issue #771).
//!
//! Tracks each proposer's proposal outcome history, computes a rolling
//! reputation score, and derives a reputation-adjusted effective proposal
//! threshold so that a proven, high-participation proposer can propose at a
//! discount while a repeat spammer pays a penalty. All storage/behavior here
//! is additive: when `ReputationConfig::enabled` is false (or no proposals
//! have been recorded yet for an address) `get_effective_threshold` degrades
//! to the flat `proposal_threshold`, so existing governance flows are
//! unaffected by default beyond the one call-site changes in `lib.rs`.

use soroban_sdk::{Address, Env, Symbol};

use crate::DataKey;

const BPS_DENOMINATOR: u32 = 10_000;
const HIGH_PARTICIPATION_THRESHOLD_BPS: u32 = 5_000;
/// TTL applied to every reputation-related persistent entry on write. Chosen
/// generously (comparable to the multi-year Soroban max) since reputation
/// records are long-lived, low-churn per-address data.
const REPUTATION_TTL_LEDGERS: u32 = 3_110_400;

#[soroban_sdk::contracttype]
#[derive(Clone)]
pub struct ProposerReputation {
    pub proposer: Address,
    pub total_proposals: u32,
    pub total_participation_bps_sum: u64,
    pub last_proposal_ledger: u32,
    pub reputation_score: i32,
    pub threshold_multiplier_bps: u32,
    pub first_proposal_ledger: u32,
    pub consecutive_successful: u32,
    pub consecutive_failed: u32,
}

#[derive(Clone)]
pub struct ReputationConfig {
    pub enabled: bool,
    pub score_for_succeed: i32,
    pub score_for_executed: i32,
    pub score_for_defeated: i32,
    pub score_for_cancelled: i32,
    pub score_for_expired: i32,
    pub score_for_high_participation: i32,
    pub min_proposals_for_discount: u32,
    pub max_score: i32,
    pub min_score: i32,
    pub max_threshold_multiplier_bps: u32,
    pub min_threshold_multiplier_bps: u32,
    pub decay_rate_per_1000_ledgers: i32,
}

/// The terminal (or quasi-terminal, for `Succeeded`) lifecycle outcome a
/// proposal reached, used to select which `ReputationConfig` score delta
/// applies. Not a `#[contracttype]` — this is a call-site parameter only,
/// never persisted.
#[derive(Clone, Copy)]
pub enum ReputationOutcome {
    Succeeded,
    Executed,
    Defeated,
    Cancelled,
    Expired,
}

pub fn default_config() -> ReputationConfig {
    ReputationConfig {
        enabled: true,
        score_for_succeed: 100,
        score_for_executed: 50,
        score_for_defeated: -30,
        score_for_cancelled: -20,
        score_for_expired: -60,
        score_for_high_participation: 30,
        min_proposals_for_discount: 3,
        max_score: 1000,
        min_score: -1000,
        max_threshold_multiplier_bps: 20_000,
        min_threshold_multiplier_bps: 5_000,
        decay_rate_per_1000_ledgers: 10,
    }
}

pub fn get_config(_env: &Env) -> ReputationConfig {
    default_config()
}

fn default_reputation(env: &Env, proposer: &Address) -> ProposerReputation {
    let current_ledger = env.ledger().sequence();
    ProposerReputation {
        proposer: proposer.clone(),
        total_proposals: 0,
        total_participation_bps_sum: 0,
        last_proposal_ledger: current_ledger,
        reputation_score: 0,
        threshold_multiplier_bps: BPS_DENOMINATOR,
        first_proposal_ledger: current_ledger,
        consecutive_successful: 0,
        consecutive_failed: 0,
    }
}

pub fn get_reputation(env: &Env, proposer: &Address) -> ProposerReputation {
    env.storage()
        .persistent()
        .get(&DataKey::ProposerReputation(proposer.clone()))
        .unwrap_or_else(|| default_reputation(env, proposer))
}

fn save_reputation(env: &Env, rep: &ProposerReputation) {
    let key = DataKey::ProposerReputation(rep.proposer.clone());
    env.storage().persistent().set(&key, rep);
    env.storage()
        .persistent()
        .extend_ttl(&key, REPUTATION_TTL_LEDGERS, REPUTATION_TTL_LEDGERS);
}

fn clamp_score(score: i32, config: &ReputationConfig) -> i32 {
    score.max(config.min_score).min(config.max_score)
}

/// Maps a reputation score in `[min_score, max_score]` to a threshold
/// multiplier in `[min_threshold_multiplier_bps, max_threshold_multiplier_bps]`
/// (10000 bps = 1x baseline, lower = discount, higher = penalty). A higher
/// score always yields a lower (or equal) multiplier.
pub fn compute_threshold_multiplier(score: i32, config: &ReputationConfig) -> u32 {
    let range = (config.max_score - config.min_score).max(1) as u32;
    let clamped = score.max(config.min_score).min(config.max_score);
    let normalized = ((clamped - config.min_score) as u32) * BPS_DENOMINATOR / range;
    config.max_threshold_multiplier_bps
        - normalized * (config.max_threshold_multiplier_bps - config.min_threshold_multiplier_bps)
            / BPS_DENOMINATOR
}

fn reason_symbol(env: &Env, outcome: ReputationOutcome) -> Symbol {
    match outcome {
        ReputationOutcome::Succeeded => Symbol::new(env, "succeeded"),
        ReputationOutcome::Executed => Symbol::new(env, "executed"),
        ReputationOutcome::Defeated => Symbol::new(env, "defeated"),
        ReputationOutcome::Cancelled => Symbol::new(env, "cancelled"),
        ReputationOutcome::Expired => Symbol::new(env, "expired"),
    }
}

/// Called once per `propose()` (via `create_proposal_internal`) to bump the
/// proposer's lifetime proposal count ahead of knowing the eventual outcome.
pub fn record_proposal_created(env: &Env, proposer: &Address) {
    let config = get_config(env);
    if !config.enabled {
        return;
    }
    let mut rep = get_reputation(env, proposer);
    let current_ledger = env.ledger().sequence();
    if rep.total_proposals == 0 {
        rep.first_proposal_ledger = current_ledger;
    }
    rep.total_proposals += 1;
    rep.last_proposal_ledger = current_ledger;
    save_reputation(env, &rep);
}

/// Applies the score delta for a terminal (or Succeeded) proposal outcome,
/// updates streak/tally counters, recomputes the effective threshold
/// multiplier, and emits `ReputationUpdated` (+ `EffectiveThresholdChanged`
/// if the multiplier moved). Idempotency is the caller's responsibility —
/// see the call sites in `lib.rs` for why each is safe to call at most once
/// per proposal.
pub fn record_proposal_terminal(
    env: &Env,
    proposer: &Address,
    outcome: ReputationOutcome,
    participation_bps: Option<u32>,
) {
    let config = get_config(env);
    if !config.enabled {
        return;
    }

    let mut rep = get_reputation(env, proposer);
    let old_score = rep.reputation_score;
    let old_multiplier = rep.threshold_multiplier_bps;

    let mut delta = match outcome {
        ReputationOutcome::Succeeded => {
            rep.consecutive_successful += 1;
            rep.consecutive_failed = 0;
            config.score_for_succeed
        }
        ReputationOutcome::Executed => config.score_for_executed,
        ReputationOutcome::Defeated => {
            rep.consecutive_failed += 1;
            rep.consecutive_successful = 0;
            config.score_for_defeated
        }
        ReputationOutcome::Cancelled => {
            rep.consecutive_failed += 1;
            rep.consecutive_successful = 0;
            config.score_for_cancelled
        }
        ReputationOutcome::Expired => {
            rep.consecutive_failed += 1;
            rep.consecutive_successful = 0;
            config.score_for_expired
        }
    };

    if let Some(bps) = participation_bps {
        rep.total_participation_bps_sum = rep.total_participation_bps_sum.saturating_add(bps as u64);
        if bps >= HIGH_PARTICIPATION_THRESHOLD_BPS {
            delta = delta.saturating_add(config.score_for_high_participation);
        }
    }

    let new_score = clamp_score(old_score.saturating_add(delta), &config);
    rep.reputation_score = new_score;

    let raw_multiplier = compute_threshold_multiplier(new_score, &config);
    let new_multiplier = if rep.total_proposals >= config.min_proposals_for_discount {
        raw_multiplier
    } else {
        // A proposer without enough of a track record yet cannot earn a
        // discount, though a bad start can still incur the penalty side.
        raw_multiplier.max(BPS_DENOMINATOR)
    };
    rep.threshold_multiplier_bps = new_multiplier;

    save_reputation(env, &rep);
    let reason = reason_symbol(env, outcome);
    crate::events::emit_reputation_updated(env, proposer, old_score, new_score, &reason);

    if new_multiplier != old_multiplier {
        let flat_threshold: i128 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalThreshold)
            .unwrap_or(0);
        let old_threshold = flat_threshold.saturating_mul(old_multiplier as i128) / BPS_DENOMINATOR as i128;
        let new_threshold = flat_threshold.saturating_mul(new_multiplier as i128) / BPS_DENOMINATOR as i128;
        if old_threshold != new_threshold {
            crate::events::emit_effective_threshold_changed(env, proposer, old_threshold, new_threshold);
        }
    }
}

/// Reputation-adjusted effective proposal threshold for `proposer`. Falls
/// back to `flat_threshold` unchanged when the system is disabled or the
/// address has no proposal history yet.
pub fn get_effective_threshold(env: &Env, proposer: &Address, flat_threshold: i128) -> i128 {
    let config = get_config(env);
    if !config.enabled {
        return flat_threshold;
    }
    let rep = get_reputation(env, proposer);
    let multiplier = if rep.total_proposals == 0 {
        BPS_DENOMINATOR
    } else {
        rep.threshold_multiplier_bps
    };
    flat_threshold.saturating_mul(multiplier as i128) / BPS_DENOMINATOR as i128
}

/// Decays a proposer's score a fraction of the way back toward zero based on
/// ledgers elapsed since their reputation was last touched. Permissionless
/// and idempotent-safe to call repeatedly — a call shortly after a previous
/// one is simply a no-op once `elapsed` rounds down to zero decay.
pub fn apply_decay(env: &Env, proposer: &Address) {
    let config = get_config(env);
    let mut rep = get_reputation(env, proposer);
    if rep.reputation_score == 0 {
        return;
    }

    let current_ledger = env.ledger().sequence();
    let elapsed = current_ledger.saturating_sub(rep.last_proposal_ledger);
    if elapsed == 0 {
        return;
    }

    let decay_amount = ((config.decay_rate_per_1000_ledgers as i64).saturating_mul(elapsed as i64) / 1000) as i32;
    if decay_amount == 0 {
        return;
    }

    let old_score = rep.reputation_score;
    let new_score = if old_score > 0 {
        (old_score - decay_amount).max(0)
    } else {
        (old_score + decay_amount).min(0)
    };
    if new_score == old_score {
        return;
    }

    rep.reputation_score = new_score;
    let raw_multiplier = compute_threshold_multiplier(new_score, &config);
    rep.threshold_multiplier_bps = if rep.total_proposals >= config.min_proposals_for_discount {
        raw_multiplier
    } else {
        raw_multiplier.max(BPS_DENOMINATOR)
    };
    rep.last_proposal_ledger = current_ledger;
    save_reputation(env, &rep);

    let reason = Symbol::new(env, "decay");
    crate::events::emit_reputation_updated(env, proposer, old_score, new_score, &reason);
}

// Note: proposer leaderboard ranking is computed off-chain by the indexer
// (GET /reputation/leaderboard, ordered by reputation_score) from the
// ReputationUpdated event stream rather than maintained on-chain — sorting a
// growing address list is exactly the kind of work that's cheap off-chain
// and unnecessarily expensive (in both gas and contract size) on it.
