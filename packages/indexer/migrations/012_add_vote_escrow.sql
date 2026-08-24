-- Up Migration

CREATE TABLE IF NOT EXISTS vote_escrow_locks (
    id SERIAL PRIMARY KEY,
    owner_address VARCHAR(56) NOT NULL,
    amount NUMERIC(38,0) NOT NULL,
    start_ledger INTEGER NOT NULL,
    end_ledger INTEGER NOT NULL,
    initial_voting_power NUMERIC(38,0) NOT NULL,
    withdrawn BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vote_escrow_owner ON vote_escrow_locks(owner_address);
CREATE INDEX IF NOT EXISTS idx_vote_escrow_end_ledger ON vote_escrow_locks(end_ledger);
CREATE INDEX IF NOT EXISTS idx_vote_escrow_withdrawn ON vote_escrow_locks(withdrawn);

-- Down Migration

DROP TABLE IF EXISTS vote_escrow_locks;
