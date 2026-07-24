-- Up Migration

CREATE TABLE IF NOT EXISTS proposer_reputation (
    id SERIAL PRIMARY KEY,
    proposer_address VARCHAR(56) NOT NULL UNIQUE,
    reputation_score INTEGER NOT NULL DEFAULT 0,
    last_updated_ledger INTEGER,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reputation_score ON proposer_reputation(reputation_score DESC);

CREATE TABLE IF NOT EXISTS reputation_score_history (
    id SERIAL PRIMARY KEY,
    proposer_address VARCHAR(56) NOT NULL,
    ledger INTEGER NOT NULL,
    score INTEGER NOT NULL,
    change INTEGER NOT NULL,
    reason VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reputation_history_proposer ON reputation_score_history(proposer_address, ledger DESC);

-- Down Migration

DROP TABLE IF EXISTS reputation_score_history;
DROP TABLE IF EXISTS proposer_reputation;
