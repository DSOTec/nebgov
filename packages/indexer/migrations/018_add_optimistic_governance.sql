-- Up Migration
CREATE TABLE optimistic_proposals (
  proposal_id NUMERIC(20, 0) PRIMARY KEY,
  proposer TEXT NOT NULL,
  created_ledger BIGINT NOT NULL,
  challenge_end_ledger BIGINT NOT NULL,
  objection_votes NUMERIC(39, 0) NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'challenge_window',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_optimistic_proposals_status ON optimistic_proposals(state, proposal_id DESC);

CREATE TABLE optimistic_objections (
  proposal_id NUMERIC(20, 0) NOT NULL REFERENCES optimistic_proposals(proposal_id) ON DELETE CASCADE,
  objector TEXT NOT NULL,
  weight NUMERIC(39, 0) NOT NULL,
  running_total NUMERIC(39, 0) NOT NULL,
  ledger BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (proposal_id, objector)
);
CREATE INDEX idx_optimistic_objections_proposal ON optimistic_objections(proposal_id, ledger ASC);

-- Down Migration
DROP TABLE IF EXISTS optimistic_objections;
DROP TABLE IF EXISTS optimistic_proposals;
