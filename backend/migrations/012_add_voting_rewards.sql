-- Up Migration

CREATE TABLE voting_reward_epochs (
    id SERIAL PRIMARY KEY,
    epoch_id BIGINT NOT NULL UNIQUE,
    start_ledger INTEGER NOT NULL,
    end_ledger INTEGER NOT NULL,
    merkle_root VARCHAR(64),
    total_reward_amount NUMERIC(38,0) NOT NULL,
    published_at TIMESTAMP,
    -- Set when the epoch's root is published through governance rather than
    -- by a relayer that is itself the contract's admin. Not in the issue's
    -- sketch, but the same guard `governance_tuning_recommendations.proposal_id`
    -- exists for: without it the publisher would resubmit an identical
    -- `publish_epoch_root` proposal on every cycle for the days it takes the
    -- first one to clear voting and the timelock.
    publish_proposal_id BIGINT
);

CREATE TABLE voting_reward_claims (
    id SERIAL PRIMARY KEY,
    epoch_id BIGINT NOT NULL,
    claimant_address VARCHAR(56) NOT NULL,
    amount NUMERIC(38,0) NOT NULL,
    -- Precomputed so the frontend never has to rebuild the tree client-side
    -- (and so a claimant can never be handed a proof derived from a
    -- different tree than the root that was published on-chain).
    merkle_proof JSONB NOT NULL,
    claimed BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE(epoch_id, claimant_address)
);

CREATE INDEX idx_voting_reward_claims_claimant ON voting_reward_claims(claimant_address);
CREATE INDEX idx_voting_reward_claims_epoch ON voting_reward_claims(epoch_id);
CREATE INDEX idx_voting_reward_claims_unclaimed
    ON voting_reward_claims(claimant_address) WHERE claimed = FALSE;

-- Down Migration

DROP TABLE IF EXISTS voting_reward_claims;
DROP TABLE IF EXISTS voting_reward_epochs;
