import type { PoolClient } from "pg";
import { pool } from "./db";
import {
  getAllStreamSpends,
  getAllTreasuryStreams,
  type TreasuryStateReader,
  type TreasuryStreamRecord,
  type TreasuryStreamSpendRecord,
} from "./treasuryReader";

interface Queryable {
  query: PoolClient["query"];
}

export interface TreasuryStreamEventRecord {
  eventId: string;
  eventType: string;
  streamId: string;
  name?: string;
  owner?: string;
  recipient?: string;
  amount?: string;
  totalAmount?: string;
  recipientCount?: number;
  caller?: string;
  unspentReturned?: string;
  oldEndLedger?: number;
  newEndLedger?: number;
  additionalAmount?: string;
  newTotalAmount?: string;
  unspent?: string;
  ledger: number;
  transactionHash?: string;
  payload: string;
}

async function upsertStream(
  db: Queryable,
  stream: TreasuryStreamRecord,
  ledger: number,
): Promise<void> {
  await db.query(
    `INSERT INTO treasury_streams (
       stream_id, name, owner, token, total_allocated, total_spent,
       start_ledger, end_ledger, is_active, is_revoked, revoked_at_ledger,
       max_single_spend, cooldown_ledgers, last_spend_ledger, spend_count,
       created_by_proposal_id, updated_at_ledger
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
       $15, $16, $17
     )
     ON CONFLICT (stream_id) DO UPDATE SET
       name = EXCLUDED.name,
       owner = EXCLUDED.owner,
       token = EXCLUDED.token,
       total_allocated = EXCLUDED.total_allocated,
       total_spent = EXCLUDED.total_spent,
       start_ledger = EXCLUDED.start_ledger,
       end_ledger = EXCLUDED.end_ledger,
       is_active = EXCLUDED.is_active,
       is_revoked = EXCLUDED.is_revoked,
       revoked_at_ledger = EXCLUDED.revoked_at_ledger,
       max_single_spend = EXCLUDED.max_single_spend,
       cooldown_ledgers = EXCLUDED.cooldown_ledgers,
       last_spend_ledger = EXCLUDED.last_spend_ledger,
       spend_count = EXCLUDED.spend_count,
       created_by_proposal_id = EXCLUDED.created_by_proposal_id,
       updated_at_ledger = GREATEST(treasury_streams.updated_at_ledger, EXCLUDED.updated_at_ledger),
       updated_at = NOW()`,
    [
      stream.streamId,
      stream.name,
      stream.owner,
      stream.token,
      stream.totalAllocated,
      stream.totalSpent,
      stream.startLedger,
      stream.endLedger,
      stream.isActive,
      stream.isRevoked,
      stream.revokedAtLedger,
      stream.maxSingleSpend,
      stream.cooldownLedgers,
      stream.lastSpendLedger,
      stream.spendCount,
      stream.createdByProposalId,
      ledger,
    ],
  );
}

async function upsertSpend(
  db: Queryable,
  spend: TreasuryStreamSpendRecord,
): Promise<void> {
  await db.query(
    `INSERT INTO treasury_stream_spends (
       stream_id, spend_index, recipient, amount, memo,
       executed_at_ledger, executed_by
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (stream_id, spend_index) DO UPDATE SET
       recipient = EXCLUDED.recipient,
       amount = EXCLUDED.amount,
       memo = EXCLUDED.memo,
       executed_at_ledger = EXCLUDED.executed_at_ledger,
       executed_by = EXCLUDED.executed_by`,
    [
      spend.streamId,
      spend.spendIndex,
      spend.recipient,
      spend.amount,
      spend.memo,
      spend.executedAtLedger,
      spend.executedBy,
    ],
  );
}

export async function treasuryStreamEventExists(
  eventId: string,
): Promise<boolean> {
  const result = await pool.query(
    "SELECT 1 FROM treasury_stream_events WHERE event_id = $1",
    [eventId],
  );
  return result.rows.length > 0;
}

export async function persistTreasuryStreamEvent(options: {
  event: TreasuryStreamEventRecord;
  stream: TreasuryStreamRecord;
  spends: TreasuryStreamSpendRecord[];
}): Promise<boolean> {
  const { event, stream, spends } = options;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      `INSERT INTO treasury_stream_events (
         event_id, event_type, stream_id, name, owner, recipient, amount,
         total_amount, recipient_count, caller, unspent_returned,
         old_end_ledger, new_end_ledger, additional_amount, new_total_amount,
         unspent, ledger, transaction_hash, payload
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
         $15, $16, $17, $18, $19
       )
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [
        event.eventId,
        event.eventType,
        event.streamId,
        event.name ?? null,
        event.owner ?? null,
        event.recipient ?? null,
        event.amount ?? null,
        event.totalAmount ?? null,
        event.recipientCount ?? null,
        event.caller ?? null,
        event.unspentReturned ?? null,
        event.oldEndLedger ?? null,
        event.newEndLedger ?? null,
        event.additionalAmount ?? null,
        event.newTotalAmount ?? null,
        event.unspent ?? null,
        event.ledger,
        event.transactionHash ?? null,
        event.payload,
      ],
    );
    if (inserted.rows.length === 0) {
      await client.query("COMMIT");
      return false;
    }

    await upsertStream(client, stream, event.ledger);
    for (const spend of spends) {
      await upsertSpend(client, spend);
    }
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function bootstrapTreasuryProjection(
  reader: TreasuryStateReader,
  ledger: number,
): Promise<{ streams: number; spends: number }> {
  const streams = await getAllTreasuryStreams(reader);
  let spendCount = 0;
  for (const stream of streams) {
    await upsertStream(pool, stream, ledger);
    const spends = await getAllStreamSpends(reader, stream);
    for (const spend of spends) {
      await upsertSpend(pool, spend);
    }
    spendCount += spends.length;
  }
  return { streams: streams.length, spends: spendCount };
}
