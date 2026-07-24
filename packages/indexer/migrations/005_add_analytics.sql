-- Up Migration

-- Governance analytics snapshots (issue #765). A votes-cast-over-time
-- series, computed periodically by the indexer's poll loop entirely from
-- its own already-indexed `votes` table (see `maybeTakeGovernanceSnapshot`
-- in `packages/indexer/src/events.ts`) — there's no on-chain analytics
-- module to source this from; it doesn't fit alongside the proposer
-- reputation module's own WASM-size budget. Current composite totals
-- (proposals, votes cast, unique voters) are served live from
-- `/analytics/all-time-stats` instead, not materialized here.
CREATE TABLE IF NOT EXISTS governance_snapshots (
    id SERIAL PRIMARY KEY,
    ledger INTEGER NOT NULL UNIQUE,
    total_votes_cast NUMERIC NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_governance_snapshots_ledger ON governance_snapshots(ledger DESC);

-- Down Migration

DROP TABLE IF EXISTS governance_snapshots;
