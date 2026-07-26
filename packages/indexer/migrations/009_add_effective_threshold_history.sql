-- Up Migration

CREATE TABLE IF NOT EXISTS effective_threshold_history (
    id SERIAL PRIMARY KEY,
    proposer_address VARCHAR(56) NOT NULL,
    ledger INTEGER NOT NULL,
    old_threshold NUMERIC NOT NULL,
    new_threshold NUMERIC NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_effective_threshold_history_proposer
    ON effective_threshold_history(proposer_address, ledger DESC);

-- Down Migration

DROP TABLE IF EXISTS effective_threshold_history;
