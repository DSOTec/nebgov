import type { MigrationBuilder } from "node-pg-migrate";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("proposals", {
    id: { type: "bigint", primaryKey: true },
    proposer: { type: "text", notNull: true },
    description: { type: "text", notNull: true },
    start_ledger: { type: "int", notNull: true },
    end_ledger: { type: "int", notNull: true },
    votes_for: { type: "bigint", notNull: true, default: 0 },
    votes_against: { type: "bigint", notNull: true, default: 0 },
    votes_abstain: { type: "bigint", notNull: true, default: 0 },
    executed: { type: "boolean", notNull: true, default: false },
    cancelled: { type: "boolean", notNull: true, default: false },
    queued: { type: "boolean", notNull: true, default: false },
    created_at: { type: "timestamp", default: pgm.func("NOW()") },
  });

  pgm.createTable("votes", {
    id: { type: "serial", primaryKey: true },
    proposal_id: {
      type: "bigint",
      notNull: true,
      references: '"proposals"',
      onDelete: "CASCADE",
    },
    voter: { type: "text", notNull: true },
    support: { type: "smallint", notNull: true },
    weight: { type: "bigint", notNull: true },
    reason: { type: "text" },
    ledger: { type: "int", notNull: true },
    created_at: { type: "timestamp", default: pgm.func("NOW()") },
  });
  pgm.addConstraint("votes", "votes_proposal_voter_unique", "UNIQUE(proposal_id, voter)");

  pgm.createTable("delegates", {
    id: { type: "serial", primaryKey: true },
    delegator: { type: "text", notNull: true },
    old_delegatee: { type: "text", notNull: true },
    new_delegatee: { type: "text", notNull: true },
    ledger: { type: "int", notNull: true },
    created_at: { type: "timestamp", default: pgm.func("NOW()") },
  });

  pgm.createTable("wrapper_deposits", {
    id: { type: "serial", primaryKey: true },
    account: { type: "text", notNull: true },
    amount: { type: "bigint", notNull: true },
    ledger: { type: "int", notNull: true },
    created_at: { type: "timestamptz", default: pgm.func("NOW()") },
  });

  pgm.createTable("wrapper_withdrawals", {
    id: { type: "serial", primaryKey: true },
    account: { type: "text", notNull: true },
    amount: { type: "bigint", notNull: true },
    ledger: { type: "int", notNull: true },
    created_at: { type: "timestamptz", default: pgm.func("NOW()") },
  });

  pgm.createTable("treasury_transfers", {
    id: { type: "serial", primaryKey: true },
    op_hash: { type: "text", notNull: true },
    token: { type: "text", notNull: true },
    recipient_count: { type: "int", notNull: true },
    total_amount: { type: "bigint", notNull: true },
    ledger: { type: "int", notNull: true },
    created_at: { type: "timestamptz", default: pgm.func("NOW()") },
  });

  pgm.createTable("indexer_state", {
    id: { type: "int", primaryKey: true, default: 1 },
    last_ledger: { type: "int", notNull: true, default: 0 },
  });
  pgm.sql(`INSERT INTO indexer_state (id, last_ledger) VALUES (1, 0) ON CONFLICT (id) DO NOTHING`);

  pgm.createTable("config_updates", {
    id: { type: "serial", primaryKey: true },
    ledger: { type: "int", notNull: true },
    new_settings: { type: "jsonb", notNull: true },
    created_at: { type: "timestamptz", default: pgm.func("NOW()") },
  });

  pgm.createTable("governor_upgrades", {
    id: { type: "serial", primaryKey: true },
    ledger: { type: "int", notNull: true },
    new_wasm_hash: { type: "text", notNull: true },
    created_at: { type: "timestamptz", default: pgm.func("NOW()") },
  });

  // Indexes
  pgm.createIndex("proposals", "created_at", { name: "idx_proposals_created_at", order: "DESC" });
  pgm.createIndex("proposals", "proposer", { name: "idx_proposals_proposer" });
  pgm.createIndex("votes", "proposal_id", { name: "idx_votes_proposal_id" });
  pgm.createIndex("votes", "voter", { name: "idx_votes_voter" });
  pgm.createIndex("delegates", "delegator", { name: "idx_delegates_delegator" });
  pgm.createIndex("delegates", "ledger", { name: "idx_delegates_ledger", order: "DESC" });
  pgm.createIndex("delegates", "new_delegatee", { name: "idx_delegates_new_delegatee" });
  pgm.createIndex("wrapper_deposits", "account", { name: "idx_wrapper_deposits_account" });
  pgm.createIndex("wrapper_withdrawals", "account", { name: "idx_wrapper_withdrawals_account" });
  pgm.createIndex("config_updates", "ledger", { name: "idx_config_updates_ledger", order: "DESC" });
  pgm.createIndex("governor_upgrades", "ledger", { name: "idx_governor_upgrades_ledger", order: "DESC" });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("governor_upgrades", { ifExists: true });
  pgm.dropTable("config_updates", { ifExists: true });
  pgm.dropTable("votes", { ifExists: true });
  pgm.dropTable("delegates", { ifExists: true });
  pgm.dropTable("wrapper_deposits", { ifExists: true });
  pgm.dropTable("wrapper_withdrawals", { ifExists: true });
  pgm.dropTable("treasury_transfers", { ifExists: true });
  pgm.dropTable("indexer_state", { ifExists: true });
  pgm.dropTable("proposals", { ifExists: true });
}
