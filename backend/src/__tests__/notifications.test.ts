import request from "supertest";
import app from "../index";
import pool from "../db/pool";
import jwt from "jsonwebtoken";

describe("Notification Endpoints", () => {
  let authToken: string;
  let userId: number;

  beforeAll(async () => {
    const userResult = await pool.query(
      "INSERT INTO users (wallet_address) VALUES ($1) RETURNING id",
      ["GTESTNOTIFY123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"],
    );
    userId = userResult.rows[0].id;
    authToken = jwt.sign(
      { userId, walletAddress: "GTESTNOTIFY123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ" },
      process.env.JWT_SECRET!,
    );
  });

  afterAll(async () => {
    await pool.query("DELETE FROM notification_history WHERE user_id = $1", [
      userId,
    ]);
    await pool.query("DELETE FROM notification_preferences WHERE user_id = $1", [
      userId,
    ]);
    await pool.query("DELETE FROM users WHERE id = $1", [userId]);
  });

  it("GET /notifications/preferences returns defaults when missing", async () => {
    const res = await request(app)
      .get("/notifications/preferences")
      .set("Authorization", `Bearer ${authToken}`)
      .expect(200);

    expect(res.body).toHaveProperty("created_self", true);
    expect(res.body).toHaveProperty("active", true);
  });

  it("POST /notifications/preferences upserts preferences", async () => {
    const res = await request(app)
      .post("/notifications/preferences")
      .set("Authorization", `Bearer ${authToken}`)
      .send({ active: false, executed: true })
      .expect(200);

    expect(res.body.active).toBe(false);

    const res2 = await request(app)
      .get("/notifications/preferences")
      .set("Authorization", `Bearer ${authToken}`)
      .expect(200);

    expect(res2.body.active).toBe(false);
    expect(res2.body.executed).toBe(true);
  });

  it("POST /notifications creates a history entry, GET returns it", async () => {
    const created = await request(app)
      .post("/notifications")
      .set("Authorization", `Bearer ${authToken}`)
      .send({
        type: "active",
        proposal_id: 123,
        message: "Proposal is active",
      })
      .expect(201);

    expect(created.body).toHaveProperty("id");
    expect(created.body.read).toBe(false);

    const res = await request(app)
      .get("/notifications?limit=50&offset=0")
      .set("Authorization", `Bearer ${authToken}`)
      .expect(200);

    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.meta).toHaveProperty("unread");
    expect(res.body.meta.unread).toBeGreaterThanOrEqual(1);
  });

  it("POST /notifications/mark-read marks all as read", async () => {
    await request(app)
      .post("/notifications")
      .set("Authorization", `Bearer ${authToken}`)
      .send({ type: "queued", proposal_id: 124, message: "Queued" })
      .expect(201);

    const marked = await request(app)
      .post("/notifications/mark-read")
      .set("Authorization", `Bearer ${authToken}`)
      .send({ all: true })
      .expect(200);

    expect(marked.body.unread).toBe(0);
  });

  it("requires authentication", async () => {
    await request(app).get("/notifications").expect(401);
    await request(app).get("/notifications/preferences").expect(401);
    await request(app).post("/notifications/preferences").send({}).expect(401);
  });

  describe("Webhook Endpoints", () => {
    it("POST /notifications/webhook creates a subscription", async () => {
      const res = await request(app)
        .post("/notifications/webhook")
        .set("Authorization", `Bearer ${authToken}`)
        .send({
          callback_url: "https://example.com/webhook",
          event_filter: ["queued", "executed"],
        })
        .expect(201);

      expect(res.body).toHaveProperty("id");
      expect(res.body.callback_url).toBe("https://example.com/webhook");
      expect(res.body.event_filter).toEqual(["queued", "executed"]);
      expect(res.body.active).toBe(true);
    });

    it("POST /notifications/webhook rejects invalid event filter", async () => {
      await request(app)
        .post("/notifications/webhook")
        .set("Authorization", `Bearer ${authToken}`)
        .send({
          callback_url: "https://example.com/webhook",
          event_filter: ["invalid_event"],
        })
        .expect(400);
    });

    it("POST /notifications/webhook requires auth", async () => {
      await request(app)
        .post("/notifications/webhook")
        .send({ callback_url: "https://example.com/webhook" })
        .expect(401);
    });

    afterAll(async () => {
      await pool.query(
        "DELETE FROM webhook_subscriptions WHERE user_id = $1",
        [userId],
      );
    });
  });

  describe("Notification Rules Endpoints", () => {
    let ruleId: number;

    it("POST /notifications/rules creates a rule", async () => {
      const res = await request(app)
        .post("/notifications/rules")
        .set("Authorization", `Bearer ${authToken}`)
        .send({
          name: "Notify me on new proposals",
          trigger_type: "proposal_created",
          channels: [{ type: "in_app" }],
        })
        .expect(201);

      expect(res.body).toHaveProperty("id");
      expect(res.body.trigger_type).toBe("proposal_created");
      expect(res.body.enabled).toBe(true);
      expect(res.body.cooldown_seconds).toBe(300);
      ruleId = res.body.id;
    });

    it("rejects a rule with no channels", async () => {
      await request(app)
        .post("/notifications/rules")
        .set("Authorization", `Bearer ${authToken}`)
        .send({ name: "No channels", trigger_type: "proposal_created", channels: [] })
        .expect(400);
    });

    it("GET /notifications/rules lists the caller's rules", async () => {
      const res = await request(app)
        .get("/notifications/rules")
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.some((r: { id: number }) => r.id === ruleId)).toBe(true);
    });

    it("masks a webhook channel's secret after creation but not on create response", async () => {
      const created = await request(app)
        .post("/notifications/rules")
        .set("Authorization", `Bearer ${authToken}`)
        .send({
          name: "Webhook rule",
          trigger_type: "vote_cast",
          channels: [{ type: "webhook", url: "https://example.com/hook" }],
        })
        .expect(201);

      const webhookChannel = created.body.channels.find((c: { type: string }) => c.type === "webhook");
      expect(webhookChannel.secret).toBeDefined();
      expect(webhookChannel.secret).not.toBe("***");

      const list = await request(app)
        .get("/notifications/rules")
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      const listed = list.body.find((r: { id: number }) => r.id === created.body.id);
      const listedChannel = listed.channels.find((c: { type: string }) => c.type === "webhook");
      expect(listedChannel.secret).toBe("***");

      await pool.query("DELETE FROM notification_rules WHERE id = $1", [created.body.id]);
    });

    it("PUT /notifications/rules/:id updates a rule owned by the caller", async () => {
      const res = await request(app)
        .put(`/notifications/rules/${ruleId}`)
        .set("Authorization", `Bearer ${authToken}`)
        .send({ enabled: false })
        .expect(200);

      expect(res.body.enabled).toBe(false);
    });

    it("PUT /notifications/rules/:id returns 404 for another user's rule", async () => {
      await request(app)
        .put("/notifications/rules/999999")
        .set("Authorization", `Bearer ${authToken}`)
        .send({ enabled: true })
        .expect(404);
    });

    it("POST /notifications/rules/:id/test delivers to in_app and appears in the inbox", async () => {
      await request(app)
        .post(`/notifications/rules/${ruleId}/test`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      const inbox = await request(app)
        .get("/notifications/inbox")
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      expect(inbox.body.data.length).toBeGreaterThan(0);
      expect(inbox.body.data[0].title).toMatch(/^\[Test\]/);
    });

    it("PUT /notifications/inbox/:id/read marks a single notification read", async () => {
      const inbox = await request(app)
        .get("/notifications/inbox?unread_only=true")
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      const notificationId = inbox.body.data[0].id;
      await request(app)
        .put(`/notifications/inbox/${notificationId}/read`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      const after = await request(app)
        .get("/notifications/inbox?unread_only=true")
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      expect(after.body.data.some((n: { id: number }) => n.id === notificationId)).toBe(false);
    });

    it("PUT /notifications/inbox/read-all clears unread count", async () => {
      await request(app)
        .put("/notifications/inbox/read-all")
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      const inbox = await request(app)
        .get("/notifications/inbox")
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      expect(inbox.body.meta.unread).toBe(0);
    });

    it("GET /notifications/deliveries returns delivery history", async () => {
      const res = await request(app)
        .get("/notifications/deliveries")
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.some((d: { rule_id: number }) => d.rule_id === ruleId)).toBe(true);
    });

    it("DELETE /notifications/rules/:id removes the rule", async () => {
      await request(app)
        .delete(`/notifications/rules/${ruleId}`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      const list = await request(app)
        .get("/notifications/rules")
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      expect(list.body.some((r: { id: number }) => r.id === ruleId)).toBe(false);
    });

    it("requires authentication on rules and inbox endpoints", async () => {
      await request(app).get("/notifications/rules").expect(401);
      await request(app).post("/notifications/rules").send({}).expect(401);
      await request(app).get("/notifications/inbox").expect(401);
      await request(app).get("/notifications/deliveries").expect(401);
    });
  });
});

