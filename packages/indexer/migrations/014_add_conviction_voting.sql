-- Up Migration
CREATE TABLE conviction_proposals (
  proposal_id NUMERIC(20, 0) PRIMARY KEY,
  proposer TEXT NOT NULL,
  target TEXT NOT NULL,
  fn_name TEXT,
  calldata BYTEA,
  requested_amount NUMERIC(39, 0) NOT NULL,
  created_ledger BIGINT NOT NULL,
  conviction NUMERIC(39, 0) NOT NULL DEFAULT 0,
  last_updated_ledger BIGINT NOT NULL,
  executed BOOLEAN NOT NULL DEFAULT FALSE,
  cancelled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_conviction_proposals_status ON conviction_proposals(executed, cancelled, proposal_id DESC);

CREATE TABLE conviction_stakes (
  staker TEXT PRIMARY KEY,
  proposal_id NUMERIC(20, 0) NOT NULL REFERENCES conviction_proposals(proposal_id) ON DELETE CASCADE,
  amount NUMERIC(39, 0) NOT NULL,
  updated_at_ledger BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_conviction_stakes_proposal ON conviction_stakes(proposal_id, amount DESC);

CREATE TABLE conviction_snapshots (
  proposal_id NUMERIC(20, 0) NOT NULL REFERENCES conviction_proposals(proposal_id) ON DELETE CASCADE,
  ledger BIGINT NOT NULL,
  conviction NUMERIC(39, 0) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (proposal_id, ledger)
);
CREATE INDEX idx_conviction_snapshots_history ON conviction_snapshots(proposal_id, ledger ASC);

-- Down Migration
DROP TABLE IF EXISTS conviction_snapshots;
DROP TABLE IF EXISTS conviction_stakes;
DROP TABLE IF EXISTS conviction_proposals;
