import crypto from "crypto";
import pool from "../db/pool";
import { logger } from "../logger";
import {
  EVENT_TYPE_TO_TRIGGER,
  rowToRule,
  STATE_CHANGE_EVENTS,
  TRIGGER_TYPES,
  type IndexerEvent,
  type NotificationRule,
  type TriggerType,
} from "./rules";
import { renderNotification, type NotificationMessage } from "./templates";

const WEBHOOK_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 5;
const BASE_RETRY_DELAY_MS = 30_000;

export interface DeliveryResult {
  ruleId: number;
  channelType: string;
  status: "delivered" | "failed";
  error?: string;
}

export interface StoredWebhookChannel {
  type: "webhook";
  url: string;
  secret: string;
}

export type StoredNotificationChannel =
  | { type: "in_app" }
  | { type: "email"; address: string }
  | StoredWebhookChannel
  | { type: "telegram"; chat_id: string };

function resolveTriggerTypes(event: IndexerEvent): TriggerType[] {
  if (event.event_type in STATE_CHANGE_EVENTS) return ["proposal_state_changed"];
  if ((TRIGGER_TYPES as readonly string[]).includes(event.event_type)) {
    return [event.event_type as TriggerType];
  }
  return EVENT_TYPE_TO_TRIGGER[event.event_type] ?? [];
}

function eventProposalId(event: IndexerEvent): string | undefined {
  const value = event.payload.value;
  if (value && typeof value === "object" && "proposal_id" in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>).proposal_id);
  }
  if (Array.isArray(value) && value.length > 0) return String(value[0]);
  const topics = event.payload.topics ?? [];
  return topics[1] !== undefined ? String(topics[1]) : undefined;
}

function eventVoter(event: IndexerEvent): string | undefined {
  const topics = event.payload.topics ?? [];
  return topics[1] !== undefined ? String(topics[1]) : undefined;
}

function eventProposer(event: IndexerEvent): string | undefined {
  const value = event.payload.value;
  if (value && typeof value === "object" && "proposer" in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>).proposer);
  }
  const topics = event.payload.topics ?? [];
  return topics[1] !== undefined ? String(topics[1]) : undefined;
}

function eventDelegatee(event: IndexerEvent): string | undefined {
  const value = event.payload.value;
  return Array.isArray(value) && value.length > 0 ? String(value[0]) : undefined;
}

/**
 * Returns true if `rule`'s optional trigger_config filters (proposer, voter,
 * to_state, delegatee, proposal_id) all match the concrete event. Filters
 * left unset on the rule match anything — they narrow, they never widen.
 */
export function ruleMatchesEvent(rule: NotificationRule, event: IndexerEvent): boolean {
  const cfg = rule.trigger_config;

  switch (rule.trigger_type) {
    case "proposal_state_changed": {
      const toState = STATE_CHANGE_EVENTS[event.event_type];
      if (cfg.to_state && cfg.to_state !== toState) return false;
      return true;
    }
    case "proposal_created": {
      if (cfg.proposer && cfg.proposer !== eventProposer(event)) return false;
      return true;
    }
    case "vote_cast": {
      if (cfg.proposal_id !== undefined && String(cfg.proposal_id) !== eventProposalId(event)) {
        return false;
      }
      if (cfg.voter && cfg.voter !== eventVoter(event)) return false;
      return true;
    }
    case "delegation_received":
    case "delegation_lost": {
      if (cfg.delegatee && cfg.delegatee !== eventDelegatee(event)) return false;
      return true;
    }
    case "proposal_ending_soon": {
      const value = event.payload.value as Record<string, unknown>;
      const remaining = Number(value.remaining_ledgers);
      if (cfg.proposal_id !== undefined && String(cfg.proposal_id) !== String(value.proposal_id)) {
        return false;
      }
      return remaining <= (cfg.ledgers_remaining ?? 500);
    }
    case "proposal_vote_threshold": {
      const value = event.payload.value as Record<string, unknown>;
      const currentBps = Number(value.current_bps);
      if (cfg.proposal_id !== undefined && String(cfg.proposal_id) !== String(value.proposal_id)) {
        return false;
      }
      return currentBps >= (cfg.threshold_bps ?? 8000);
    }
    case "quorum_reached": {
      const value = event.payload.value as Record<string, unknown>;
      if (cfg.proposal_id !== undefined && String(cfg.proposal_id) !== String(value.proposal_id)) {
        return false;
      }
      return true;
    }
    default:
      return true;
  }
}

function isInCooldown(rule: NotificationRule): boolean {
  if (!rule.last_triggered_at) return false;
  const elapsedMs = Date.now() - new Date(rule.last_triggered_at).getTime();
  return elapsedMs < rule.cooldown_seconds * 1000;
}

function computeHmac(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

export class NotificationEngine {
  async matchRules(event: IndexerEvent): Promise<NotificationRule[]> {
    const triggerTypes = resolveTriggerTypes(event);
    if (triggerTypes.length === 0) return [];

    const result = await pool.query(
      `SELECT id, user_id, name, trigger_type, trigger_config, channels, enabled,
              cooldown_seconds, last_triggered_at, trigger_count, created_at, updated_at
       FROM notification_rules
       WHERE enabled = true AND trigger_type = ANY($1::text[])`,
      [triggerTypes],
    );

    return result.rows.map(rowToRule).filter((rule) => ruleMatchesEvent(rule, event));
  }

  async evaluateEvent(event: IndexerEvent): Promise<DeliveryResult[]> {
    const rules = await this.matchRules(event);
    const results: DeliveryResult[] = [];

    for (const rule of rules) {
      if (isInCooldown(rule)) continue;

      const message = renderNotification(rule.trigger_type, event);
      const channels = (rule.channels as unknown as StoredNotificationChannel[]) ?? [];

      for (const channel of channels) {
        results.push(await this.deliverNotification(rule, event, channel, message));
      }

      await pool.query(
        `UPDATE notification_rules
         SET last_triggered_at = NOW(), trigger_count = trigger_count + 1
         WHERE id = $1`,
        [rule.id],
      );
    }

    return results;
  }

  async deliverNotification(
    rule: NotificationRule,
    event: IndexerEvent,
    channel: StoredNotificationChannel,
    message: NotificationMessage,
  ): Promise<DeliveryResult> {
    const deliveryId = await this.recordDelivery(rule, event, channel.type);
    return this.attemptDelivery(deliveryId, rule, event, channel, message);
  }

  // Reuses an existing delivery row so the manual retry endpoint updates it in place instead of inserting a duplicate.
  async attemptDelivery(
    deliveryId: number,
    rule: NotificationRule,
    event: IndexerEvent,
    channel: StoredNotificationChannel,
    message: NotificationMessage,
  ): Promise<DeliveryResult> {
    try {
      switch (channel.type) {
        case "in_app":
          await this.deliverInApp(rule, message);
          break;
        case "email":
          await this.deliverEmail(channel, message);
          break;
        case "webhook":
          await this.deliverWebhook(channel, event, message);
          break;
        case "telegram":
          await this.deliverTelegram(channel, message);
          break;
      }

      await pool.query(
        `UPDATE notification_deliveries
         SET status = 'delivered', delivered_at = NOW(), attempts = attempts + 1, last_attempt_at = NOW()
         WHERE id = $1`,
        [deliveryId],
      );
      return { ruleId: rule.id, channelType: channel.type, status: "delivered" };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      await this.enqueueRetry(deliveryId, errorMessage);
      logger.warn(
        { ruleId: rule.id, channelType: channel.type, err: errorMessage },
        "Notification delivery failed",
      );
      return { ruleId: rule.id, channelType: channel.type, status: "failed", error: errorMessage };
    }
  }

  private async recordDelivery(
    rule: NotificationRule,
    event: IndexerEvent,
    channelType: string,
  ): Promise<number> {
    const result = await pool.query(
      `INSERT INTO notification_deliveries (rule_id, user_id, event_type, event_payload, channel_type, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING id`,
      [rule.id, rule.user_id, event.event_type, JSON.stringify(event.payload), channelType],
    );
    return result.rows[0].id;
  }

  async enqueueRetry(deliveryId: number, errorMessage: string): Promise<void> {
    const result = await pool.query(
      `UPDATE notification_deliveries
       SET attempts = attempts + 1, last_attempt_at = NOW(), error_message = $2,
           status = CASE WHEN attempts + 1 >= $3 THEN 'failed' ELSE 'retrying' END,
           next_retry_at = CASE
             WHEN attempts + 1 >= $3 THEN NULL
             ELSE NOW() + (($4::bigint * POWER(2, attempts)) || ' milliseconds')::interval
           END
       WHERE id = $1
       RETURNING status`,
      [deliveryId, errorMessage, MAX_RETRIES, BASE_RETRY_DELAY_MS],
    );

    if (result.rows[0]?.status === "failed") {
      logger.error({ deliveryId, errorMessage }, "Notification delivery permanently failed");
    }
  }

  async deliverInApp(rule: NotificationRule, message: NotificationMessage): Promise<void> {
    await pool.query(
      `INSERT INTO in_app_notifications (user_id, rule_id, title, body, action_url)
       VALUES ($1, $2, $3, $4, $5)`,
      [rule.user_id, rule.id, message.subject, message.body, message.actionUrl ?? null],
    );
  }

  async deliverEmail(
    channel: { type: "email"; address: string },
    message: NotificationMessage,
  ): Promise<void> {
    const apiUrl = process.env.EMAIL_PROVIDER_API_URL;
    const apiKey = process.env.EMAIL_PROVIDER_API_KEY;
    const fromAddress = process.env.EMAIL_FROM_ADDRESS ?? "notifications@nebgov.dev";

    if (!apiUrl || !apiKey) {
      throw new Error("Email provider not configured (EMAIL_PROVIDER_API_URL / EMAIL_PROVIDER_API_KEY)");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          from: fromAddress,
          to: channel.address,
          subject: message.subject,
          text: message.body,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Email provider returned HTTP ${response.status}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async deliverWebhook(
    channel: StoredWebhookChannel,
    event: IndexerEvent,
    message: NotificationMessage,
  ): Promise<void> {
    const body = JSON.stringify({
      event: event.event_type,
      message,
      timestamp: new Date().toISOString(),
    });
    const signature = computeHmac(body, channel.secret);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    try {
      const response = await fetch(channel.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Notification-Signature": signature,
          "X-Notification-Event": event.event_type,
        },
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Webhook endpoint returned HTTP ${response.status}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async deliverTelegram(
    channel: { type: "telegram"; chat_id: string },
    message: NotificationMessage,
  ): Promise<void> {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      throw new Error("Telegram bot not configured (TELEGRAM_BOT_TOKEN)");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    try {
      const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: channel.chat_id, text: message.short }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Telegram API returned HTTP ${response.status}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

export const notificationEngine = new NotificationEngine();

export function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString("hex");
}
