import request from "supertest";
import { createApp } from "../api";
import { pool } from "../db";

jest.mock("../db", () => ({
  pool: { query: jest.fn() },
}));

jest.mock("../cache", () => ({
  cached: jest.fn((_key, _ttl, fn) => fn()),
  getMetrics: jest.fn(() => ({ hits: 0, misses: 0, size: 0 })),
}));

jest.mock("../events", () => ({
  getLastIndexedLedger: jest.fn().mockResolvedValue(100),
}));

jest.mock("../index", () => ({
  startTime: Date.now(),
}));

const app = createApp({
  getLatestLedger: jest.fn().mockResolvedValue({ sequence: 100 }),
} as any);
const query = pool.query as jest.Mock;

describe("treasury stream REST API", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("lists streams with owner filtering and pagination", async () => {
    const rows = [
      {
        stream_id: "1",
        owner: "GOWNER",
        total_allocated: "170141183460469231731687303715884105727",
      },
    ];
    query.mockResolvedValueOnce({ rows });

    const response = await request(app).get(
      "/streams?owner=GOWNER&limit=10&offset=0",
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: rows,
      pagination: { limit: 10, offset: 0, hasMore: false },
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE owner = $1"),
      ["GOWNER", 10, 0],
    );
  });

  it("returns one stream and rejects an invalid stream ID", async () => {
    const row = { stream_id: "1", name: "grants" };
    query.mockResolvedValueOnce({ rows: [row] });

    const found = await request(app).get("/streams/1");
    const invalid = await request(app).get("/streams/not-a-number");

    expect(found.status).toBe(200);
    expect(found.body).toEqual(row);
    expect(invalid.status).toBe(400);
  });

  it("returns 404 for spends when the stream does not exist", async () => {
    query.mockResolvedValueOnce({ rows: [] });

    const response = await request(app).get("/streams/9/spends");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Stream not found" });
  });

  it("returns complete spend records in spend-index order", async () => {
    const spends = [
      {
        stream_id: "1",
        spend_index: "0",
        recipient: "GRECIPIENT",
        amount: "100",
        memo: "audit",
        executed_at_ledger: "50",
        executed_by: "GOWNER",
      },
    ];
    query
      .mockResolvedValueOnce({ rows: [{ exists: 1 }] })
      .mockResolvedValueOnce({ rows: spends });

    const response = await request(app).get(
      "/streams/1/spends?limit=20&offset=0",
    );

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(spends);
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining("ORDER BY spend_index ASC"),
      ["1", 20, 0],
    );
  });

  it("serves lifecycle history for the existing SDK method", async () => {
    const events = [
      {
        event_type: "stream_expired",
        stream_id: "1",
        unspent: "50",
        ledger: "100",
      },
    ];
    query.mockResolvedValueOnce({ rows: events });

    const response = await request(app).get(
      "/treasury/stream-events?stream_id=1&limit=20&offset=0",
    );

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(events);
  });

  it("returns the treasury-wide token summary with exact amounts", async () => {
    query
      .mockResolvedValueOnce({
        rows: [{ total_streams: 2, active_streams: 1 }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            token: "CTOKEN",
            total_allocated: "170141183460469231731687303715884105727",
            total_spent: "10",
            total_remaining: "170141183460469231731687303715884105717",
          },
        ],
      });

    const response = await request(app).get("/treasury/budget-summary");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      total_streams: 2,
      active_streams: 1,
      total_allocated_by_token: [
        {
          token: "CTOKEN",
          amount: "170141183460469231731687303715884105727",
        },
      ],
      total_spent_by_token: [{ token: "CTOKEN", amount: "10" }],
      total_remaining_by_token: [
        {
          token: "CTOKEN",
          amount: "170141183460469231731687303715884105717",
        },
      ],
    });
  });
});
