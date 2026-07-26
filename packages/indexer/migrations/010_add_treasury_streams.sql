-- Up Migration

CREATE TABLE treasury_streams (
  stream_id NUMERIC(20, 0) PRIMARY KEY,
  name TEXT NOT NULL,
  owner TEXT NOT NULL,
  token TEXT NOT NULL,
  total_allocated NUMERIC(39, 0) NOT NULL,
  total_spent NUMERIC(39, 0) NOT NULL,
  start_ledger BIGINT NOT NULL,
  end_ledger BIGINT NOT NULL,
  is_active BOOLEAN NOT NULL,
  is_revoked BOOLEAN NOT NULL,
  revoked_at_ledger BIGINT,
  max_single_spend NUMERIC(39, 0) NOT NULL,
  cooldown_ledgers BIGINT NOT NULL,
  last_spend_ledger BIGINT NOT NULL,
  spend_count BIGINT NOT NULL,
  created_by_proposal_id NUMERIC(20, 0) NOT NULL,
  updated_at_ledger BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_treasury_streams_owner
  ON treasury_streams(owner, stream_id);
CREATE INDEX idx_treasury_streams_token
  ON treasury_streams(token, stream_id);
CREATE INDEX idx_treasury_streams_active
  ON treasury_streams(is_active, stream_id);

CREATE TABLE treasury_stream_spends (
  stream_id NUMERIC(20, 0) NOT NULL
    REFERENCES treasury_streams(stream_id) ON DELETE CASCADE,
  spend_index BIGINT NOT NULL,
  recipient TEXT NOT NULL,
  amount NUMERIC(39, 0) NOT NULL,
  memo TEXT NOT NULL,
  executed_at_ledger BIGINT NOT NULL,
  executed_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (stream_id, spend_index)
);

CREATE INDEX idx_treasury_stream_spends_stream_ledger
  ON treasury_stream_spends(stream_id, executed_at_ledger DESC, spend_index DESC);
CREATE INDEX idx_treasury_stream_spends_recipient
  ON treasury_stream_spends(recipient, executed_at_ledger DESC);

CREATE TABLE treasury_stream_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  stream_id NUMERIC(20, 0) NOT NULL,
  name TEXT,
  owner TEXT,
  recipient TEXT,
  amount NUMERIC(39, 0),
  total_amount NUMERIC(39, 0),
  recipient_count BIGINT,
  caller TEXT,
  unspent_returned NUMERIC(39, 0),
  old_end_ledger BIGINT,
  new_end_ledger BIGINT,
  additional_amount NUMERIC(39, 0),
  new_total_amount NUMERIC(39, 0),
  unspent NUMERIC(39, 0),
  ledger BIGINT NOT NULL,
  transaction_hash TEXT,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_treasury_stream_events_stream
  ON treasury_stream_events(stream_id, ledger DESC, event_id DESC);
CREATE INDEX idx_treasury_stream_events_type
  ON treasury_stream_events(event_type, ledger DESC);

ALTER TABLE event_log ADD COLUMN event_id TEXT;
UPDATE event_log SET event_id = 'legacy-event-log:' || id WHERE event_id IS NULL;
ALTER TABLE event_log ALTER COLUMN event_id SET NOT NULL;
CREATE UNIQUE INDEX idx_event_log_event_id ON event_log(event_id);

INSERT INTO treasury_stream_events (
  event_id,
  event_type,
  stream_id,
  name,
  owner,
  recipient,
  amount,
  total_amount,
  recipient_count,
  caller,
  unspent_returned,
  old_end_ledger,
  new_end_ledger,
  additional_amount,
  new_total_amount,
  unspent,
  ledger,
  transaction_hash,
  payload
)
SELECT
  event_id,
  event_type,
  CASE
    WHEN event_type = 'stream_exhausted' THEN payload->>'value'
    ELSE payload->'value'->>0
  END::NUMERIC,
  CASE WHEN event_type = 'stream_created' THEN payload->'value'->>1 END,
  CASE WHEN event_type = 'stream_created' THEN payload->'value'->>2 END,
  CASE WHEN event_type = 'stream_spend' THEN payload->'value'->>1 END,
  CASE WHEN event_type = 'stream_spend' THEN (payload->'value'->>2)::NUMERIC END,
  CASE WHEN event_type = 'stream_batch' THEN (payload->'value'->>1)::NUMERIC END,
  CASE WHEN event_type = 'stream_batch' THEN (payload->'value'->>2)::BIGINT END,
  CASE WHEN event_type = 'stream_revoked' THEN payload->'value'->>1 END,
  CASE WHEN event_type = 'stream_revoked' THEN (payload->'value'->>2)::NUMERIC END,
  CASE WHEN event_type = 'stream_extended' THEN (payload->'value'->>1)::BIGINT END,
  CASE WHEN event_type = 'stream_extended' THEN (payload->'value'->>2)::BIGINT END,
  CASE WHEN event_type = 'stream_topped_up' THEN (payload->'value'->>1)::NUMERIC END,
  CASE WHEN event_type = 'stream_topped_up' THEN (payload->'value'->>2)::NUMERIC END,
  CASE WHEN event_type = 'stream_expired' THEN (payload->'value'->>1)::NUMERIC END,
  ledger,
  transaction_hash,
  payload
FROM event_log
WHERE event_type IN (
  'stream_created',
  'stream_spend',
  'stream_batch',
  'stream_revoked',
  'stream_extended',
  'stream_topped_up',
  'stream_exhausted',
  'stream_expired'
)
ON CONFLICT (event_id) DO NOTHING;

-- Down Migration

DROP INDEX IF EXISTS idx_event_log_event_id;
ALTER TABLE event_log DROP COLUMN IF EXISTS event_id;
DROP TABLE IF EXISTS treasury_stream_events;
DROP TABLE IF EXISTS treasury_stream_spends;
DROP TABLE IF EXISTS treasury_streams;
