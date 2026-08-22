-- Up Migration

CREATE TABLE IF NOT EXISTS treasury_strategies (
    strategy_id BIGINT PRIMARY KEY,
    adapter VARCHAR(56) NOT NULL,
    token VARCHAR(56) NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    current_allocation NUMERIC(39, 0) NOT NULL DEFAULT 0,
    registered_ledger INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_treasury_strategies_token ON treasury_strategies(token);

CREATE TABLE IF NOT EXISTS strategy_allocations (
    id SERIAL PRIMARY KEY,
    strategy_id BIGINT NOT NULL REFERENCES treasury_strategies(strategy_id),
    amount NUMERIC(39, 0) NOT NULL,
    ledger INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_strategy_allocations_strategy ON strategy_allocations(strategy_id);

CREATE TABLE IF NOT EXISTS strategy_withdrawals (
    id SERIAL PRIMARY KEY,
    withdrawal_id BIGINT NOT NULL UNIQUE,
    strategy_id BIGINT NOT NULL REFERENCES treasury_strategies(strategy_id),
    amount NUMERIC(39, 0) NOT NULL,
    actual_amount NUMERIC(39, 0),
    requested_ledger INTEGER NOT NULL,
    claimable_ledger INTEGER NOT NULL,
    claimed_ledger INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_strategy_withdrawals_strategy ON strategy_withdrawals(strategy_id);

-- Down Migration

DROP TABLE IF EXISTS strategy_withdrawals;
DROP TABLE IF EXISTS strategy_allocations;
DROP TABLE IF EXISTS treasury_strategies;
