-- Up Migration

CREATE TABLE notification_preferences (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  created_self BOOLEAN DEFAULT true,
  active BOOLEAN DEFAULT true,
  voting_ends_soon BOOLEAN DEFAULT true,
  outcome BOOLEAN DEFAULT true,
  queued BOOLEAN DEFAULT true,
  executed BOOLEAN DEFAULT true
);

CREATE TABLE notification_history (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  proposal_id BIGINT,
  message TEXT,
  read BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_notification_history_user_created_at
  ON notification_history(user_id, created_at DESC);
CREATE INDEX idx_notification_history_user_read
  ON notification_history(user_id, read);

-- Down Migration

DROP TABLE IF EXISTS notification_history;
DROP TABLE IF EXISTS notification_preferences;
