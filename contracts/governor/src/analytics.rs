//! On-chain Governance Analytics Module (Issue #765).
//!
//! Tracks participation, proposal outcomes, and per-voter history so the
//! indexer/frontend can serve governance health metrics without recomputing
//! everything client-side from raw contract data on every page load.
//!
//! Delegation-concentration metrics (top-delegate share, delegation rate)
//! are deliberately *not* part of the on-chain `GovernanceSnapshot`: the
//! governor has no cross-contract visibility into the token-votes
//! contract's full delegator set (only per-delegatee lookups exist there),
//! and every extra `#[contracttype]` field has a real WASM-size cost. The
//! indexer's `/analytics/snapshots*` responses carry these as
//! indexer-aggregated fields instead (currently `0`, pending a future
//! aggregation pass off delegation events) — see `packages/indexer/src/api.ts`.

use soroban_sdk::{Address, Env};

use crate::{DataKey, Proposal};

const BPS_DENOMINATOR: i128 = 10_000;
/// TTL applied to analytics persistent entries on write. Generous and
/// long-lived, matching the reputation module's convention for low-churn,
/// long-lived aggregate data.
const ANALYTICS_TTL_LEDGERS: u32 = 3_110_400;

/// A point-in-time governance participation reading. Deliberately minimal:
/// `participation_bps` is the one metric that's inherently point-in-time
/// (relative to the eligible supply *at that ledger*) and can't be
/// reconstructed later from `AllTimeStats` alone. Every other all-time
/// counter (total proposals, votes cast, unique voters, pass/quorum rates)
/// is available live from `get_all_time_stats()` and was cut from this
/// struct to stay under Soroban's WASM size cap — see module docs and the
/// indexer's `governance_snapshots` table, which reconstructs historical
/// totals from its own indexed event history instead.
#[soroban_sdk::contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct GovernanceSnapshot {
    pub ledger: u32,
    pub participation_bps: u32,
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
}

/// Running all-time totals, consolidated into a single instance-storage
/// entry rather than one `DataKey` per counter.
#[soroban_sdk::contracttype]
#[derive(Clone, Debug, Default)]
pub struct AnalyticsTotals {
    pub total_proposals: u64,
    pub total_votes_cast: i128,
    pub unique_voters: u64,
    pub quorum_hit_count: u64,
    pub quorum_miss_count: u64,
    pub proposals_passed: u64,
    pub proposals_resolved: u64,
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

/// Called from `queue()` (quorum met, vote passed) and from the terminal
/// Defeated/Expired branches of `state()`. Idempotency is the caller's
/// responsibility — see the `lib.rs` call sites, which reuse the same
/// once-only guards already established for the reputation module.
pub fn record_proposal_resolved(env: &Env, quorum_reached: bool, passed: bool) {
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
    save_totals(env, &totals);
}

/// Called from `cast_vote` and `cast_vote_with_reason` after the vote is
/// recorded. Counts every cast vote (including zero-weight casts) as
/// participation, since the voter did interact with the proposal.
///
/// Per-voter history (proposals voted, for/against/abstain breakdown, etc.)
/// is intentionally *not* tracked here — it would need its own
/// `#[contracttype]` plus a persistent entry per voter, at real WASM-size
/// cost, for data the indexer already derives live and more cheaply from
/// indexed `VoteCast` events (see `GET /analytics/voters/:address/history`
/// in `packages/indexer/src/api.ts`). Only the aggregate totals needed for
/// `AllTimeStats` are kept on-chain.
pub fn record_vote_cast(env: &Env, voter: &Address, weight: i128) {
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
}

pub fn get_all_time_stats(env: &Env) -> AllTimeStats {
    let totals = get_totals(env);
    let pass_rate_bps = totals
        .proposals_passed
        .checked_mul(10_000)
        .and_then(|v| v.checked_div(totals.proposals_resolved))
        .unwrap_or(0) as u32;
    AllTimeStats {
        total_proposals: totals.total_proposals,
        total_votes_cast: totals.total_votes_cast,
        unique_voters: totals.unique_voters,
        quorum_hit_count: totals.quorum_hit_count,
        quorum_miss_count: totals.quorum_miss_count,
        pass_rate_bps,
    }
}

/// Pure computation of a proposal's participation breakdown — no storage
/// writes, safe to call at any point in a proposal's lifecycle (including
/// while still `Active`). Doesn't include a for/against/abstain bps
/// breakdown: the base contract's existing `proposal_votes()` already
/// exposes the raw for/against/abstain totals, so callers can derive bps
/// from `total_votes_cast` here without this type duplicating that data.
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

    ProposalParticipation {
        proposal_id: proposal.id,
        total_eligible_supply,
        total_votes_cast,
        participation_bps,
        quorum_required,
        quorum_reached: proposal.votes_for + proposal.votes_abstain >= quorum_required,
    }
}

/// Computes a `GovernanceSnapshot` for the current ledger and emits it as an
/// `AnalyticsSnapshotTaken` event. Deliberately *not* persisted on-chain
/// (no bounded snapshot-history storage, no `get_snapshot`/`get_snapshot_list`)
/// — the indexer already materializes every emitted snapshot into its own
/// `governance_snapshots` table (see `packages/indexer/src/events.ts`),
/// which is the documented path for historical/paginated snapshot reads.
/// Keeping a *second*, on-chain copy of the same bounded history would only
/// add WASM size for a capability the indexer already provides.
/// `total_eligible_supply` is computed by the caller in `lib.rs` (where
/// strategy-aware supply lookups already live) and passed in here purely
/// for the participation-bps calculation.
pub fn take_snapshot(env: &Env, total_eligible_supply: i128) -> GovernanceSnapshot {
    let totals = get_totals(env);

    let participation_bps = if total_eligible_supply > 0 {
        (totals.total_votes_cast.saturating_mul(BPS_DENOMINATOR) / total_eligible_supply)
            .clamp(0, i128::from(u32::MAX)) as u32
    } else {
        0
    };

    let snapshot = GovernanceSnapshot {
        ledger: env.ledger().sequence(),
        participation_bps,
    };

    crate::events::emit_analytics_snapshot_taken(env, &snapshot);
    snapshot
}
