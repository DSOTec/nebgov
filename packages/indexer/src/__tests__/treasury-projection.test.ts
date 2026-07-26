import { pool } from "../db";
import {
  bootstrapTreasuryProjection,
  persistTreasuryStreamEvent,
} from "../treasuryProjection";
import type { TreasuryStateReader } from "../treasuryReader";

jest.mock("../db", () => ({
  pool: {
    query: jest.fn(),
    connect: jest.fn(),
  },
}));

const stream = {
  streamId: "18446744073709551615",
  name: "security",
  owner: "GOWNER",
  token: "CTOKEN",
  totalAllocated: "170141183460469231731687303715884105727",
  totalSpent: "100",
  startLedger: 10,
  endLedger: 1000,
  isActive: true,
  isRevoked: false,
  revokedAtLedger: null,
  maxSingleSpend: "1000000000000000000000000000000",
  cooldownLedgers: 5,
  lastSpendLedger: 100,
  spendCount: 1,
  createdByProposalId: "18446744073709551615",
};

const spend = {
  streamId: stream.streamId,
  spendIndex: 0,
  recipient: "GRECIPIENT",
  amount: "100",
  memo: "audit",
  executedAtLedger: 100,
  executedBy: "GOWNER",
};

describe("treasury stream projection", () => {
  const client = {
    query: jest.fn(),
    release: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (pool.connect as jest.Mock).mockResolvedValue(client);
    client.query.mockResolvedValue({ rows: [] });
  });

  it("commits an event receipt, exact stream snapshot, and spend atomically", async () => {
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ event_id: "event-1" }] })
      .mockResolvedValue({ rows: [] });

    const inserted = await persistTreasuryStreamEvent({
      event: {
        eventId: "event-1",
        eventType: "stream_spend",
        streamId: stream.streamId,
        recipient: spend.recipient,
        amount: spend.amount,
        ledger: 100,
        payload: "{}",
      },
      stream,
      spends: [spend],
    });

    expect(inserted).toBe(true);
    expect(
      client.query.mock.calls.some(([sql]) =>
        String(sql).includes("INSERT INTO treasury_streams"),
      ),
    ).toBe(true);
    expect(
      client.query.mock.calls.some(([sql]) =>
        String(sql).includes("INSERT INTO treasury_stream_spends"),
      ),
    ).toBe(true);
    const streamCall = client.query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO treasury_streams"),
    );
    expect(streamCall?.[1]).toContain(
      "170141183460469231731687303715884105727",
    );
    expect(client.query).toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalled();
  });

  it("does not rewrite or rebroadcast a duplicate event receipt", async () => {
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const inserted = await persistTreasuryStreamEvent({
      event: {
        eventId: "event-1",
        eventType: "stream_spend",
        streamId: stream.streamId,
        ledger: 100,
        payload: "{}",
      },
      stream,
      spends: [spend],
    });

    expect(inserted).toBe(false);
    expect(
      client.query.mock.calls.some(([sql]) =>
        String(sql).includes("INSERT INTO treasury_streams"),
      ),
    ).toBe(false);
    expect(client.query).toHaveBeenCalledWith("COMMIT");
  });

  it("bootstraps existing streams and complete spend history", async () => {
    (pool.query as jest.Mock).mockResolvedValue({ rows: [] });
    const reader: jest.Mocked<TreasuryStateReader> = {
      getStream: jest.fn(),
      getStreams: jest
        .fn()
        .mockResolvedValueOnce([stream])
        .mockResolvedValueOnce([]),
      getStreamSpends: jest.fn().mockResolvedValueOnce([spend]),
    };

    const result = await bootstrapTreasuryProjection(reader, 500);

    expect(result).toEqual({ streams: 1, spends: 1 });
    expect(reader.getStreamSpends).toHaveBeenCalledWith(
      stream.streamId,
      0,
      1,
    );
    expect(
      (pool.query as jest.Mock).mock.calls.some(([sql]) =>
        String(sql).includes("INSERT INTO treasury_streams"),
      ),
    ).toBe(true);
  });
});
