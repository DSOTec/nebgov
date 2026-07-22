-- Up Migration

-- Governance analytics snapshots (issue #765). Populated exclusively from
-- the governor's permissionless `AnalyticsSnapshotTaken` event — the
-- contract computes participation/quorum-hit/pass-rate math on-chain
-- (see contracts/governor/src/analytics.rs) and this table just materializes
-- the history for fast, paginated reads.
CREATE TABLE IF NOT EXISTS governance_snapshots (
    id SERIAL PRIMARY KEY,
    ledger INTEGER NOT NULL UNIQUE,
    timestamp_approx BIGINT NOT NULL,
    total_proposals BIGINT NOT NULL,
    active_proposals BIGINT NOT NULL,
    total_votes_cast NUMERIC NOT NULL,
    unique_voters BIGINT NOT NULL,
    participation_bps INTEGER NOT NULL,
    quorum_hit_rate_bps INTEGER NOT NULL,
    top_delegate_share_bps INTEGER NOT NULL,
    delegation_rate_bps INTEGER NOT NULL,
    avg_vote_weight NUMERIC NOT NULL,
    proposal_pass_rate_bps INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_governance_snapshots_ledger ON governance_snapshots(ledger DESC);

-- Down Migration

DROP TABLE IF EXISTS governance_snapshots;
