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

const TIMLOCK_ADDRESS =
  "CTIMELOCKTESTADDRESS0000000000000000000000000000000000000000";
const GOVERNOR_ADDRESS =
  "CGOVERNORTESTADDRESS00000000000000000000000000000000000000";

function toScVal(value: unknown): xdr.ScVal {
  if (Array.isArray(value)) {
    return xdr.ScVal.scvVec(value.map(toScVal));
  }
  return nativeToScVal(value);
}

function makeEvent(
  ledger: number,
  eventType: string,
  value: unknown,
): SorobanRpc.Api.EventResponse {
  return {
    type: "contract",
    ledger,
    contractId: TIMLOCK_ADDRESS,
    topic: [nativeToScVal(eventType, { type: "symbol" })],
    value: toScVal(value),
  } as unknown as SorobanRpc.Api.EventResponse;
}

describe("timelock event indexing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("watches the configured timelock and handles its complete 16-topic event surface", async () => {
    const opId = Buffer.from("01020304", "hex");
    const batchId = Buffer.from("0a0b0c0d", "hex");
    const failedOpId = Buffer.from("11121314", "hex");

    const events = [
      makeEvent(100, "OperationScheduled", {
        op_id: opId,
        target: "GTARGET",
        fn_name: "upgrade",
        ready_at: 1_000n,
        expires_at: 2_000n,
      }),
      makeEvent(101, "OperationExecuted", {
        op_id: opId,
        caller: "GCALLER",
      }),
      makeEvent(102, "OperationCancelled", {
        op_id: opId,
        caller: "GCANCELLER",
      }),
      makeEvent(103, "BatchOperationScheduled", {
        batch_op_id: batchId,
        targets: ["GTARGET1", "GTARGET2"],
        fn_names: ["first", "second"],
        ready_at: 3_000n,
        expires_at: 4_000n,
      }),
      makeEvent(104, "BatchOperationExecuted", {
        batch_op_id: batchId,
        caller: "GCALLER",
      }),
      makeEvent(105, "BatchOperationCancelled", {
        batch_op_id: batchId,
        caller: "GCANCELLER",
      }),
      makeEvent(106, "MinDelayUpdated", {
        old_delay: 60n,
        new_delay: 120n,
      }),
      makeEvent(107, "DependencyDagValidated", [batchId, 2]),
      makeEvent(108, "CycleDetected", [opId, failedOpId]),
      makeEvent(109, "PartialBatchStarted", [batchId, 2]),
      makeEvent(110, "PartialOpSucceeded", [batchId, opId, 1, 2]),
      makeEvent(111, "PartialOpFailed", [batchId, failedOpId]),
      makeEvent(112, "BatchRecoveryEntered", [batchId, 500]),
      makeEvent(113, "FailedOpRetried", [batchId, failedOpId, 1, true]),
      makeEvent(114, "FailedOpSkipped", [batchId, failedOpId]),
      makeEvent(115, "BatchFullyComplete", batchId),
    ];

    const getEvents = jest.fn().mockResolvedValue({ events });
    const server = { getEvents } as unknown as SorobanRpc.Server;

    const latestLedger = await processEvents(
      server,
      {
        rpcUrl: "http://fake",
        governorAddress: GOVERNOR_ADDRESS,
        timelockAddress: TIMLOCK_ADDRESS,
        pollIntervalMs: 1,
      },
      100,
    );

    expect(latestLedger).toBe(115);
    expect(getEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [
          {
            type: "contract",
            contractIds: [GOVERNOR_ADDRESS, TIMLOCK_ADDRESS],
          },
        ],
      }),
    );

    expect(broadcast).toHaveBeenCalledTimes(16);
    expect((broadcast as jest.Mock).mock.calls.map(([event]) => event.type)).toEqual([
      "timelock_operation_scheduled",
      "timelock_operation_executed",
      "timelock_operation_cancelled",
      "timelock_batch_operation_scheduled",
      "timelock_batch_operation_executed",
      "timelock_batch_operation_cancelled",
      "timelock_min_delay_updated",
      "timelock_dependency_dag_validated",
      "timelock_cycle_detected",
      "timelock_partial_batch_started",
      "timelock_partial_op_succeeded",
      "timelock_partial_op_failed",
      "timelock_batch_recovery_entered",
      "timelock_failed_op_retried",
      "timelock_failed_op_skipped",
      "timelock_batch_fully_complete",
    ]);

    const queries = (pool.query as jest.Mock).mock.calls.map(([sql]) =>
      String(sql),
    );
    expect(queries.filter((sql) => sql.includes("INSERT INTO event_log"))).toHaveLength(
      16,
    );
    expect(
      queries.some((sql) => sql.includes("INSERT INTO timelock_operations")),
    ).toBe(true);
    expect(
      queries.some((sql) =>
        sql.includes("INSERT INTO timelock_batch_operations"),
      ),
    ).toBe(true);
    expect(
      queries.filter((sql) =>
        sql.includes("INSERT INTO timelock_dependency_graphs"),
      ),
    ).toHaveLength(2);
    expect(
      queries.some((sql) =>
        sql.includes("INSERT INTO timelock_partial_batch_state"),
      ),
    ).toBe(true);

    expect(broadcast).toHaveBeenCalledWith({
      type: "timelock_operation_scheduled",
      data: expect.objectContaining({
        op_id: "01020304",
        target: "GTARGET",
        fn_name: "upgrade",
        ready_at: "1000",
        expires_at: "2000",
      }),
    });
    expect(broadcast).toHaveBeenCalledWith({
      type: "timelock_cycle_detected",
      data: {
        cycle_path: ["01020304", "11121314"],
        ledger: 108,
      },
    });
  });

  it("does not route matching topics from another contract to timelock handlers", async () => {
    const event = {
      ...makeEvent(200, "OperationScheduled", {
        op_id: Buffer.from("01020304", "hex"),
        target: "GTARGET",
        fn_name: "upgrade",
        ready_at: 1_000n,
        expires_at: 2_000n,
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
        timelockAddress: TIMLOCK_ADDRESS,
        pollIntervalMs: 1,
      },
      200,
    );

    expect(broadcast).not.toHaveBeenCalled();
    expect(
      (pool.query as jest.Mock).mock.calls.some(([sql]) =>
        String(sql).includes("INSERT INTO timelock_operations"),
      ),
    ).toBe(false);
  });
});
