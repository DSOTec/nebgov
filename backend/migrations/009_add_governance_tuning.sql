-- Up Migration

-- Governance tuning recommender (issue #998): persists each computed
-- recommendation for audit history, and a singleton config row so the
-- analyzer's bands/caps/interval/auto-propose toggle are adjustable at
-- runtime via PUT /governance-tuning/config instead of requiring a restart.

CREATE TABLE IF NOT EXISTS governance_tuning_recommendations (
    id SERIAL PRIMARY KEY,
    computed_at TIMESTAMPTZ DEFAULT NOW(),
    current_quorum_numerator INTEGER NOT NULL,
    recommended_quorum_numerator INTEGER NOT NULL,
    current_proposal_threshold NUMERIC(38,0) NOT NULL,
    recommended_proposal_threshold NUMERIC(38,0) NOT NULL,
    rationale JSONB NOT NULL,
    auto_proposed BOOLEAN NOT NULL DEFAULT FALSE,
    proposal_id BIGINT
);

CREATE INDEX IF NOT EXISTS idx_governance_tuning_recommendations_computed_at
    ON governance_tuning_recommendations(computed_at DESC);

CREATE TABLE IF NOT EXISTS governance_tuning_config (
    id INTEGER PRIMARY KEY DEFAULT 1,
    min_quorum_numerator INTEGER NOT NULL DEFAULT 100,
    max_quorum_numerator INTEGER NOT NULL DEFAULT 5000,
    max_quorum_delta_bps INTEGER NOT NULL DEFAULT 200,
    min_proposal_threshold NUMERIC(38,0) NOT NULL DEFAULT 0,
    max_proposal_threshold NUMERIC(38,0),
    max_threshold_delta_bps INTEGER NOT NULL DEFAULT 1000,
    trailing_window INTEGER NOT NULL DEFAULT 10,
    interval_ms INTEGER NOT NULL DEFAULT 3600000,
    auto_propose BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT governance_tuning_config_singleton CHECK (id = 1)
);

INSERT INTO governance_tuning_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Down Migration

DROP TABLE IF EXISTS governance_tuning_config;
DROP TABLE IF EXISTS governance_tuning_recommendations;
