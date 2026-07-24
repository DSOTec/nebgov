-- Up Migration

-- Governance analytics snapshots (issue #765). Populated exclusively from
-- the governor's permissionless `AnalyticsSnapshotTaken` event. Deliberately
-- a pure participation-over-time series (ledger + participation_bps) — the
-- on-chain `GovernanceSnapshot` struct was trimmed to just these fields to
-- stay under Soroban's WASM size cap (see
-- contracts/governor/src/analytics.rs). Current composite totals (proposals,
-- votes cast, unique voters, pass/quorum rates) are served live from
-- `/analytics/all-time-stats` instead, not materialized here.
CREATE TABLE IF NOT EXISTS governance_snapshots (
    id SERIAL PRIMARY KEY,
    ledger INTEGER NOT NULL UNIQUE,
    participation_bps INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_governance_snapshots_ledger ON governance_snapshots(ledger DESC);

-- Down Migration

DROP TABLE IF EXISTS governance_snapshots;
