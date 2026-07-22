-- Up Migration

CREATE TABLE IF NOT EXISTS proposer_reputation (
    id SERIAL PRIMARY KEY,
    proposer_address VARCHAR(56) NOT NULL UNIQUE,
    total_proposals INTEGER NOT NULL DEFAULT 0,
    proposals_succeeded INTEGER NOT NULL DEFAULT 0,
    proposals_executed INTEGER NOT NULL DEFAULT 0,
    proposals_defeated INTEGER NOT NULL DEFAULT 0,
    proposals_cancelled INTEGER NOT NULL DEFAULT 0,
    proposals_expired INTEGER NOT NULL DEFAULT 0,
    reputation_score INTEGER NOT NULL DEFAULT 0,
    threshold_multiplier_bps INTEGER NOT NULL DEFAULT 10000,
    consecutive_successful INTEGER NOT NULL DEFAULT 0,
    consecutive_failed INTEGER NOT NULL DEFAULT 0,
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

-- Singleton row (id = 1) mirroring the governor's on-chain ReputationConfig,
-- kept in sync by the ReputationConfigUpdated event handler.
CREATE TABLE IF NOT EXISTS reputation_config (
    id INTEGER PRIMARY KEY DEFAULT 1,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    score_for_succeed INTEGER NOT NULL DEFAULT 100,
    score_for_executed INTEGER NOT NULL DEFAULT 50,
    score_for_defeated INTEGER NOT NULL DEFAULT -30,
    score_for_cancelled INTEGER NOT NULL DEFAULT -20,
    score_for_expired INTEGER NOT NULL DEFAULT -60,
    score_for_high_participation INTEGER NOT NULL DEFAULT 30,
    min_proposals_for_discount INTEGER NOT NULL DEFAULT 3,
    max_score INTEGER NOT NULL DEFAULT 1000,
    min_score INTEGER NOT NULL DEFAULT -1000,
    max_threshold_multiplier_bps INTEGER NOT NULL DEFAULT 20000,
    min_threshold_multiplier_bps INTEGER NOT NULL DEFAULT 5000,
    decay_rate_per_1000_ledgers INTEGER NOT NULL DEFAULT 10,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT reputation_config_singleton CHECK (id = 1)
);

-- Down Migration

DROP TABLE IF EXISTS reputation_config;
DROP TABLE IF EXISTS reputation_score_history;
DROP TABLE IF EXISTS proposer_reputation;
