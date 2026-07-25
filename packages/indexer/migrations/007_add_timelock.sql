-- Up Migration

CREATE TABLE timelock_operations (
  op_id TEXT PRIMARY KEY,
  target TEXT NOT NULL,
  fn_name TEXT NOT NULL,
  ready_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  executed_by TEXT,
  executed_at_ledger INT,
  cancelled_by TEXT,
  cancelled_at_ledger INT,
  ledger INT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_timelock_operations_status ON timelock_operations(status);
CREATE INDEX idx_timelock_operations_ledger ON timelock_operations(ledger DESC);

CREATE TABLE timelock_batch_operations (
  batch_op_id TEXT PRIMARY KEY,
  targets JSONB NOT NULL,
  fn_names JSONB NOT NULL,
  ready_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  executed_by TEXT,
  executed_at_ledger INT,
  cancelled_by TEXT,
  cancelled_at_ledger INT,
  ledger INT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_timelock_batch_operations_status ON timelock_batch_operations(status);
CREATE INDEX idx_timelock_batch_operations_ledger ON timelock_batch_operations(ledger DESC);

CREATE TABLE timelock_dependency_graphs (
  validation_id TEXT PRIMARY KEY,
  batch_op_id TEXT,
  op_count INT,
  has_cycle BOOLEAN NOT NULL DEFAULT FALSE,
  cycle_path JSONB,
  ledger INT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_timelock_dependency_graphs_batch
  ON timelock_dependency_graphs(batch_op_id, ledger DESC);

CREATE TABLE timelock_partial_batch_state (
  batch_op_id TEXT PRIMARY KEY,
  total_ops INT NOT NULL,
  completed_ops INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'in_progress',
  last_op_id TEXT,
  last_status TEXT,
  retry_count INT NOT NULL DEFAULT 0,
  recovery_deadline INT,
  started_at_ledger INT NOT NULL,
  completed_at_ledger INT,
  updated_at_ledger INT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Down Migration

DROP TABLE IF EXISTS timelock_partial_batch_state;
DROP TABLE IF EXISTS timelock_dependency_graphs;
DROP TABLE IF EXISTS timelock_batch_operations;
DROP TABLE IF EXISTS timelock_operations;
