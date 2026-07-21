-- Migration 007: Add relayer permit log for issue #772
-- Tracks every signed DelegationPermit the relayer backend has submitted, so
-- POST /relayer/delegate can enforce a per-delegator daily quota against the
-- relayer's own gas budget, and so submissions are auditable/idempotent.

CREATE TABLE IF NOT EXISTS relayer_permit_log (
    id              BIGSERIAL PRIMARY KEY,
    delegator       TEXT        NOT NULL,
    delegatee       TEXT        NOT NULL,
    nonce           NUMERIC     NOT NULL,
    tx_hash         TEXT        NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_relayer_permit_log_delegator_created_at
    ON relayer_permit_log (delegator, created_at);

-- A given delegator+nonce should only ever be relayed once.
CREATE UNIQUE INDEX IF NOT EXISTS idx_relayer_permit_log_delegator_nonce
    ON relayer_permit_log (delegator, nonce);
