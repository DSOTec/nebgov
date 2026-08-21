-- Up Migration

ALTER TABLE proposals ADD COLUMN IF NOT EXISTS description_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_proposals_description_hash ON proposals(description_hash);

CREATE TABLE IF NOT EXISTS proposal_bonds (
    id SERIAL PRIMARY KEY,
    description_hash TEXT NOT NULL UNIQUE,
    proposer_address VARCHAR(56) NOT NULL,
    amount NUMERIC NOT NULL,
    state VARCHAR(16) NOT NULL DEFAULT 'locked',
    locked_ledger INTEGER NOT NULL,
    refunded_ledger INTEGER,
    slashed_ledger INTEGER,
    slash_recipient VARCHAR(56),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_proposal_bonds_proposer ON proposal_bonds(proposer_address);
CREATE INDEX IF NOT EXISTS idx_proposal_bonds_state ON proposal_bonds(state);

-- Down Migration

DROP TABLE IF EXISTS proposal_bonds;
DROP INDEX IF EXISTS idx_proposals_description_hash;
ALTER TABLE proposals DROP COLUMN IF EXISTS description_hash;
