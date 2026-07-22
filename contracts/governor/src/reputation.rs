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

use soroban_sdk::{Address, Env, Symbol, Vec};

use crate::error::GovernorError;
use crate::DataKey;

const BPS_DENOMINATOR: u32 = 10_000;
const HIGH_PARTICIPATION_THRESHOLD_BPS: u32 = 5_000;
const MAX_HISTORY_ENTRIES: u32 = 50;
const MAX_LEADERBOARD_ENTRIES: u32 = 50;
/// TTL applied to every reputation-related persistent entry on write. Chosen
/// generously (comparable to the multi-year Soroban max) since reputation
/// records are long-lived, low-churn per-address data.
const REPUTATION_TTL_LEDGERS: u32 = 3_110_400;

#[soroban_sdk::contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ProposerReputation {
    pub proposer: Address,
    pub total_proposals: u32,
    pub proposals_succeeded: u32,
    pub proposals_executed: u32,
    pub proposals_defeated: u32,
    pub proposals_cancelled: u32,
    pub proposals_expired: u32,
    pub total_participation_bps_sum: u64,
    pub total_quorum_hit: u32,
    pub last_proposal_ledger: u32,
    pub reputation_score: i32,
    pub threshold_multiplier_bps: u32,
    pub first_proposal_ledger: u32,
    pub consecutive_successful: u32,
    pub consecutive_failed: u32,
}

#[soroban_sdk::contracttype]
#[derive(Clone, Debug, PartialEq)]
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

#[soroban_sdk::contracttype]
#[derive(Clone, Debug)]
pub struct ReputationScoreEntry {
    pub ledger: u32,
    pub score: i32,
    pub change: i32,
    pub reason: Symbol,
}

#[soroban_sdk::contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ProposerLeaderboardEntry {
    pub rank: u32,
    pub proposer: Address,
    pub reputation_score: i32,
    pub total_proposals: u32,
    pub success_rate_bps: u32,
    pub avg_participation_bps: u32,
}

/// The terminal (or quasi-terminal, for `Succeeded`) lifecycle outcome a
/// proposal reached, used to select which `ReputationConfig` score delta
/// applies. Not a `#[contracttype]` — this is a call-site parameter only,
/// never persisted.
#[derive(Clone, Copy, Debug, PartialEq)]
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

pub fn get_config(env: &Env) -> ReputationConfig {
    env.storage()
        .instance()
        .get(&DataKey::ReputationConfig)
        .unwrap_or_else(default_config)
}

fn set_config(env: &Env, config: &ReputationConfig) {
    env.storage()
        .instance()
        .set(&DataKey::ReputationConfig, config);
}

/// Validates a caller-supplied config and, if valid, persists it. Panics with
/// `GovernorError::InvalidReputationConfig` on an inverted/degenerate range so
/// a misconfigured proposal can never leave the score-to-multiplier mapping
/// undefined.
pub fn update_config_checked(env: &Env, caller: &Address, config: ReputationConfig) {
    if config.min_score >= config.max_score {
        env.panic_with_error(GovernorError::InvalidReputationConfig);
    }
    if config.min_threshold_multiplier_bps == 0
        || config.max_threshold_multiplier_bps == 0
        || config.min_threshold_multiplier_bps > config.max_threshold_multiplier_bps
    {
        env.panic_with_error(GovernorError::InvalidReputationConfig);
    }
    set_config(env, &config);
    crate::events::emit_reputation_config_updated(env, caller, &config);
}

fn default_reputation(env: &Env, proposer: &Address) -> ProposerReputation {
    let current_ledger = env.ledger().sequence();
    ProposerReputation {
        proposer: proposer.clone(),
        total_proposals: 0,
        proposals_succeeded: 0,
        proposals_executed: 0,
        proposals_defeated: 0,
        proposals_cancelled: 0,
        proposals_expired: 0,
        total_participation_bps_sum: 0,
        total_quorum_hit: 0,
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

fn push_history(env: &Env, proposer: &Address, old_score: i32, new_score: i32, reason: Symbol) {
    let key = DataKey::ReputationScoreHistory(proposer.clone());
    let mut history: Vec<ReputationScoreEntry> =
        env.storage().persistent().get(&key).unwrap_or(Vec::new(env));
    history.push_back(ReputationScoreEntry {
        ledger: env.ledger().sequence(),
        score: new_score,
        change: new_score - old_score,
        reason,
    });
    while history.len() > MAX_HISTORY_ENTRIES {
        history.pop_front();
    }
    env.storage().persistent().set(&key, &history);
    env.storage()
        .persistent()
        .extend_ttl(&key, REPUTATION_TTL_LEDGERS, REPUTATION_TTL_LEDGERS);
}

pub fn get_score_history(env: &Env, proposer: &Address) -> Vec<ReputationScoreEntry> {
    env.storage()
        .persistent()
        .get(&DataKey::ReputationScoreHistory(proposer.clone()))
        .unwrap_or(Vec::new(env))
}

fn track_proposer_for_leaderboard(env: &Env, proposer: &Address) {
    let key = DataKey::ReputationProposerList;
    let mut list: Vec<Address> = env.storage().persistent().get(&key).unwrap_or(Vec::new(env));
    if !list.contains(proposer) {
        list.push_back(proposer.clone());
        env.storage().persistent().set(&key, &list);
        env.storage()
            .persistent()
            .extend_ttl(&key, REPUTATION_TTL_LEDGERS, REPUTATION_TTL_LEDGERS);
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
    track_proposer_for_leaderboard(env, proposer);
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
            rep.proposals_succeeded += 1;
            rep.consecutive_successful += 1;
            rep.consecutive_failed = 0;
            config.score_for_succeed
        }
        ReputationOutcome::Executed => {
            rep.proposals_executed += 1;
            config.score_for_executed
        }
        ReputationOutcome::Defeated => {
            rep.proposals_defeated += 1;
            rep.consecutive_failed += 1;
            rep.consecutive_successful = 0;
            config.score_for_defeated
        }
        ReputationOutcome::Cancelled => {
            rep.proposals_cancelled += 1;
            rep.consecutive_failed += 1;
            rep.consecutive_successful = 0;
            config.score_for_cancelled
        }
        ReputationOutcome::Expired => {
            rep.proposals_expired += 1;
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
        if outcome == ReputationOutcome::Succeeded {
            rep.total_quorum_hit += 1;
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
    push_history(env, proposer, old_score, new_score, reason.clone());
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
    push_history(env, proposer, old_score, new_score, reason.clone());
    crate::events::emit_reputation_updated(env, proposer, old_score, new_score, &reason);
}

pub fn get_leaderboard(env: &Env) -> Vec<ProposerLeaderboardEntry> {
    env.storage()
        .persistent()
        .get(&DataKey::GlobalProposerLeaderboard)
        .unwrap_or(Vec::new(env))
}

/// Rebuilds the top-`MAX_LEADERBOARD_ENTRIES` proposer ranking from the
/// bounded list of addresses that have ever created a proposal. Uses a
/// simple insertion sort — the proposer list is expected to stay small
/// relative to proposal volume (bounded by unique governance participants,
/// not by proposal count), so O(n^2) is an acceptable, easy-to-audit choice.
pub fn refresh_leaderboard(env: &Env) {
    let list: Vec<Address> = env
        .storage()
        .persistent()
        .get(&DataKey::ReputationProposerList)
        .unwrap_or(Vec::new(env));

    let mut entries: Vec<ProposerLeaderboardEntry> = Vec::new(env);
    for addr in list.iter() {
        let rep = get_reputation(env, &addr);
        let success_rate_bps = if rep.total_proposals > 0 {
            (rep.proposals_succeeded as u64 * BPS_DENOMINATOR as u64 / rep.total_proposals as u64) as u32
        } else {
            0
        };
        let avg_participation_bps = if rep.total_proposals > 0 {
            (rep.total_participation_bps_sum / rep.total_proposals as u64) as u32
        } else {
            0
        };
        entries.push_back(ProposerLeaderboardEntry {
            rank: 0,
            proposer: addr.clone(),
            reputation_score: rep.reputation_score,
            total_proposals: rep.total_proposals,
            success_rate_bps,
            avg_participation_bps,
        });
    }

    let n = entries.len();
    for i in 1..n {
        let mut j = i;
        while j > 0 {
            let a = entries.get(j - 1).unwrap();
            let b = entries.get(j).unwrap();
            if a.reputation_score < b.reputation_score {
                entries.set(j - 1, b);
                entries.set(j, a);
                j -= 1;
            } else {
                break;
            }
        }
    }

    let top_n = entries.len().min(MAX_LEADERBOARD_ENTRIES);
    let mut ranked: Vec<ProposerLeaderboardEntry> = Vec::new(env);
    for i in 0..top_n {
        let mut entry = entries.get(i).unwrap();
        entry.rank = i + 1;
        ranked.push_back(entry);
    }

    env.storage()
        .persistent()
        .set(&DataKey::GlobalProposerLeaderboard, &ranked);
    env.storage().persistent().extend_ttl(
        &DataKey::GlobalProposerLeaderboard,
        REPUTATION_TTL_LEDGERS,
        REPUTATION_TTL_LEDGERS,
    );
    env.storage()
        .instance()
        .set(&DataKey::LeaderboardLastUpdated, &env.ledger().sequence());

    if let Some(top) = ranked.get(0) {
        crate::events::emit_leaderboard_refreshed(env, &top.proposer, top.reputation_score);
    }
}
