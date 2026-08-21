-- Up Migration

CREATE TABLE signaling_polls (
  id SERIAL PRIMARY KEY,
  creator_address VARCHAR(56) NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  choices JSONB NOT NULL,
  snapshot_ledger INTEGER NOT NULL,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  finalized BOOLEAN NOT NULL DEFAULT FALSE,
  result_hash VARCHAR(64),
  anchored_tx_hash VARCHAR(64),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE signaling_votes (
  id SERIAL PRIMARY KEY,
  poll_id INTEGER NOT NULL REFERENCES signaling_polls(id),
  voter_address VARCHAR(56) NOT NULL,
  choice_index INTEGER NOT NULL,
  nonce VARCHAR(64) NOT NULL,
  signature TEXT NOT NULL,
  voting_power NUMERIC(38, 0),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (poll_id, voter_address)
);

CREATE INDEX idx_signaling_polls_creator ON signaling_polls(creator_address);
CREATE INDEX idx_signaling_polls_end_time_finalized ON signaling_polls(end_time) WHERE finalized = FALSE;
CREATE INDEX idx_signaling_votes_poll ON signaling_votes(poll_id);

-- Down Migration

DROP TABLE IF EXISTS signaling_votes;
DROP TABLE IF EXISTS signaling_polls;
