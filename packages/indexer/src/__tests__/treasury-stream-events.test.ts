import { nativeToScVal, SorobanRpc, xdr } from "@stellar/stellar-sdk";
import { processEvents } from "../events";
import { pool } from "../db";
import { broadcast } from "../ws";
import { invalidate, invalidatePattern } from "../cache";
import {
  persistTreasuryStreamEvent,
  treasuryStreamEventExists,
} from "../treasuryProjection";
import type { TreasuryStateReader } from "../treasuryReader";

jest.mock("../db", () => ({
  pool: { query: jest.fn() },
}));

jest.mock("../cache", () => ({
  invalidate: jest.fn(),
  invalidatePattern: jest.fn(),
}));

jest.mock("../ws", () => ({
  broadcast: jest.fn(),
}));

jest.mock("../treasuryProjection", () => ({
  persistTreasuryStreamEvent: jest.fn(),
  treasuryStreamEventExists: jest.fn(),
}));

const TREASURY = "CTREASURY";
const GOVERNOR = "CGOVERNOR";

function toScVal(value: unknown): xdr.ScVal {
  if (Array.isArray(value)) return xdr.ScVal.scvVec(value.map(toScVal));
  return nativeToScVal(value);
}

function makeEvent(
  id: string,
  ledger: number,
  eventType: string,
  value: unknown,
  contractId = TREASURY,
): SorobanRpc.Api.EventResponse {
  return {
    id,
    type: "contract",
    ledger,
    contractId,
    txHash: `tx-${ledger}`,
    topic: [nativeToScVal(eventType, { type: "symbol" })],
    value: toScVal(value),
  } as unknown as SorobanRpc.Api.EventResponse;
}

const stream = {
  streamId: "1",
  name: "grants",
  owner: "GOWNER",
  token: "CTOKEN",
  totalAllocated: "170141183460469231731687303715884105727",
  totalSpent: "30",
  startLedger: 10,
  endLedger: 1000,
  isActive: true,
  isRevoked: false,
  revokedAtLedger: null,
  maxSingleSpend: "100",
  cooldownLedgers: 5,
  lastSpendLedger: 101,
  spendCount: 2,
  createdByProposalId: "9",
};

const spends = [
  {
    streamId: "1",
    spendIndex: 0,
    recipient: "GONE",
    amount: "10",
    memo: "first",
    executedAtLedger: 100,
    executedBy: "GOWNER",
  },
  {
    streamId: "1",
    spendIndex: 1,
    recipient: "GTWO",
    amount: "20",
    memo: "second",
    executedAtLedger: 101,
    executedBy: "GOWNER",
  },
];

describe("treasury stream event indexing", () => {
  let reader: jest.Mocked<TreasuryStateReader>;

  beforeEach(() => {
    jest.clearAllMocks();
    (pool.query as jest.Mock).mockResolvedValue({ rows: [] });
    (treasuryStreamEventExists as jest.Mock).mockResolvedValue(false);
    (persistTreasuryStreamEvent as jest.Mock).mockResolvedValue(true);
    reader = {
      getStream: jest.fn().mockResolvedValue(stream),
      getStreams: jest.fn(),
      getStreamSpends: jest.fn().mockResolvedValue(spends),
    };
  });

  it("routes, hydrates, persists, invalidates, and broadcasts all eight topics", async () => {
    const events = [
      makeEvent("event-1", 100, "stream_created", [1n, "grants", "GOWNER"]),
      makeEvent("event-2", 101, "stream_spend", [1n, "GONE", 10n]),
      makeEvent("event-3", 102, "stream_batch", [1n, 20n, 2]),
      makeEvent("event-4", 103, "stream_revoked", [1n, "GGOV", 70n]),
      makeEvent("event-5", 104, "stream_extended", [1n, 1000, 2000]),
      makeEvent("event-6", 105, "stream_topped_up", [1n, 50n, 150n]),
      makeEvent("event-7", 106, "stream_exhausted", 1n),
      makeEvent("event-8", 107, "stream_expired", [1n, 40n]),
    ];
    const server = {
      getEvents: jest.fn().mockResolvedValue({ events }),
    } as unknown as SorobanRpc.Server;

    const latest = await processEvents(
      server,
      {
        rpcUrl: "http://fake",
        governorAddress: GOVERNOR,
        treasuryAddress: TREASURY,
        treasuryStateReader: reader,
        pollIntervalMs: 1,
      },
      100,
    );

    expect(latest).toBe(107);
    expect(reader.getStream).toHaveBeenCalledTimes(8);
    expect(reader.getStreamSpends).toHaveBeenCalledTimes(2);
    expect(persistTreasuryStreamEvent).toHaveBeenCalledTimes(8);
    expect(
      (persistTreasuryStreamEvent as jest.Mock).mock.calls.map(
        ([call]) => call.event.eventType,
      ),
    ).toEqual([
      "stream_created",
      "stream_spend",
      "stream_batch",
      "stream_revoked",
      "stream_extended",
      "stream_topped_up",
      "stream_exhausted",
      "stream_expired",
    ]);
    expect(
      (broadcast as jest.Mock).mock.calls.map(([message]) => message.type),
    ).toEqual([
      "stream_created",
      "stream_spend",
      "stream_batch",
      "stream_revoked",
      "stream_extended",
      "stream_topped_up",
      "stream_exhausted",
      "stream_expired",
    ]);
    expect(invalidate).toHaveBeenCalledWith(
      "treasury:stream:1",
      "treasury:budget-summary",
    );
    expect(invalidatePattern).toHaveBeenCalledWith("treasury:streams:");
    expect(
      (pool.query as jest.Mock).mock.calls.filter(([sql]) =>
        String(sql).includes("INSERT INTO event_log"),
      ),
    ).toHaveLength(8);
  });

  it("does not route matching topics from a different contract", async () => {
    const server = {
      getEvents: jest
        .fn()
        .mockResolvedValue({
          events: [
            makeEvent(
              "event-other",
              200,
              "stream_spend",
              [1n, "GONE", 10n],
              GOVERNOR,
            ),
          ],
        }),
    } as unknown as SorobanRpc.Server;

    await processEvents(
      server,
      {
        rpcUrl: "http://fake",
        governorAddress: GOVERNOR,
        treasuryAddress: TREASURY,
        treasuryStateReader: reader,
        pollIntervalMs: 1,
      },
      200,
    );

    expect(reader.getStream).not.toHaveBeenCalled();
    expect(persistTreasuryStreamEvent).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("skips hydration and broadcast when an event receipt already exists", async () => {
    (treasuryStreamEventExists as jest.Mock).mockResolvedValue(true);
    const server = {
      getEvents: jest
        .fn()
        .mockResolvedValue({
          events: [
            makeEvent("event-replay", 300, "stream_spend", [1n, "GONE", 10n]),
          ],
        }),
    } as unknown as SorobanRpc.Server;

    await processEvents(
      server,
      {
        rpcUrl: "http://fake",
        governorAddress: GOVERNOR,
        treasuryAddress: TREASURY,
        treasuryStateReader: reader,
        pollIntervalMs: 1,
      },
      300,
    );

    expect(reader.getStream).not.toHaveBeenCalled();
    expect(persistTreasuryStreamEvent).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("rejects the batch so the ledger checkpoint cannot advance on hydration failure", async () => {
    reader.getStream.mockRejectedValueOnce(new Error("RPC unavailable"));
    const server = {
      getEvents: jest
        .fn()
        .mockResolvedValue({
          events: [
            makeEvent("event-fail", 400, "stream_spend", [1n, "GONE", 10n]),
          ],
        }),
    } as unknown as SorobanRpc.Server;

    await expect(
      processEvents(
        server,
        {
          rpcUrl: "http://fake",
          governorAddress: GOVERNOR,
          treasuryAddress: TREASURY,
          treasuryStateReader: reader,
          pollIntervalMs: 1,
        },
        400,
      ),
    ).rejects.toThrow("RPC unavailable");
  });

  it("rejects malformed stream events before hydration", async () => {
    const server = {
      getEvents: jest
        .fn()
        .mockResolvedValue({
          events: [
            makeEvent("event-malformed", 500, "stream_spend", [1n, "GONE"]),
          ],
        }),
    } as unknown as SorobanRpc.Server;

    await expect(
      processEvents(
        server,
        {
          rpcUrl: "http://fake",
          governorAddress: GOVERNOR,
          treasuryAddress: TREASURY,
          treasuryStateReader: reader,
          pollIntervalMs: 1,
        },
        500,
      ),
    ).rejects.toThrow("stream_spend expected 3 fields, received 2");
    expect(reader.getStream).not.toHaveBeenCalled();
  });
});
