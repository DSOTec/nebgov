-- Up Migration

CREATE TABLE IF NOT EXISTS delegation_entries (
    id SERIAL PRIMARY KEY,
    delegator_address VARCHAR(56) NOT NULL,
    delegatee_address VARCHAR(56) NOT NULL,
    delegated_at_ledger INTEGER NOT NULL,
    revoked_at_ledger INTEGER,
    power_at_delegation NUMERIC NOT NULL,
    chain_depth INTEGER NOT NULL DEFAULT 1,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_delegation_delegatee ON delegation_entries(delegatee_address) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS idx_delegation_delegator ON delegation_entries(delegator_address);

CREATE TABLE IF NOT EXISTS delegation_history_snapshots (
    id SERIAL PRIMARY KEY,
    snapshot_ledger INTEGER NOT NULL,
    delegatee_address VARCHAR(56) NOT NULL,
    total_delegators INTEGER NOT NULL,
    total_delegated_power NUMERIC NOT NULL,
    gini_coefficient NUMERIC,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_delegation_snapshots_delegatee ON delegation_history_snapshots(delegatee_address, snapshot_ledger DESC);

-- Down Migration

DROP TABLE IF EXISTS delegation_history_snapshots;
DROP TABLE IF EXISTS delegation_entries;
