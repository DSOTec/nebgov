-- Up Migration

CREATE TABLE IF NOT EXISTS signal_anchors (
    id SERIAL PRIMARY KEY,
    poll_id BIGINT NOT NULL UNIQUE,
    result_hash VARCHAR(64) NOT NULL,
    anchored_ledger INTEGER NOT NULL,
    anchorer VARCHAR(56) NOT NULL,
    tx_hash VARCHAR(64),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_signal_anchors_poll ON signal_anchors(poll_id);

-- Down Migration

DROP TABLE IF EXISTS signal_anchors;
