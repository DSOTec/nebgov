import pool from "../db/pool";
import { logger } from "../logger";
import { notificationEngine } from "../notifications/engine";
import type { IndexerEvent } from "../notifications/rules";

const EVENT_BATCH_SIZE = 200;

/**
 * Reads new rows from the indexer's `event_log` (same physical database,
 * separate migration history — see packages/indexer/migrations) and
 * evaluates every enabled notification rule against them. Runs on its own
 * interval rather than in the indexer process so a slow email/webhook
 * delivery never blocks chain polling.
 */
export class NotificationProcessorService {
  private interval: NodeJS.Timeout | null = null;
  private isProcessing = false;

  start() {
    const intervalMs = Number(process.env.NOTIFICATION_PROCESSOR_INTERVAL_MS ?? "10000");
    logger.info({ intervalMs }, "Starting notification processor");
    this.interval = setInterval(() => this.tick(), intervalMs);
    this.tick();
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async tick() {
    if (this.isProcessing) return;
    this.isProcessing = true;
    try {
      await this.processNewEvents();
      await this.checkProposalTimers();
    } catch (error) {
      logger.error({ err: error }, "Notification processor tick failed");
    } finally {
      this.isProcessing = false;
    }
  }

  private async getCursor(): Promise<number> {
    const result = await pool.query(
      "SELECT last_event_id FROM notification_event_cursor WHERE id = 1",
    );
    return result.rows[0]?.last_event_id ?? 0;
  }

  private async setCursor(lastEventId: number): Promise<void> {
    await pool.query(
      "UPDATE notification_event_cursor SET last_event_id = $1 WHERE id = 1",
      [lastEventId],
    );
  }

  async processNewEvents(): Promise<void> {
    const cursor = await this.getCursor();
    const result = await pool.query(
      `SELECT id, event_type, ledger, transaction_hash, contract_address, payload, indexed_at
       FROM event_log
       WHERE id > $1
       ORDER BY id ASC
       LIMIT $2`,
      [cursor, EVENT_BATCH_SIZE],
    );

    if (result.rowCount === 0) return;

    let maxId = cursor;
    for (const row of result.rows) {
      const event: IndexerEvent = {
        id: row.id,
        event_type: row.event_type,
        ledger: row.ledger,
        transaction_hash: row.transaction_hash,
        contract_address: row.contract_address,
        payload: row.payload,
        indexed_at: row.indexed_at,
      };

      try {
        await notificationEngine.evaluateEvent(event);
      } catch (error) {
        logger.error({ err: error, eventId: row.id }, "Failed to evaluate event for notifications");
      }

      if (row.id > maxId) maxId = row.id;
    }

    await this.setCursor(maxId);
  }

  /**
   * `proposal_ending_soon` isn't a discrete contract event — it's a
   * condition on a proposal's current state — so it's evaluated by
   * periodically scanning open proposals against the indexer's last-seen
   * ledger rather than reacting to `event_log` rows.
   *
   * `proposal_vote_threshold` and `quorum_reached` are intentionally NOT
   * evaluated here: computing "% of quorum reached" needs the total voting
   * supply quorum is measured against, and the indexed schema
   * (proposals/config_updates) has no such snapshot — only per-proposal
   * vote tallies and a raw `quorum_numerator`, whose denominator isn't
   * indexed either. Rather than fabricate a percentage, rules with these
   * two trigger types are accepted and stored (see rules.ts) but never
   * fire, the same scope boundary the analytics module documented for
   * `top_delegate_share_bps`.
   */
  async checkProposalTimers(): Promise<void> {
    const hasSubscribers = await pool.query(
      `SELECT 1 FROM notification_rules
       WHERE enabled = true AND trigger_type = 'proposal_ending_soon'
       LIMIT 1`,
    );
    if (hasSubscribers.rowCount === 0) return;

    const ledgerResult = await pool.query("SELECT last_ledger FROM indexer_state WHERE id = 1");
    const currentLedger: number = ledgerResult.rows[0]?.last_ledger ?? 0;
    if (currentLedger === 0) return;

    const proposals = await pool.query(
      `SELECT id, end_ledger
       FROM proposals
       WHERE executed = false AND cancelled = false AND end_ledger > $1`,
      [currentLedger],
    );

    for (const proposal of proposals.rows) {
      await this.evaluateSynthetic("proposal_ending_soon", proposal.id, {
        proposal_id: String(proposal.id),
        remaining_ledgers: proposal.end_ledger - currentLedger,
      });
    }
  }

  private async evaluateSynthetic(
    eventType: string,
    proposalId: number | string,
    value: Record<string, unknown>,
  ): Promise<void> {
    const event: IndexerEvent = {
      id: 0,
      event_type: eventType,
      ledger: 0,
      transaction_hash: null,
      contract_address: "",
      payload: { topics: ["synthetic", String(proposalId)], value },
      indexed_at: new Date().toISOString(),
    };
    await notificationEngine.evaluateEvent(event);
  }
}

export const notificationProcessor = new NotificationProcessorService();
