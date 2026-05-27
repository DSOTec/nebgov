-- Up Migration

CREATE TABLE proposals (
  id BIGINT PRIMARY KEY,
  proposer TEXT NOT NULL,
  description TEXT NOT NULL,
  start_ledger INT NOT NULL,
  end_ledger INT NOT NULL,
  votes_for BIGINT NOT NULL DEFAULT 0,
  votes_against BIGINT NOT NULL DEFAULT 0,
  votes_abstain BIGINT NOT NULL DEFAULT 0,
  executed BOOLEAN NOT NULL DEFAULT false,
  cancelled BOOLEAN NOT NULL DEFAULT false,
  queued BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE votes (
  id SERIAL PRIMARY KEY,
  proposal_id BIGINT NOT NULL REFERENCES proposals(id),
  voter TEXT NOT NULL,
  support SMALLINT NOT NULL,
  weight BIGINT NOT NULL,
  reason TEXT,
  ledger INT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(proposal_id, voter)
);

CREATE TABLE delegates (
  id SERIAL PRIMARY KEY,
  delegator TEXT NOT NULL,
  old_delegatee TEXT NOT NULL,
  new_delegatee TEXT NOT NULL,
  ledger INT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE wrapper_deposits (
  id SERIAL PRIMARY KEY,
  account TEXT NOT NULL,
  amount BIGINT NOT NULL,
  ledger INT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE wrapper_withdrawals (
  id SERIAL PRIMARY KEY,
  account TEXT NOT NULL,
  amount BIGINT NOT NULL,
  ledger INT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE treasury_transfers (
  id SERIAL PRIMARY KEY,
  op_hash TEXT NOT NULL,
  token TEXT NOT NULL,
  recipient_count INT NOT NULL,
  total_amount BIGINT NOT NULL,
  ledger INT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE indexer_state (
  id INT PRIMARY KEY DEFAULT 1,
  last_ledger INT NOT NULL DEFAULT 0
);

INSERT INTO indexer_state (id, last_ledger) VALUES (1, 0)
ON CONFLICT (id) DO NOTHING;

CREATE INDEX idx_proposals_created_at ON proposals(created_at DESC);
CREATE INDEX idx_proposals_proposer ON proposals(proposer);

CREATE INDEX idx_votes_proposal_id ON votes(proposal_id);
CREATE INDEX idx_votes_voter ON votes(voter);

CREATE INDEX idx_delegates_delegator ON delegates(delegator);
CREATE INDEX idx_delegates_ledger ON delegates(ledger DESC);
CREATE INDEX idx_delegates_new_delegatee ON delegates(new_delegatee);

CREATE INDEX idx_wrapper_deposits_account ON wrapper_deposits(account);
CREATE INDEX idx_wrapper_withdrawals_account ON wrapper_withdrawals(account);

CREATE TABLE config_updates (
  id SERIAL PRIMARY KEY,
  ledger INT NOT NULL,
  new_settings JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE governor_upgrades (
  id SERIAL PRIMARY KEY,
  ledger INT NOT NULL,
  new_wasm_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_config_updates_ledger ON config_updates(ledger DESC);
CREATE INDEX idx_governor_upgrades_ledger ON governor_upgrades(ledger DESC);

-- Down Migration

DROP TABLE IF EXISTS governor_upgrades;
DROP TABLE IF EXISTS config_updates;
DROP TABLE IF EXISTS votes;
DROP TABLE IF EXISTS delegates;
DROP TABLE IF EXISTS wrapper_deposits;
DROP TABLE IF EXISTS wrapper_withdrawals;
DROP TABLE IF EXISTS treasury_transfers;
DROP TABLE IF EXISTS indexer_state;
DROP TABLE IF EXISTS proposals;
