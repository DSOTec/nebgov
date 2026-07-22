//! On-chain Governance Analytics Module (Issue #765).
//!
//! Tracks participation, proposal outcomes, and per-voter history so the
//! indexer/frontend can serve governance health metrics without recomputing
//! everything client-side from raw contract data on every page load.
//!
//! Delegation-concentration metrics (`top_delegate_share_bps`,
//! `delegation_rate_bps`) are intentionally always `0` in the on-chain
//! snapshot: the governor has no cross-contract visibility into the
//! token-votes contract's full delegator set (only per-delegatee lookups
//! exist there). Those two fields are populated by the indexer, which
//! aggregates them off the token-votes contract's delegation events.

use soroban_sdk::{Address, Env, Vec};

use crate::{DataKey, Proposal, VoteSupport};

const BPS_DENOMINATOR: i128 = 10_000;
/// TTL applied to analytics persistent entries on write. Generous and
/// long-lived, matching the reputation module's convention for low-churn,
/// long-lived aggregate data.
const ANALYTICS_TTL_LEDGERS: u32 = 3_110_400;
/// Bounds the snapshot history so `take_analytics_snapshot` cannot grow
/// storage unboundedly if called repeatedly over a long period.
const MAX_SNAPSHOT_ENTRIES: u32 = 200;

#[soroban_sdk::contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct GovernanceSnapshot {
    pub ledger: u32,
    pub timestamp_approx: u64,
    pub total_proposals: u64,
    pub active_proposals: u64,
    pub total_votes_cast: i128,
    pub unique_voters: u64,
    /// votes_cast / total_eligible_supply at the ledger the snapshot was taken, in bps.
    pub participation_bps: u32,
    /// Fraction of all-time resolved proposals that reached quorum, in bps.
    pub quorum_hit_rate_bps: u32,
    /// Always 0 on-chain; populated by the indexer. See module docs.
    pub top_delegate_share_bps: u32,
    /// Always 0 on-chain; populated by the indexer. See module docs.
    pub delegation_rate_bps: u32,
    pub avg_vote_weight: i128,
    /// Fraction of all-time resolved proposals that passed (quorum met and
    /// `for` votes won), in bps.
    pub proposal_pass_rate_bps: u32,
}

#[soroban_sdk::contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AllTimeStats {
    pub total_proposals: u64,
    pub total_votes_cast: i128,
    pub unique_voters: u64,
    pub quorum_hit_count: u64,
    pub quorum_miss_count: u64,
    pub pass_rate_bps: u32,
    pub avg_participation_bps: u32,
}

#[soroban_sdk::contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ProposalParticipation {
    pub proposal_id: u64,
    pub total_eligible_supply: i128,
    pub total_votes_cast: i128,
    pub participation_bps: u32,
    pub quorum_required: i128,
    pub quorum_reached: bool,
    pub unique_voters: u32,
    pub for_bps: u32,
    pub against_bps: u32,
    pub abstain_bps: u32,
}

#[soroban_sdk::contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct VoterHistory {
    pub voter: Address,
    pub proposals_voted: u32,
    pub proposals_eligible: u32,
    pub participation_rate_bps: u32,
    pub total_weight_cast: i128,
    pub for_count: u32,
    pub against_count: u32,
    pub abstain_count: u32,
    pub last_voted_ledger: u32,
}

/// Running all-time totals. Consolidated into a single instance-storage
/// struct (rather than one `DataKey` per counter) to keep read/write cost
/// bounded to a single storage entry per update, matching the pattern used
/// for `ProposerReputation`.
#[soroban_sdk::contracttype]
#[derive(Clone, Debug, Default)]
pub struct AnalyticsTotals {
    pub total_proposals: u64,
    pub total_proposals_executed: u64,
    pub total_votes_cast: i128,
    pub unique_voters: u64,
    pub quorum_hit_count: u64,
    pub quorum_miss_count: u64,
    pub proposals_passed: u64,
    pub proposals_resolved: u64,
    pub participation_bps_sum: u64,
    pub participation_samples: u64,
}

fn get_totals(env: &Env) -> AnalyticsTotals {
    env.storage()
        .instance()
        .get(&DataKey::AnalyticsTotals)
        .unwrap_or_default()
}

fn save_totals(env: &Env, totals: &AnalyticsTotals) {
    env.storage().instance().set(&DataKey::AnalyticsTotals, totals);
}

/// Called once per `propose()` (via `create_proposal_internal`).
pub fn record_proposal_created(env: &Env) {
    let mut totals = get_totals(env);
    totals.total_proposals += 1;
    save_totals(env, &totals);
}

/// Called once per `execute()`, after the proposal is marked executed.
pub fn record_proposal_executed(env: &Env) {
    let mut totals = get_totals(env);
    totals.total_proposals_executed += 1;
    save_totals(env, &totals);
}

/// Called from `queue()` (quorum met, vote passed) and from the terminal
/// Defeated/Expired branches of `state()`. Idempotency is the caller's
/// responsibility — see the `lib.rs` call sites, which reuse the same
/// once-only guards already established for the reputation module.
pub fn record_proposal_resolved(
    env: &Env,
    quorum_reached: bool,
    passed: bool,
    participation_bps: Option<u32>,
) {
    let mut totals = get_totals(env);
    totals.proposals_resolved += 1;
    if quorum_reached {
        totals.quorum_hit_count += 1;
    } else {
        totals.quorum_miss_count += 1;
    }
    if passed {
        totals.proposals_passed += 1;
    }
    if let Some(bps) = participation_bps {
        totals.participation_bps_sum = totals.participation_bps_sum.saturating_add(bps as u64);
        totals.participation_samples += 1;
    }
    save_totals(env, &totals);
}

fn default_voter_history(voter: &Address) -> VoterHistory {
    VoterHistory {
        voter: voter.clone(),
        proposals_voted: 0,
        proposals_eligible: 0,
        participation_rate_bps: 0,
        total_weight_cast: 0,
        for_count: 0,
        against_count: 0,
        abstain_count: 0,
        last_voted_ledger: 0,
    }
}

pub fn get_voter_history(env: &Env, voter: &Address) -> VoterHistory {
    let mut history: VoterHistory = env
        .storage()
        .persistent()
        .get(&DataKey::AnalyticsVoterHistory(voter.clone()))
        .unwrap_or_else(|| default_voter_history(voter));

    // `proposals_eligible`/`participation_rate_bps` are derived at read time
    // against the current all-time proposal count so they never go stale
    // between votes.
    let total_proposals = get_totals(env).total_proposals;
    history.proposals_eligible = total_proposals.min(u32::MAX as u64) as u32;
    history.participation_rate_bps = if history.proposals_eligible > 0 {
        ((history.proposals_voted as u64) * 10_000 / history.proposals_eligible as u64) as u32
    } else {
        0
    };
    history
}

/// Called from `cast_vote` and `cast_vote_with_reason` after the vote is
/// recorded. Counts every cast vote (including zero-weight casts) as
/// participation, since the voter did interact with the proposal.
pub fn record_vote_cast(env: &Env, voter: &Address, support: &VoteSupport, weight: i128) {
    let mut totals = get_totals(env);
    totals.total_votes_cast = totals.total_votes_cast.saturating_add(weight);

    let unique_key = DataKey::AnalyticsUniqueVoter(voter.clone());
    let already_voted: bool = env.storage().persistent().get(&unique_key).unwrap_or(false);
    if !already_voted {
        totals.unique_voters += 1;
        env.storage().persistent().set(&unique_key, &true);
        env.storage()
            .persistent()
            .extend_ttl(&unique_key, ANALYTICS_TTL_LEDGERS, ANALYTICS_TTL_LEDGERS);
    }
    save_totals(env, &totals);

    let history_key = DataKey::AnalyticsVoterHistory(voter.clone());
    let mut history: VoterHistory = env
        .storage()
        .persistent()
        .get(&history_key)
        .unwrap_or_else(|| default_voter_history(voter));
    history.proposals_voted += 1;
    history.total_weight_cast = history.total_weight_cast.saturating_add(weight);
    history.last_voted_ledger = env.ledger().sequence();
    match support {
        VoteSupport::For => history.for_count += 1,
        VoteSupport::Against => history.against_count += 1,
        VoteSupport::Abstain => history.abstain_count += 1,
    }
    env.storage().persistent().set(&history_key, &history);
    env.storage()
        .persistent()
        .extend_ttl(&history_key, ANALYTICS_TTL_LEDGERS, ANALYTICS_TTL_LEDGERS);
}

pub fn get_all_time_stats(env: &Env) -> AllTimeStats {
    let totals = get_totals(env);
    let pass_rate_bps = if totals.proposals_resolved > 0 {
        (totals.proposals_passed * 10_000 / totals.proposals_resolved) as u32
    } else {
        0
    };
    let avg_participation_bps = if totals.participation_samples > 0 {
        (totals.participation_bps_sum / totals.participation_samples) as u32
    } else {
        0
    };
    AllTimeStats {
        total_proposals: totals.total_proposals,
        total_votes_cast: totals.total_votes_cast,
        unique_voters: totals.unique_voters,
        quorum_hit_count: totals.quorum_hit_count,
        quorum_miss_count: totals.quorum_miss_count,
        pass_rate_bps,
        avg_participation_bps,
    }
}

/// Pure computation of a proposal's participation breakdown — no storage
/// writes, safe to call at any point in a proposal's lifecycle (including
/// while still `Active`).
pub fn compute_proposal_participation(
    proposal: &Proposal,
    total_eligible_supply: i128,
    quorum_required: i128,
) -> ProposalParticipation {
    let total_votes_cast = proposal.votes_for + proposal.votes_against + proposal.votes_abstain;
    let participation_bps = if total_eligible_supply > 0 {
        (total_votes_cast.saturating_mul(BPS_DENOMINATOR) / total_eligible_supply)
            .clamp(0, i128::from(u32::MAX)) as u32
    } else {
        0
    };
    let bps_of = |part: i128| -> u32 {
        if total_votes_cast > 0 {
            (part.saturating_mul(BPS_DENOMINATOR) / total_votes_cast).clamp(0, i128::from(u32::MAX)) as u32
        } else {
            0
        }
    };

    ProposalParticipation {
        proposal_id: proposal.id,
        total_eligible_supply,
        total_votes_cast,
        participation_bps,
        quorum_required,
        quorum_reached: proposal.votes_for + proposal.votes_abstain >= quorum_required,
        // Not tracked per-proposal on-chain (would require an unbounded
        // per-proposal voter set); the indexer derives this from VoteCast
        // events. Callers needing an on-chain approximation should use
        // `total_votes_cast` alongside `AllTimeStats::unique_voters`.
        unique_voters: 0,
        for_bps: bps_of(proposal.votes_for),
        against_bps: bps_of(proposal.votes_against),
        abstain_bps: bps_of(proposal.votes_abstain),
    }
}

pub fn get_snapshot(env: &Env, ledger: u32) -> Option<GovernanceSnapshot> {
    env.storage().persistent().get(&DataKey::AnalyticsSnapshot(ledger))
}

pub fn get_snapshot_list(env: &Env) -> Vec<u32> {
    env.storage()
        .persistent()
        .get(&DataKey::AnalyticsSnapshotLedgerList)
        .unwrap_or(Vec::new(env))
}

pub fn get_latest_snapshot(env: &Env) -> Option<GovernanceSnapshot> {
    let list = get_snapshot_list(env);
    let last = list.get(list.len().checked_sub(1)?)?;
    get_snapshot(env, last)
}

/// Captures a `GovernanceSnapshot` for the current ledger and appends it to
/// the bounded snapshot history. `total_proposals`/`active_proposals` and
/// `total_eligible_supply` are computed by the caller in `lib.rs` (where
/// `Proposal` state iteration and strategy-aware supply lookups already
/// live) and passed in here purely for storage/aggregation.
pub fn take_snapshot(
    env: &Env,
    total_proposals: u64,
    active_proposals: u64,
    total_eligible_supply: i128,
) -> GovernanceSnapshot {
    let totals = get_totals(env);
    let ledger = env.ledger().sequence();

    let participation_bps = if total_eligible_supply > 0 {
        (totals.total_votes_cast.saturating_mul(BPS_DENOMINATOR) / total_eligible_supply)
            .clamp(0, i128::from(u32::MAX)) as u32
    } else {
        0
    };
    let quorum_hit_rate_bps = if totals.proposals_resolved > 0 {
        (totals.quorum_hit_count * 10_000 / totals.proposals_resolved) as u32
    } else {
        0
    };
    let proposal_pass_rate_bps = if totals.proposals_resolved > 0 {
        (totals.proposals_passed * 10_000 / totals.proposals_resolved) as u32
    } else {
        0
    };
    let avg_vote_weight = if totals.unique_voters > 0 {
        totals.total_votes_cast / totals.unique_voters as i128
    } else {
        0
    };

    let snapshot = GovernanceSnapshot {
        ledger,
        timestamp_approx: env.ledger().timestamp(),
        total_proposals,
        active_proposals,
        total_votes_cast: totals.total_votes_cast,
        unique_voters: totals.unique_voters,
        participation_bps,
        quorum_hit_rate_bps,
        top_delegate_share_bps: 0,
        delegation_rate_bps: 0,
        avg_vote_weight,
        proposal_pass_rate_bps,
    };

    env.storage()
        .persistent()
        .set(&DataKey::AnalyticsSnapshot(ledger), &snapshot);
    env.storage().persistent().extend_ttl(
        &DataKey::AnalyticsSnapshot(ledger),
        ANALYTICS_TTL_LEDGERS,
        ANALYTICS_TTL_LEDGERS,
    );

    let mut list = get_snapshot_list(env);
    list.push_back(ledger);
    while list.len() > MAX_SNAPSHOT_ENTRIES {
        list.pop_front();
    }
    env.storage()
        .persistent()
        .set(&DataKey::AnalyticsSnapshotLedgerList, &list);
    env.storage().persistent().extend_ttl(
        &DataKey::AnalyticsSnapshotLedgerList,
        ANALYTICS_TTL_LEDGERS,
        ANALYTICS_TTL_LEDGERS,
    );

    crate::events::emit_analytics_snapshot_taken(env, &snapshot);
    snapshot
}
