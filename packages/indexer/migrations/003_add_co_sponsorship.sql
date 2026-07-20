-- Up Migration

CREATE TABLE IF NOT EXISTS drafts (
    id SERIAL PRIMARY KEY,
    draft_id BIGINT NOT NULL UNIQUE,
    creator_address VARCHAR(56) NOT NULL,
    description_hash TEXT,
    metadata_uri TEXT,
    created_ledger INTEGER NOT NULL,
    expiry_ledger INTEGER NOT NULL,
    total_power NUMERIC NOT NULL DEFAULT 0,
    finalized BOOLEAN NOT NULL DEFAULT FALSE,
    cancelled BOOLEAN NOT NULL DEFAULT FALSE,
    resulting_proposal_id BIGINT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS draft_co_sponsors (
    id SERIAL PRIMARY KEY,
    draft_id BIGINT NOT NULL REFERENCES drafts(draft_id),
    sponsor_address VARCHAR(56) NOT NULL,
    pledged_power NUMERIC NOT NULL,
    pledged_at_ledger INTEGER NOT NULL,
    withdrawn BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE(draft_id, sponsor_address)
);

CREATE INDEX IF NOT EXISTS idx_drafts_creator ON drafts(creator_address);
CREATE INDEX IF NOT EXISTS idx_drafts_active ON drafts(finalized, cancelled, expiry_ledger);
CREATE INDEX IF NOT EXISTS idx_draft_co_sponsors_draft_id ON draft_co_sponsors(draft_id);
CREATE INDEX IF NOT EXISTS idx_draft_co_sponsors_sponsor ON draft_co_sponsors(sponsor_address);

-- Down Migration

DROP TABLE IF EXISTS draft_co_sponsors;
DROP TABLE IF EXISTS drafts;
