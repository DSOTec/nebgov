process.env.ADMIN_SECRET = process.env.ADMIN_SECRET ?? "test-admin-secret";

import request from "supertest";
import app from "../index";
import pool from "../db/pool";

describe("Governance Tuning Endpoints", () => {
  let insertedIds: number[] = [];

  afterAll(async () => {
    if (insertedIds.length > 0) {
      await pool.query(
        "DELETE FROM governance_tuning_recommendations WHERE id = ANY($1)",
        [insertedIds],
      );
    }
    // Restore the config row to its migration-seeded defaults so this test
    // file doesn't leak state into other test files sharing the same DB.
    await pool.query(
      `UPDATE governance_tuning_config SET
         min_quorum_numerator = 100, max_quorum_numerator = 5000,
         max_quorum_delta_bps = 200, min_proposal_threshold = 0,
         max_proposal_threshold = NULL, max_threshold_delta_bps = 1000,
         trailing_window = 10, interval_ms = 3600000, auto_propose = FALSE
       WHERE id = 1`,
    );
  });

  describe("GET /governance-tuning/config", () => {
    it("returns the singleton config row seeded by migration 009", async () => {
      const response = await request(app).get("/governance-tuning/config").expect(200);

      expect(response.body).toHaveProperty("min_quorum_numerator");
      expect(response.body).toHaveProperty("max_quorum_numerator");
      expect(response.body).toHaveProperty("auto_propose", false);
      expect(typeof response.body.min_proposal_threshold).toBe("string");
    });
  });

  describe("PUT /governance-tuning/config", () => {
    it("rejects requests without an admin secret", async () => {
      const response = await request(app)
        .put("/governance-tuning/config")
        .send({ max_quorum_delta_bps: 300 })
        .expect(403);

      expect(response.body).toHaveProperty("error");
    });

    it("rejects an empty patch body", async () => {
      const response = await request(app)
        .put("/governance-tuning/config")
        .set("X-ADMIN-SECRET", process.env.ADMIN_SECRET!)
        .send({})
        .expect(400);

      expect(response.body).toHaveProperty("errors");
    });

    it("updates only the fields provided, leaving the rest unchanged", async () => {
      const before = await request(app).get("/governance-tuning/config").expect(200);

      const response = await request(app)
        .put("/governance-tuning/config")
        .set("X-ADMIN-SECRET", process.env.ADMIN_SECRET!)
        .send({ max_quorum_delta_bps: 321, auto_propose: true })
        .expect(200);

      expect(response.body.max_quorum_delta_bps).toBe(321);
      expect(response.body.auto_propose).toBe(true);
      expect(response.body.max_quorum_numerator).toBe(before.body.max_quorum_numerator);
    });

    it("rejects a patch that sets min_quorum_numerator above max_quorum_numerator", async () => {
      const response = await request(app)
        .put("/governance-tuning/config")
        .set("X-ADMIN-SECRET", process.env.ADMIN_SECRET!)
        .send({ min_quorum_numerator: 9000, max_quorum_numerator: 100 })
        .expect(400);

      expect(response.body.error).toMatch(/min_quorum_numerator/);
    });

    it("rejects a one-sided patch that violates the other side's existing value", async () => {
      // Default config has min_quorum_numerator=100 — lowering max below that
      // must be rejected even though the patch never touches the min field.
      const response = await request(app)
        .put("/governance-tuning/config")
        .set("X-ADMIN-SECRET", process.env.ADMIN_SECRET!)
        .send({ max_quorum_numerator: 50 })
        .expect(400);

      expect(response.body.error).toMatch(/min_quorum_numerator/);
    });

    it("rejects a patch that sets min_proposal_threshold above max_proposal_threshold", async () => {
      const response = await request(app)
        .put("/governance-tuning/config")
        .set("X-ADMIN-SECRET", process.env.ADMIN_SECRET!)
        .send({ min_proposal_threshold: "1000", max_proposal_threshold: "500" })
        .expect(400);

      expect(response.body.error).toMatch(/min_proposal_threshold/);
    });

    it("allows min_proposal_threshold above a null (unbounded) max_proposal_threshold", async () => {
      const response = await request(app)
        .put("/governance-tuning/config")
        .set("X-ADMIN-SECRET", process.env.ADMIN_SECRET!)
        .send({ min_proposal_threshold: "1000000000" })
        .expect(200);

      expect(response.body.min_proposal_threshold).toBe("1000000000");
    });
  });

  describe("GET /governance-tuning/recommendations", () => {
    beforeAll(async () => {
      for (let i = 0; i < 3; i++) {
        const result = await pool.query(
          `INSERT INTO governance_tuning_recommendations
             (current_quorum_numerator, recommended_quorum_numerator,
              current_proposal_threshold, recommended_proposal_threshold, rationale)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [1000, 1000 + i, "1000000", "1000000", JSON.stringify({ note: `test-${i}` })],
        );
        insertedIds.push(result.rows[0].id);
      }
    });

    it("returns paginated recommendations, newest first", async () => {
      const response = await request(app)
        .get("/governance-tuning/recommendations?limit=2&offset=0")
        .expect(200);

      expect(response.body).toHaveProperty("data");
      expect(response.body).toHaveProperty("pagination");
      expect(response.body.data.length).toBe(2);
      expect(response.body.pagination.hasMore).toBe(true);
      expect(response.body.data[0].id).toBeGreaterThan(response.body.data[1].id);
    });

    it("clamps limit to the documented max", async () => {
      const response = await request(app)
        .get("/governance-tuning/recommendations?limit=500")
        .expect(400);

      expect(response.body).toHaveProperty("errors");
    });

    it("serializes bigint fields as strings", async () => {
      const response = await request(app)
        .get("/governance-tuning/recommendations?limit=1")
        .expect(200);

      expect(typeof response.body.data[0].current_proposal_threshold).toBe("string");
      expect(typeof response.body.data[0].recommended_proposal_threshold).toBe("string");
    });
  });

  describe("GET /governance-tuning/recommendations/latest", () => {
    it("returns the most recently computed recommendation", async () => {
      const response = await request(app)
        .get("/governance-tuning/recommendations/latest")
        .expect(200);

      expect(response.body).not.toBeNull();
      expect(response.body.id).toBe(insertedIds[insertedIds.length - 1]);
    });
  });
});
