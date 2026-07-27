import { nativeToScVal, SorobanRpc, xdr } from "@stellar/stellar-sdk";
import { pool } from "../db";
import { processEvents } from "../events";
import { broadcast } from "../ws";

jest.mock("../db", () => ({
  pool: { query: jest.fn().mockResolvedValue({ rows: [] }) },
}));

jest.mock("../cache", () => ({
  invalidate: jest.fn(),
  invalidatePattern: jest.fn(),
}));

jest.mock("../ws", () => ({
  broadcast: jest.fn(),
}));

const TOKEN_VOTES_ADDRESS =
  "CTOKENVOTESTESTADDRESS00000000000000000000000000000000000000";
const GOVERNOR_ADDRESS =
  "CGOVERNORTESTADDRESS00000000000000000000000000000000000000";

function makeEvent(
  ledger: number,
  eventType: string,
  addressTopic: string,
  value: Record<string, unknown>,
): SorobanRpc.Api.EventResponse {
  return {
    type: "contract",
    ledger,
    contractId: TOKEN_VOTES_ADDRESS,
    topic: [
      nativeToScVal(eventType, { type: "symbol" }),
      nativeToScVal(addressTopic, { type: "string" }),
    ],
    value: nativeToScVal(value) as xdr.ScVal,
  } as unknown as SorobanRpc.Api.EventResponse;
}

describe("token-votes signed-delegation event indexing (issue #910)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("handles DelegatedBySig, PermitsInvalidated, and RelayerWhitelistUpdated", async () => {
    const events = [
      makeEvent(100, "DelegatedBySig", "GDELEGATOR", {
        delegator: "GDELEGATOR",
        delegatee: "GDELEGATEE",
        relayer: "GRELAYER",
        nonce: 5,
      }),
      makeEvent(101, "PermitsInvalidated", "GDELEGATOR", {
        delegator: "GDELEGATOR",
        new_nonce: 6,
      }),
      makeEvent(102, "RelayerWhitelistUpdated", "GRELAYER", {
        relayer: "GRELAYER",
        whitelisted: true,
      }),
    ];

    const getEvents = jest.fn().mockResolvedValue({ events });
    const server = { getEvents } as unknown as SorobanRpc.Server;

    const latestLedger = await processEvents(
      server,
      {
        rpcUrl: "http://fake",
        governorAddress: GOVERNOR_ADDRESS,
        tokenVotesAddress: TOKEN_VOTES_ADDRESS,
        pollIntervalMs: 1,
      },
      100,
    );

    expect(latestLedger).toBe(102);

    expect(broadcast).toHaveBeenCalledTimes(3);
    expect((broadcast as jest.Mock).mock.calls.map(([event]) => event.type)).toEqual([
      "delegated_by_sig",
      "permits_invalidated",
      "relayer_whitelist_updated",
    ]);

    expect(broadcast).toHaveBeenCalledWith({
      type: "delegated_by_sig",
      data: {
        delegator: "GDELEGATOR",
        delegatee: "GDELEGATEE",
        relayer: "GRELAYER",
        nonce: "5",
        ledger: 100,
      },
    });
    expect(broadcast).toHaveBeenCalledWith({
      type: "permits_invalidated",
      data: { delegator: "GDELEGATOR", new_nonce: "6", ledger: 101 },
    });
    expect(broadcast).toHaveBeenCalledWith({
      type: "relayer_whitelist_updated",
      data: { relayer: "GRELAYER", whitelisted: true, ledger: 102 },
    });

    const queries = (pool.query as jest.Mock).mock.calls.map(([sql]) => String(sql));
    expect(queries.filter((sql) => sql.includes("INSERT INTO event_log"))).toHaveLength(3);
    expect(
      queries.some((sql) => sql.includes("INSERT INTO delegated_by_sig_events")),
    ).toBe(true);
    expect(
      queries.some((sql) => sql.includes("INSERT INTO relayer_whitelist_history")),
    ).toBe(true);
    // PermitsInvalidated is broadcast-only — no dedicated table insert, so the
    // only INSERTs beyond event_log are one delegated_by_sig_events and one
    // relayer_whitelist_history row.
    expect(queries.filter((sql) => sql.includes("INSERT INTO")).length).toBe(5);
  });

  it("does not route matching topics from another contract to token-votes handlers", async () => {
    const event = {
      ...makeEvent(200, "DelegatedBySig", "GDELEGATOR", {
        delegator: "GDELEGATOR",
        delegatee: "GDELEGATEE",
        relayer: "GRELAYER",
        nonce: 1,
      }),
      contractId: GOVERNOR_ADDRESS,
    };
    const server = {
      getEvents: jest.fn().mockResolvedValue({ events: [event] }),
    } as unknown as SorobanRpc.Server;

    await processEvents(
      server,
      {
        rpcUrl: "http://fake",
        governorAddress: GOVERNOR_ADDRESS,
        tokenVotesAddress: TOKEN_VOTES_ADDRESS,
        pollIntervalMs: 1,
      },
      200,
    );

    expect(broadcast).not.toHaveBeenCalled();
    expect(
      (pool.query as jest.Mock).mock.calls.some(([sql]) =>
        String(sql).includes("INSERT INTO delegated_by_sig_events"),
      ),
    ).toBe(false);
  });
});
