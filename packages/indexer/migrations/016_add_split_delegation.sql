-- Up Migration

CREATE TABLE IF NOT EXISTS split_delegations (
    id SERIAL PRIMARY KEY,
    delegator_address VARCHAR(56) NOT NULL,
    delegatee_address VARCHAR(56) NOT NULL,
    weight_bps INTEGER NOT NULL,
    delegated_power NUMERIC(38,0) NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_split_delegator ON split_delegations(delegator_address) WHERE active;
CREATE INDEX IF NOT EXISTS idx_split_delegatee ON split_delegations(delegatee_address) WHERE active;

-- Down Migration

DROP TABLE IF EXISTS split_delegations;
