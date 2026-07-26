-- Up Migration

ALTER TABLE drafts ADD COLUMN IF NOT EXISTS expired BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_drafts_expired ON drafts(expired);

-- Down Migration

DROP INDEX IF EXISTS idx_drafts_expired;
ALTER TABLE drafts DROP COLUMN IF EXISTS expired;
