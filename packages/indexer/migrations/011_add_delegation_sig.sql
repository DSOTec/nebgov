-- Up Migration

CREATE TABLE IF NOT EXISTS delegated_by_sig_events (
    id SERIAL PRIMARY KEY,
    delegator_address VARCHAR(56) NOT NULL,
    delegatee_address VARCHAR(56) NOT NULL,
    relayer_address VARCHAR(56) NOT NULL,
    nonce NUMERIC NOT NULL,
    ledger INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_delegated_by_sig_relayer
    ON delegated_by_sig_events(relayer_address, ledger DESC);
CREATE INDEX IF NOT EXISTS idx_delegated_by_sig_delegator
    ON delegated_by_sig_events(delegator_address, ledger DESC);

CREATE TABLE IF NOT EXISTS relayer_whitelist_history (
    id SERIAL PRIMARY KEY,
    relayer_address VARCHAR(56) NOT NULL,
    whitelisted BOOLEAN NOT NULL,
    ledger INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_relayer_whitelist_history_relayer
    ON relayer_whitelist_history(relayer_address, ledger DESC);

-- Down Migration

DROP TABLE IF EXISTS relayer_whitelist_history;
DROP TABLE IF EXISTS delegated_by_sig_events;
