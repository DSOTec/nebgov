-- Up Migration

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'proposer_reputation'
          AND column_name = 'proposer'
    ) AND NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'proposer_reputation'
          AND column_name = 'proposer_address'
    ) THEN
        ALTER TABLE proposer_reputation RENAME TO proposer_reputation_events;
    END IF;
END
$$;

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

DO $$
BEGIN
    IF to_regclass(current_schema() || '.proposer_reputation_events') IS NOT NULL
       AND to_regclass(current_schema() || '.proposer_reputation') IS NULL THEN
        ALTER TABLE proposer_reputation_events RENAME TO proposer_reputation;
    END IF;
END
$$;
