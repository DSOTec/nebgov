import request from "supertest";
import app from "../index";
import pool from "../db/pool";
import jwt from "jsonwebtoken";
import crypto from "crypto";

describe("Auth Routes", () => {
  const testWallet = "GTEST123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";

  beforeEach(async () => {
    // Clean up test data
    await pool.query("DELETE FROM refresh_tokens");
    await pool.query("DELETE FROM users WHERE wallet_address = $1", [
      testWallet,
    ]);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM refresh_tokens");
    await pool.query("DELETE FROM users WHERE wallet_address = $1", [
      testWallet,
    ]);
    await pool.end();
  });

  describe("POST /auth/login", () => {
    it("should create a new user and return access token with refresh cookie", async () => {
      const response = await request(app)
        .post("/auth/login")
        .send({ wallet_address: testWallet })
        .expect(200);

      expect(response.body).toHaveProperty("accessToken");
      expect(response.body).toHaveProperty("user_id");
      expect(response.body.wallet_address).toBe(testWallet);

      // Check refresh token cookie is set
      const cookies = response.headers["set-cookie"];
      expect(cookies).toBeDefined();
      expect(cookies[0]).toMatch(/refreshToken=/);
      expect(cookies[0]).toMatch(/HttpOnly/);

      // Verify access token
      const decoded = jwt.verify(
        response.body.accessToken,
        process.env.JWT_SECRET!,
      ) as any;
      expect(decoded.walletAddress).toBe(testWallet);
      expect(decoded.userId).toBe(response.body.user_id);

      // Verify refresh token in database
      const result = await pool.query(
        "SELECT * FROM refresh_tokens WHERE user_id = $1",
        [response.body.user_id],
      );
      expect(result.rows.length).toBe(1);
    });

    it("should return existing user on subsequent login", async () => {
      // First login
      const firstResponse = await request(app)
        .post("/auth/login")
        .send({ wallet_address: testWallet })
        .expect(200);

      const firstUserId = firstResponse.body.user_id;

      // Second login
      const secondResponse = await request(app)
        .post("/auth/login")
        .send({ wallet_address: testWallet })
        .expect(200);

      expect(secondResponse.body.user_id).toBe(firstUserId);

      // Should have two refresh tokens now
      const result = await pool.query(
        "SELECT * FROM refresh_tokens WHERE user_id = $1",
        [firstUserId],
      );
      expect(result.rows.length).toBe(2);
    });

    it("should reject invalid wallet address", async () => {
      await request(app)
        .post("/auth/login")
        .send({ wallet_address: "short" })
        .expect(400);
    });

    it("should reject missing wallet address", async () => {
      await request(app).post("/auth/login").send({}).expect(400);
    });
  });

  describe("POST /auth/refresh", () => {
    let refreshToken: string;
    let userId: number;

    beforeEach(async () => {
      // Create a user and get refresh token
      const response = await request(app)
        .post("/auth/login")
        .send({ wallet_address: testWallet });

      userId = response.body.user_id;
      const cookies = response.headers["set-cookie"];
      refreshToken = cookies[0].split(";")[0].split("=")[1];
    });

    it("should return new access token and rotate refresh token", async () => {
      // Get initial refresh token count
      const initialTokens = await pool.query(
        "SELECT token_hash FROM refresh_tokens WHERE user_id = $1",
        [userId],
      );
      const initialHash = initialTokens.rows[0].token_hash;

      const response = await request(app)
        .post("/auth/refresh")
        .set("Cookie", [`refreshToken=${refreshToken}`])
        .expect(200);

      expect(response.body).toHaveProperty("accessToken");

      // Verify new access token
      const decoded = jwt.verify(
        response.body.accessToken,
        process.env.JWT_SECRET!,
      ) as any;
      expect(decoded.userId).toBe(userId);

      // Check new refresh token cookie is set
      const cookies = response.headers["set-cookie"];
      expect(cookies).toBeDefined();
      expect(cookies[0]).toMatch(/refreshToken=/);

      // Verify old token was deleted and new one created
      const newTokens = await pool.query(
        "SELECT token_hash FROM refresh_tokens WHERE user_id = $1",
        [userId],
      );
      expect(newTokens.rows.length).toBe(1);
      expect(newTokens.rows[0].token_hash).not.toBe(initialHash);
    });

    it("should reject request without refresh token", async () => {
      await request(app).post("/auth/refresh").expect(401);
    });

    it("should reject invalid refresh token", async () => {
      await request(app)
        .post("/auth/refresh")
        .set("Cookie", ["refreshToken=invalid_token_12345"])
        .expect(401);
    });

    it("should reject expired refresh token", async () => {
      // Manually expire the token
      await pool.query(
        "UPDATE refresh_tokens SET expires_at = NOW() - INTERVAL '1 day' WHERE user_id = $1",
        [userId],
      );

      await request(app)
        .post("/auth/refresh")
        .set("Cookie", [`refreshToken=${refreshToken}`])
        .expect(401);

      // Verify expired token was deleted
      const result = await pool.query(
        "SELECT * FROM refresh_tokens WHERE user_id = $1",
        [userId],
      );
      expect(result.rows.length).toBe(0);
    });

    it("should not allow reusing old refresh token after rotation", async () => {
      // First refresh
      await request(app)
        .post("/auth/refresh")
        .set("Cookie", [`refreshToken=${refreshToken}`])
        .expect(200);

      // Try to use old token again
      await request(app)
        .post("/auth/refresh")
        .set("Cookie", [`refreshToken=${refreshToken}`])
        .expect(401);
    });
  });

  describe("POST /auth/logout", () => {
    let refreshToken: string;
    let userId: number;

    beforeEach(async () => {
      // Create a user and get refresh token
      const response = await request(app)
        .post("/auth/login")
        .send({ wallet_address: testWallet });

      userId = response.body.user_id;
      const cookies = response.headers["set-cookie"];
      refreshToken = cookies[0].split(";")[0].split("=")[1];
    });

    it("should invalidate refresh token and clear cookie", async () => {
      const response = await request(app)
        .post("/auth/logout")
        .set("Cookie", [`refreshToken=${refreshToken}`])
        .expect(200);

      expect(response.body.message).toBe("Logged out successfully");

      // Verify token was deleted from database
      const result = await pool.query(
        "SELECT * FROM refresh_tokens WHERE user_id = $1",
        [userId],
      );
      expect(result.rows.length).toBe(0);

      // Check cookie was cleared
      const cookies = response.headers["set-cookie"];
      expect(cookies).toBeDefined();
      expect(cookies[0]).toMatch(/refreshToken=;/);
    });

    it("should succeed even without refresh token", async () => {
      await request(app).post("/auth/logout").expect(200);
    });

    it("should succeed with invalid refresh token", async () => {
      await request(app)
        .post("/auth/logout")
        .set("Cookie", ["refreshToken=invalid_token"])
        .expect(200);
    });
  });

  describe("Token expiry", () => {
    it("should set access token to expire in 15 minutes", async () => {
      const response = await request(app)
        .post("/auth/login")
        .send({ wallet_address: testWallet });

      const decoded = jwt.decode(response.body.accessToken) as any;
      const expiryTime = decoded.exp - decoded.iat;

      // 15 minutes = 900 seconds
      expect(expiryTime).toBe(900);
    });

    it("should set refresh token to expire in 7 days", async () => {
      const response = await request(app)
        .post("/auth/login")
        .send({ wallet_address: testWallet });

      const userId = response.body.user_id;

      const result = await pool.query<{ expires_at: Date; created_at: Date }>(
        "SELECT expires_at, created_at FROM refresh_tokens WHERE user_id = $1",
        [userId],
      );

      const expiresAt = new Date(result.rows[0].expires_at);
      const createdAt = new Date(result.rows[0].created_at);
      const diffDays =
        (expiresAt.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24);

      expect(diffDays).toBeCloseTo(7, 0);
    });
  });
});
