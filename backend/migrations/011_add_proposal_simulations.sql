-- Up Migration

CREATE TABLE proposal_simulations (
    id SERIAL PRIMARY KEY,
    proposal_id BIGINT,
    description_hash VARCHAR(64),
    simulated_at TIMESTAMPTZ DEFAULT NOW(),
    simulated_at_ledger INTEGER NOT NULL,
    results JSONB NOT NULL,
    any_action_would_revert BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX idx_proposal_simulations_proposal_id ON proposal_simulations(proposal_id);
CREATE INDEX idx_proposal_simulations_description_hash ON proposal_simulations(description_hash);

-- Down Migration

DROP TABLE IF EXISTS proposal_simulations;
