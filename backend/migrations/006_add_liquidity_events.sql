-- Migration 006: Add liquidity event tables for issue #602
-- Tracks add_liquidity, remove_liquidity, swap, and update_pool_fee events
-- emitted by the liquidity contract so the off-chain indexer can reconstruct
-- LP positions, swap volumes, and fee history without per-address on-chain queries.

-- Unified LP activity log (add + remove)
CREATE TABLE IF NOT EXISTS liquidity_events (
    id              BIGSERIAL PRIMARY KEY,
    event_type      TEXT        NOT NULL CHECK (event_type IN ('add', 'remove')),
    provider        TEXT        NOT NULL,
    outcome_a       INTEGER     NOT NULL,
    outcome_b       INTEGER     NOT NULL,
    amount_a        NUMERIC     NOT NULL,
    amount_b        NUMERIC     NOT NULL,
    lp_tokens       NUMERIC     NOT NULL,
    ledger          INTEGER     NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_liquidity_events_provider
    ON liquidity_events (provider);
CREATE INDEX IF NOT EXISTS idx_liquidity_events_pool
    ON liquidity_events (outcome_a, outcome_b);
CREATE INDEX IF NOT EXISTS idx_liquidity_events_ledger
    ON liquidity_events (ledger);

-- Swap history
CREATE TABLE IF NOT EXISTS swap_events (
    id          BIGSERIAL PRIMARY KEY,
    trader      TEXT        NOT NULL,
    outcome_in  INTEGER     NOT NULL,
    outcome_out INTEGER     NOT NULL,
    amount_in   NUMERIC     NOT NULL,
    amount_out  NUMERIC     NOT NULL,
    fee         NUMERIC     NOT NULL,
    ledger      INTEGER     NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_swap_events_trader
    ON swap_events (trader);
CREATE INDEX IF NOT EXISTS idx_swap_events_pool
    ON swap_events (outcome_in, outcome_out);
CREATE INDEX IF NOT EXISTS idx_swap_events_ledger
    ON swap_events (ledger);

-- Fee change audit log
CREATE TABLE IF NOT EXISTS pool_fee_updates (
    id          BIGSERIAL PRIMARY KEY,
    outcome_a   INTEGER     NOT NULL,
    outcome_b   INTEGER     NOT NULL,
    old_fee_bps INTEGER     NOT NULL,
    new_fee_bps INTEGER     NOT NULL,
    ledger      INTEGER     NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pool_fee_updates_pool
    ON pool_fee_updates (outcome_a, outcome_b);
