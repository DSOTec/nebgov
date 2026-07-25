-- Up Migration

CREATE TABLE notification_rules (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(128) NOT NULL,
  trigger_type VARCHAR(64) NOT NULL,
  trigger_config JSONB NOT NULL DEFAULT '{}',
  channels JSONB NOT NULL DEFAULT '[]',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  cooldown_seconds INTEGER NOT NULL DEFAULT 300,
  last_triggered_at TIMESTAMPTZ,
  trigger_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE notification_deliveries (
  id SERIAL PRIMARY KEY,
  rule_id INTEGER NOT NULL REFERENCES notification_rules(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type VARCHAR(64) NOT NULL,
  event_payload JSONB NOT NULL,
  channel_type VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending', -- pending|delivered|failed|retrying
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  next_retry_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE in_app_notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rule_id INTEGER REFERENCES notification_rules(id) ON DELETE SET NULL,
  title VARCHAR(256) NOT NULL,
  body TEXT NOT NULL,
  action_url TEXT,
  read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Single-row cursor tracking the last indexer event_log.id the notification
-- processor has evaluated, so restarts resume without re-scanning history or
-- re-delivering already-matched notifications.
CREATE TABLE notification_event_cursor (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_event_id BIGINT NOT NULL DEFAULT 0
);
INSERT INTO notification_event_cursor (id, last_event_id) VALUES (1, 0)
  ON CONFLICT (id) DO NOTHING;

CREATE INDEX idx_notification_rules_user ON notification_rules(user_id);
CREATE INDEX idx_notification_rules_trigger_type ON notification_rules(trigger_type) WHERE enabled = true;
CREATE INDEX idx_notification_deliveries_status ON notification_deliveries(status, next_retry_at);
CREATE INDEX idx_notification_deliveries_rule ON notification_deliveries(rule_id);
CREATE INDEX idx_in_app_notifications_user ON in_app_notifications(user_id, read, created_at DESC);

-- Down Migration

DROP TABLE IF EXISTS notification_event_cursor;
DROP TABLE IF EXISTS in_app_notifications;
DROP TABLE IF EXISTS notification_deliveries;
DROP TABLE IF EXISTS notification_rules;
