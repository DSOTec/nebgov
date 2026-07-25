import pool from "../db/pool";
import { logger } from "../logger";
import { notificationEngine, type StoredNotificationChannel } from "../notifications/engine";
import { renderNotification } from "../notifications/templates";
import { rowToRule, type IndexerEvent } from "../notifications/rules";

const RETRY_BATCH_SIZE = 50;

/** Redelivers `notification_deliveries` rows past their exponential-backoff `next_retry_at`. */
export class DeliveryRetryService {
  private interval: NodeJS.Timeout | null = null;
  private isProcessing = false;

  start() {
    const intervalMs = Number(process.env.DELIVERY_RETRY_INTERVAL_MS ?? "15000");
    logger.info({ intervalMs }, "Starting delivery retry job");
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
      await this.processDueRetries();
    } catch (error) {
      logger.error({ err: error }, "Delivery retry tick failed");
    } finally {
      this.isProcessing = false;
    }
  }

  async processDueRetries(): Promise<void> {
    const due = await pool.query(
      `SELECT nd.*, nr.channels, nr.trigger_type, nr.user_id AS rule_user_id,
              nr.trigger_config, nr.cooldown_seconds, nr.enabled, nr.name,
              nr.last_triggered_at, nr.trigger_count, nr.created_at AS rule_created_at,
              nr.updated_at AS rule_updated_at
       FROM notification_deliveries nd
       JOIN notification_rules nr ON nr.id = nd.rule_id
       WHERE nd.status = 'retrying' AND nd.next_retry_at IS NOT NULL AND nd.next_retry_at <= NOW()
       ORDER BY nd.next_retry_at ASC
       LIMIT $1`,
      [RETRY_BATCH_SIZE],
    );

    for (const row of due.rows) {
      const channels = (row.channels ?? []) as StoredNotificationChannel[];
      const channel = channels.find((c) => c.type === row.channel_type);
      if (!channel) {
        // The rule was edited to drop this channel — nothing left to retry against.
        await pool.query(
          `UPDATE notification_deliveries SET status = 'failed', next_retry_at = NULL WHERE id = $1`,
          [row.id],
        );
        continue;
      }

      const rule = rowToRule({
        id: row.rule_id,
        user_id: row.rule_user_id,
        name: row.name,
        trigger_type: row.trigger_type,
        trigger_config: row.trigger_config,
        channels: row.channels,
        enabled: row.enabled,
        cooldown_seconds: row.cooldown_seconds,
        last_triggered_at: row.last_triggered_at,
        trigger_count: row.trigger_count,
        created_at: row.rule_created_at,
        updated_at: row.rule_updated_at,
      });

      const event: IndexerEvent = {
        id: 0,
        event_type: row.event_type,
        ledger: 0,
        transaction_hash: null,
        contract_address: "",
        payload: row.event_payload,
        indexed_at: new Date().toISOString(),
      };

      const message = renderNotification(rule.trigger_type, event);
      await notificationEngine.attemptDelivery(row.id, rule, event, channel, message);
    }
  }
}

export const deliveryRetry = new DeliveryRetryService();
