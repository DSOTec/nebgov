import { nativeToScVal, SorobanRpc, xdr } from "@stellar/stellar-sdk";
import { processEvents } from "../events";
import { pool } from "../db";
import { broadcast } from "../ws";
import { invalidatePattern } from "../cache";

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

const GOVERNOR = "CGOVERNOR";
const CONVICTION = "CCONVICTION";

function toScVal(value: unknown): any {
  if (Array.isArray(value)) return xdr.ScVal.scvVec(value.map(toScVal));
  return nativeToScVal(value);
}

function makeEvent(
  id: string,
  ledger: number,
  eventType: string,
  value: unknown,
  proposalId: unknown,
  contractId = CONVICTION,
): SorobanRpc.Api.EventResponse {
  return {
    id,
    type: "contract",
    ledger,
    contractId,
    txHash: `tx-${ledger}`,
    topic: [
      nativeToScVal(eventType, { type: "symbol" }),
      nativeToScVal(proposalId, { type: "u64" }),
    ],
    value: toScVal(value),
  } as unknown as SorobanRpc.Api.EventResponse;
}

describe("conviction voting event indexing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (pool.query as jest.Mock).mockResolvedValue({ rows: [] });
  });

  function run(events: SorobanRpc.Api.EventResponse[]) {
    const server = {
      getEvents: jest.fn().mockResolvedValue({ events }),
    } as unknown as SorobanRpc.Server;
    return processEvents(
      server,
      {
        rpcUrl: "http://fake",
        governorAddress: GOVERNOR,
        convictionVotingAddress: CONVICTION,
        pollIntervalMs: 1,
      },
      100,
    );
  }

  it("writes a conviction_proposals row on ProposalCreated", async () => {
    await run([
      makeEvent("e1", 100, "ProposalCreated", ["GPROPOSER", "CTARGET", 500n], 1n),
    ]);

    const insert = (pool.query as jest.Mock).mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO conviction_proposals"),
    );
    expect(insert).toBeDefined();
    expect(insert![1]).toEqual(["1", "GPROPOSER", "CTARGET", "500", 100]);
    expect(invalidatePattern).toHaveBeenCalledWith("conviction:");
    expect(broadcast).toHaveBeenCalledWith({
      type: "conviction_proposal_created",
      data: { proposal_id: "1", ledger: 100 },
    });
  });

  it("upserts a conviction_stakes row on StakeUpdated (non-zero amount)", async () => {
    await run([
      makeEvent("e1", 100, "StakeUpdated", ["GSTAKER", 250n], 1n),
    ]);

    const upsert = (pool.query as jest.Mock).mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO conviction_stakes"),
    );
    expect(upsert).toBeDefined();
    expect(upsert![1]).toEqual(["GSTAKER", "1", "250", 100]);
    expect(
      (pool.query as jest.Mock).mock.calls.some(([sql]) =>
        String(sql).includes("DELETE FROM conviction_stakes"),
      ),
    ).toBe(false);
    expect(broadcast).toHaveBeenCalledWith({
      type: "conviction_stake_updated",
      data: { proposal_id: "1", ledger: 100 },
    });
  });

  it("deletes the conviction_stakes row when StakeUpdated amount is zero", async () => {
    await run([
      makeEvent("e1", 100, "StakeUpdated", ["GSTAKER", 0n], 1n),
    ]);

    const del = (pool.query as jest.Mock).mock.calls.find(([sql]) =>
      String(sql).includes("DELETE FROM conviction_stakes"),
    );
    expect(del).toBeDefined();
    expect(del![1]).toEqual(["GSTAKER", "1"]);
    expect(
      (pool.query as jest.Mock).mock.calls.some(([sql]) =>
        String(sql).includes("INSERT INTO conviction_stakes"),
      ),
    ).toBe(false);
  });

  it("updates conviction and appends a conviction_snapshots row on ConvictionUpdated", async () => {
    await run([
      makeEvent("e1", 100, "ConvictionUpdated", [777n], 1n),
    ]);

    const update = (pool.query as jest.Mock).mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE conviction_proposals SET conviction"),
    );
    expect(update).toBeDefined();
    expect(update![1]).toEqual(["1", "777", 100]);

    const snapshot = (pool.query as jest.Mock).mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO conviction_snapshots"),
    );
    expect(snapshot).toBeDefined();
    expect(snapshot![1]).toEqual(["1", 100, "777"]);
    expect(broadcast).toHaveBeenCalledWith({
      type: "conviction_conviction_updated",
      data: { proposal_id: "1", ledger: 100 },
    });
  });

  it("marks the proposal executed on ProposalExecuted", async () => {
    await run([
      makeEvent("e1", 100, "ProposalExecuted", [], 1n),
    ]);

    const update = (pool.query as jest.Mock).mock.calls.find(([sql]) =>
      String(sql).includes("SET executed = TRUE"),
    );
    expect(update).toBeDefined();
    expect(update![1]).toEqual(["1"]);
    expect(broadcast).toHaveBeenCalledWith({
      type: "conviction_proposal_executed",
      data: { proposal_id: "1", ledger: 100 },
    });
  });

  it("marks the proposal cancelled on ProposalCancelled", async () => {
    await run([
      makeEvent("e1", 100, "ProposalCancelled", [], 1n),
    ]);

    const update = (pool.query as jest.Mock).mock.calls.find(([sql]) =>
      String(sql).includes("SET cancelled = TRUE"),
    );
    expect(update).toBeDefined();
    expect(update![1]).toEqual(["1"]);
    expect(broadcast).toHaveBeenCalledWith({
      type: "conviction_proposal_cancelled",
      data: { proposal_id: "1", ledger: 100 },
    });
  });

  it("does not route conviction topics emitted from the governor contract", async () => {
    const server = {
      getEvents: jest
        .fn()
        .mockResolvedValue({
          events: [
            makeEvent("e1", 100, "ProposalCreated", ["GPROPOSER", "CTARGET", 500n], 1n, GOVERNOR),
          ],
        }),
    } as unknown as SorobanRpc.Server;

    await processEvents(
      server,
      {
        rpcUrl: "http://fake",
        governorAddress: GOVERNOR,
        convictionVotingAddress: CONVICTION,
        pollIntervalMs: 1,
      },
      100,
    );

    expect(
      (pool.query as jest.Mock).mock.calls.some(([sql]) =>
        String(sql).includes("conviction_proposals"),
      ),
    ).toBe(false);
    expect(invalidatePattern).not.toHaveBeenCalledWith("conviction:");
    expect(broadcast).not.toHaveBeenCalledWith({
      type: "conviction_proposal_created",
      data: { proposal_id: "1", ledger: 100 },
    });
  });
});
