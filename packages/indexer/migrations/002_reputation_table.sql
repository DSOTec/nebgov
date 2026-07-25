-- Up Migration

CREATE TABLE proposer_reputation (
  id SERIAL PRIMARY KEY,
  proposer TEXT NOT NULL,
  old_score BIGINT,
  new_score BIGINT NOT NULL,
  reason TEXT,
  ledger INT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_proposer_reputation_proposer ON proposer_reputation(proposer);
CREATE INDEX idx_proposer_reputation_ledger ON proposer_reputation(ledger DESC);

-- Down Migration

DROP TABLE IF EXISTS proposer_reputation;
