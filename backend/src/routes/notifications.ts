import { Response, Router } from "express";
import { z } from "zod";
import crypto from "crypto";
import pool from "../db/pool";
import { authenticate, AuthRequest } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { logger } from "../logger";
import {
  createRuleSchema,
  rowToRule,
  updateRuleSchema,
  type NotificationRule,
} from "../notifications/rules";
import {
  generateWebhookSecret,
  notificationEngine,
  type StoredNotificationChannel,
} from "../notifications/engine";
import { renderNotification } from "../notifications/templates";

const router = Router();

const idParamSchema = z.object({ id: z.coerce.number().int().min(1) });

const listDeliveriesSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
  status: z.enum(["pending", "delivered", "failed", "retrying"]).optional(),
});

/** Masks generated webhook secrets before a rule is sent back to the client. */
function maskRuleForOutput(rule: NotificationRule) {
  const channels = (rule.channels as unknown as StoredNotificationChannel[]).map((channel) =>
    channel.type === "webhook" ? { type: "webhook" as const, url: channel.url, secret: "***" } : channel,
  );
  return { ...rule, channels };
}

function attachGeneratedSecrets(
  channels: z.infer<typeof createRuleSchema>["channels"],
): StoredNotificationChannel[] {
  return channels.map((channel) =>
    channel.type === "webhook"
      ? { type: "webhook" as const, url: channel.url, secret: generateWebhookSecret() }
      : channel,
  );
}

const PREF_KEYS = [
  "created_self",
  "active",
  "voting_ends_soon",
  "outcome",
  "queued",
  "executed",
] as const;

type PrefKey = (typeof PREF_KEYS)[number];

function defaultPreferences() {
  return {
    created_self: true,
    active: true,
    voting_ends_soon: true,
    outcome: true,
    queued: true,
    executed: true,
  };
}

const preferencesSchema = z.object({
  created_self: z.boolean().optional(),
  active: z.boolean().optional(),
  voting_ends_soon: z.boolean().optional(),
  outcome: z.boolean().optional(),
  queued: z.boolean().optional(),
  executed: z.boolean().optional(),
});

const listNotificationsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
  unread_only: z.enum(["true", "false"]).transform(v => v === "true").optional().default("false" as any),
});

const createNotificationSchema = z.object({
  type: z.string().trim().min(1).max(64),
  proposal_id: z.coerce.number().int().min(0).optional(),
  message: z.string().optional(),
});

const markReadSchema = z.object({
  ids: z.array(z.coerce.number().int()).optional(),
  all: z.boolean().optional(),
});

const webhookSchema = z.object({
  callback_url: z.string().url(),
  event_filter: z.array(z.string().min(1).max(64)).optional().default([]),
});

const VALID_EVENTS = new Set([
  "created_self",
  "active",
  "voting_ends_soon",
  "outcome",
  "queued",
  "executed",
]);

// GET /notifications/preferences - get current preferences (auth required)
router.get("/preferences", authenticate, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const result = await pool.query(
      `SELECT ${PREF_KEYS.join(", ")} FROM notification_preferences WHERE user_id = $1`,
      [userId],
    );
    res.json(result.rows[0] ?? defaultPreferences());
  } catch (error) {
    logger.error({ err: error }, "Error fetching notification preferences");
    res.status(500).json({ error: "Failed to fetch preferences" });
  }
});

// POST /notifications/preferences - save preferences (auth required)
router.post(
  "/preferences",
  authenticate,
  validate({ body: preferencesSchema }),
  async (req: AuthRequest, res) => {

    const userId = req.userId!;
    const next: Record<PrefKey, boolean> = defaultPreferences();
    for (const k of PREF_KEYS) {
      if (typeof req.body[k] === "boolean") next[k] = req.body[k];
    }

    try {
      await pool.query(
        `INSERT INTO notification_preferences (user_id, ${PREF_KEYS.join(", ")})
         VALUES ($1, ${PREF_KEYS.map((_, i) => `$${i + 2}`).join(", ")})
         ON CONFLICT (user_id) DO UPDATE SET
           ${PREF_KEYS.map((k, i) => `${k} = $${i + 2}`).join(", ")}`,
        [userId, ...PREF_KEYS.map((k) => next[k])],
      );

      res.json(next);
    } catch (error) {
      logger.error({ err: error }, "Error saving notification preferences");
      res.status(500).json({ error: "Failed to save preferences" });
    }
  },
);

// GET /notifications - fetch user's notification history (auth required)
router.get(
  "/",
  authenticate,
  validate({ query: listNotificationsSchema }),
  async (req: AuthRequest, res: Response) => {
    const userId = req.userId!;
    const { limit, offset, unread_only: unreadOnly } = req.query as any;

    try {
      const whereUnread = unreadOnly ? "AND read = false" : "";
      const rows = await pool.query(
        `SELECT id, type, proposal_id, message, read, created_at
         FROM notification_history
         WHERE user_id = $1 ${whereUnread}
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset],
      );

      const count = await pool.query(
        `SELECT COUNT(*)::int AS total,
                SUM(CASE WHEN read = false THEN 1 ELSE 0 END)::int AS unread
         FROM notification_history
         WHERE user_id = $1`,
        [userId],
      );

      res.json({
        data: rows.rows,
        meta: {
          total: count.rows[0]?.total ?? 0,
          unread: count.rows[0]?.unread ?? 0,
          limit,
          offset,
        },
      });
    } catch (error) {
      logger.error({ err: error }, "Error fetching notification history");
      res.status(500).json({ error: "Failed to fetch notifications" });
    }
  },
);

// POST /notifications - add a history entry (auth required)
router.post(
  "/",
  authenticate,
  validate({ body: createNotificationSchema }),
  async (req: AuthRequest, res: Response) => {

    const userId = req.userId!;
    const type = (req.body.type as string).trim();
    const proposalId = req.body.proposal_id as number | undefined;
    const message = (req.body.message as string | undefined) ?? null;

    try {
      const inserted = await pool.query(
        `INSERT INTO notification_history (user_id, type, proposal_id, message)
         VALUES ($1, $2, $3, $4)
         RETURNING id, type, proposal_id, message, read, created_at`,
        [userId, type, proposalId ?? null, message],
      );
      res.status(201).json(inserted.rows[0]);
    } catch (error) {
      logger.error({ err: error }, "Error inserting notification");
      res.status(500).json({ error: "Failed to create notification" });
    }
  },
);

// POST /notifications/mark-read - mark notifications as read (auth required)
router.post(
  "/mark-read",
  authenticate,
  validate({ body: markReadSchema }),
  async (req: AuthRequest, res: Response) => {

    const userId = req.userId!;
    const markAll = req.body.all === true;
    const ids = (req.body.ids as number[] | undefined) ?? [];

    try {
      if (markAll) {
        await pool.query(
          "UPDATE notification_history SET read = true WHERE user_id = $1 AND read = false",
          [userId],
        );
      } else if (ids.length > 0) {
        await pool.query(
          "UPDATE notification_history SET read = true WHERE user_id = $1 AND id = ANY($2::int[])",
          [userId, ids],
        );
      }

      const unread = await pool.query(
        "SELECT COUNT(*)::int AS unread FROM notification_history WHERE user_id = $1 AND read = false",
        [userId],
      );
      res.json({ unread: unread.rows[0]?.unread ?? 0 });
    } catch (error) {
      logger.error({ err: error }, "Error marking notifications read");
      res.status(500).json({ error: "Failed to mark read" });
    }
  },
);

// POST /notifications/webhook - register a webhook subscription (auth required)
router.post(
  "/webhook",
  authenticate,
  validate({ body: webhookSchema }),
  async (req: AuthRequest, res: Response) => {
    const userId = req.userId!;
    const { callback_url, event_filter } = req.body as {
      callback_url: string;
      event_filter: string[];
    };

    for (const ev of event_filter) {
      if (!VALID_EVENTS.has(ev)) {
        res.status(400).json({
          error: `Invalid event: ${ev}. Valid events: ${[...VALID_EVENTS].join(", ")}`,
        });
        return;
      }
    }

    try {
      const hmac_secret = crypto.randomBytes(32).toString("hex");

      const inserted = await pool.query(
        `INSERT INTO webhook_subscriptions (user_id, callback_url, hmac_secret, event_filter)
         VALUES ($1, $2, $3, $4)
         RETURNING id, callback_url, event_filter, active, created_at`,
        [userId, callback_url, hmac_secret, event_filter],
      );

      res.status(201).json(inserted.rows[0]);
    } catch (error) {
      logger.error({ err: error }, "Error registering webhook");
      res.status(500).json({ error: "Failed to register webhook" });
    }
  },
);

// POST /notifications/rules - create a notification rule (auth required)
router.post(
  "/rules",
  authenticate,
  validate({ body: createRuleSchema }),
  async (req: AuthRequest, res: Response) => {
    const userId = req.userId!;
    const body = req.body as z.infer<typeof createRuleSchema>;

    try {
      const channels = attachGeneratedSecrets(body.channels);
      const inserted = await pool.query(
        `INSERT INTO notification_rules (user_id, name, trigger_type, trigger_config, channels, enabled, cooldown_seconds)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          userId,
          body.name,
          body.trigger_type,
          JSON.stringify(body.trigger_config),
          JSON.stringify(channels),
          body.enabled,
          body.cooldown_seconds,
        ],
      );

      // Secrets are returned once, at creation time, so the caller can wire up
      // signature verification — every later read masks them.
      res.status(201).json(rowToRule(inserted.rows[0]));
    } catch (error) {
      logger.error({ err: error }, "Error creating notification rule");
      res.status(500).json({ error: "Failed to create rule" });
    }
  },
);

// GET /notifications/rules - list the caller's rules (auth required)
router.get("/rules", authenticate, async (req: AuthRequest, res: Response) => {
  const userId = req.userId!;

  try {
    const result = await pool.query(
      `SELECT * FROM notification_rules WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    );
    res.json(result.rows.map(rowToRule).map(maskRuleForOutput));
  } catch (error) {
    logger.error({ err: error }, "Error listing notification rules");
    res.status(500).json({ error: "Failed to list rules" });
  }
});

// PUT /notifications/rules/:id - update a rule (auth required, owner only)
router.put(
  "/rules/:id",
  authenticate,
  validate({ params: idParamSchema, body: updateRuleSchema }),
  async (req: AuthRequest, res: Response) => {
    const userId = req.userId!;
    const ruleId = (req.params as any).id as number;
    const body = req.body as z.infer<typeof updateRuleSchema>;

    try {
      const existing = await pool.query(
        `SELECT * FROM notification_rules WHERE id = $1 AND user_id = $2`,
        [ruleId, userId],
      );
      if (existing.rowCount === 0) {
        res.status(404).json({ error: "Rule not found" });
        return;
      }

      const current = rowToRule(existing.rows[0]);
      const channels = body.channels ? attachGeneratedSecrets(body.channels) : current.channels;

      const updated = await pool.query(
        `UPDATE notification_rules SET
           name = $3, trigger_type = $4, trigger_config = $5, channels = $6,
           enabled = $7, cooldown_seconds = $8, updated_at = NOW()
         WHERE id = $1 AND user_id = $2
         RETURNING *`,
        [
          ruleId,
          userId,
          body.name ?? current.name,
          body.trigger_type ?? current.trigger_type,
          JSON.stringify(body.trigger_config ?? current.trigger_config),
          JSON.stringify(channels),
          body.enabled ?? current.enabled,
          body.cooldown_seconds ?? current.cooldown_seconds,
        ],
      );

      res.json(maskRuleForOutput(rowToRule(updated.rows[0])));
    } catch (error) {
      logger.error({ err: error }, "Error updating notification rule");
      res.status(500).json({ error: "Failed to update rule" });
    }
  },
);

// DELETE /notifications/rules/:id - delete a rule (auth required, owner only)
router.delete(
  "/rules/:id",
  authenticate,
  validate({ params: idParamSchema }),
  async (req: AuthRequest, res: Response) => {
    const userId = req.userId!;
    const ruleId = (req.params as any).id as number;

    try {
      const result = await pool.query(
        `DELETE FROM notification_rules WHERE id = $1 AND user_id = $2`,
        [ruleId, userId],
      );
      if (result.rowCount === 0) {
        res.status(404).json({ error: "Rule not found" });
        return;
      }
      res.json({ ok: true });
    } catch (error) {
      logger.error({ err: error }, "Error deleting notification rule");
      res.status(500).json({ error: "Failed to delete rule" });
    }
  },
);

// POST /notifications/rules/:id/test - deliver a sample notification through
// all of the rule's channels without waiting for a matching on-chain event.
router.post(
  "/rules/:id/test",
  authenticate,
  validate({ params: idParamSchema }),
  async (req: AuthRequest, res: Response) => {
    const userId = req.userId!;
    const ruleId = (req.params as any).id as number;

    try {
      const result = await pool.query(
        `SELECT * FROM notification_rules WHERE id = $1 AND user_id = $2`,
        [ruleId, userId],
      );
      if (result.rowCount === 0) {
        res.status(404).json({ error: "Rule not found" });
        return;
      }

      const rule = rowToRule(result.rows[0]);
      const sampleEvent = {
        id: 0,
        event_type: "test",
        ledger: 0,
        transaction_hash: null,
        contract_address: "test",
        payload: { topics: ["test", "GTEST"], value: { proposal_id: "0" } },
        indexed_at: new Date().toISOString(),
      };
      const message = renderNotification(rule.trigger_type, sampleEvent);
      message.subject = `[Test] ${message.subject}`;
      message.short = `[Test] ${message.short}`;

      const channels = rule.channels as unknown as StoredNotificationChannel[];
      const results = [];
      for (const channel of channels) {
        results.push(await notificationEngine.deliverNotification(rule, sampleEvent, channel, message));
      }

      res.json({ results });
    } catch (error) {
      logger.error({ err: error }, "Error sending test notification");
      res.status(500).json({ error: "Failed to send test notification" });
    }
  },
);

// GET /notifications/inbox - paginated in-app notifications (auth required)
router.get(
  "/inbox",
  authenticate,
  validate({ query: listNotificationsSchema }),
  async (req: AuthRequest, res: Response) => {
    const userId = req.userId!;
    const { limit, offset, unread_only: unreadOnly } = req.query as any;

    try {
      const whereUnread = unreadOnly ? "AND read = false" : "";
      const rows = await pool.query(
        `SELECT id, rule_id, title, body, action_url, read, created_at
         FROM in_app_notifications
         WHERE user_id = $1 ${whereUnread}
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset],
      );

      const count = await pool.query(
        `SELECT COUNT(*)::int AS total,
                SUM(CASE WHEN read = false THEN 1 ELSE 0 END)::int AS unread
         FROM in_app_notifications
         WHERE user_id = $1`,
        [userId],
      );

      res.json({
        data: rows.rows,
        meta: {
          total: count.rows[0]?.total ?? 0,
          unread: count.rows[0]?.unread ?? 0,
          limit,
          offset,
        },
      });
    } catch (error) {
      logger.error({ err: error }, "Error fetching notification inbox");
      res.status(500).json({ error: "Failed to fetch inbox" });
    }
  },
);

// PUT /notifications/inbox/:id/read - mark a single in-app notification read
router.put(
  "/inbox/:id/read",
  authenticate,
  validate({ params: idParamSchema }),
  async (req: AuthRequest, res: Response) => {
    const userId = req.userId!;
    const id = (req.params as any).id as number;

    try {
      const result = await pool.query(
        `UPDATE in_app_notifications SET read = true WHERE id = $1 AND user_id = $2 RETURNING id`,
        [id, userId],
      );
      if (result.rowCount === 0) {
        res.status(404).json({ error: "Notification not found" });
        return;
      }
      res.json({ ok: true });
    } catch (error) {
      logger.error({ err: error }, "Error marking inbox notification read");
      res.status(500).json({ error: "Failed to mark read" });
    }
  },
);

// PUT /notifications/inbox/read-all - mark all in-app notifications read
router.put("/inbox/read-all", authenticate, async (req: AuthRequest, res: Response) => {
  const userId = req.userId!;

  try {
    await pool.query(
      `UPDATE in_app_notifications SET read = true WHERE user_id = $1 AND read = false`,
      [userId],
    );
    res.json({ ok: true });
  } catch (error) {
    logger.error({ err: error }, "Error marking all inbox notifications read");
    res.status(500).json({ error: "Failed to mark all read" });
  }
});

// GET /notifications/deliveries - delivery history with status (auth required)
router.get(
  "/deliveries",
  authenticate,
  validate({ query: listDeliveriesSchema }),
  async (req: AuthRequest, res: Response) => {
    const userId = req.userId!;
    const { limit, offset, status } = req.query as any;

    try {
      const whereStatus = status ? "AND status = $4" : "";
      const params = status ? [userId, limit, offset, status] : [userId, limit, offset];
      const rows = await pool.query(
        `SELECT id, rule_id, event_type, channel_type, status, attempts,
                last_attempt_at, next_retry_at, delivered_at, error_message, created_at
         FROM notification_deliveries
         WHERE user_id = $1 ${whereStatus}
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        params,
      );
      res.json({ data: rows.rows, meta: { limit, offset } });
    } catch (error) {
      logger.error({ err: error }, "Error fetching delivery history");
      res.status(500).json({ error: "Failed to fetch deliveries" });
    }
  },
);

// GET /notifications/deliveries/:id/retry - force an immediate retry of a failed delivery
router.get(
  "/deliveries/:id/retry",
  authenticate,
  validate({ params: idParamSchema }),
  async (req: AuthRequest, res: Response) => {
    const userId = req.userId!;
    const id = (req.params as any).id as number;

    try {
      const result = await pool.query(
        `SELECT nd.*, nr.channels
         FROM notification_deliveries nd
         JOIN notification_rules nr ON nr.id = nd.rule_id
         WHERE nd.id = $1 AND nd.user_id = $2`,
        [id, userId],
      );
      if (result.rowCount === 0) {
        res.status(404).json({ error: "Delivery not found" });
        return;
      }

      const delivery = result.rows[0];
      if (delivery.status !== "failed" && delivery.status !== "retrying") {
        res.status(400).json({ error: `Cannot retry a delivery with status '${delivery.status}'` });
        return;
      }

      const channels = (delivery.channels ?? []) as StoredNotificationChannel[];
      const channel = channels.find((c) => c.type === delivery.channel_type);
      if (!channel) {
        res.status(410).json({ error: "Delivery channel no longer exists on the rule" });
        return;
      }

      const ruleResult = await pool.query(`SELECT * FROM notification_rules WHERE id = $1`, [
        delivery.rule_id,
      ]);
      const rule = rowToRule(ruleResult.rows[0]);
      const event = {
        id: 0,
        event_type: delivery.event_type,
        ledger: 0,
        transaction_hash: null,
        contract_address: "",
        payload: delivery.event_payload,
        indexed_at: new Date().toISOString(),
      };
      const message = renderNotification(rule.trigger_type, event);
      const outcome = await notificationEngine.attemptDelivery(id, rule, event, channel, message);

      res.json(outcome);
    } catch (error) {
      logger.error({ err: error }, "Error retrying notification delivery");
      res.status(500).json({ error: "Failed to retry delivery" });
    }
  },
);

export default router;
