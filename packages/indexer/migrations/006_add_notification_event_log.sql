-- Up Migration

CREATE TABLE event_log (
    id BIGSERIAL PRIMARY KEY,
    event_type VARCHAR(64) NOT NULL,
    ledger INTEGER NOT NULL,
    transaction_hash VARCHAR(64),
    contract_address VARCHAR(56) NOT NULL,
    payload JSONB NOT NULL,
    indexed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_event_log_type_ledger ON event_log(event_type, ledger);
CREATE INDEX idx_event_log_indexed_at ON event_log(indexed_at);

-- Down Migration

DROP TABLE IF EXISTS event_log;
