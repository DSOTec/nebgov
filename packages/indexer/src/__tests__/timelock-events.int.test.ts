import { SorobanRpc, StrKey, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { initDb, pool } from "../db";
import { processEvents } from "../events";

class FakeServer {
  constructor(private events: SorobanRpc.Api.EventResponse[]) {}
  async getEvents() {
    return { events: this.events };
  }
}

function myNativeToScVal(value: any): xdr.ScVal {
  if (Array.isArray(value)) {
    return xdr.ScVal.scvVec(value.map((v) => myNativeToScVal(v)));
  }
  return nativeToScVal(value);
}

function makeEvent(params: {
  contractId: string;
  ledger: number;
  type: string;
  topicArgs?: any[];
  value: any;
}): SorobanRpc.Api.EventResponse {
  const topic = [
    nativeToScVal(params.type, { type: "symbol" }),
    ...(params.topicArgs ?? []).map((a) => myNativeToScVal(a)),
  ];
  const value = myNativeToScVal(params.value);
  return {
    type: "contract",
    ledger: params.ledger,
    contractId: params.contractId as any,
    topic,
    value,
  } as any;
}

describe("timelock event indexing (integration)", () => {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    it.skip("DATABASE_URL not set", () => undefined);
    return;
  }

  const TIMELOCK = StrKey.encodeContract(Buffer.alloc(32, 6));
  const GOVERNOR = StrKey.encodeContract(Buffer.alloc(32, 7));

  beforeAll(async () => {
    await initDb();
    await pool.query("DELETE FROM timelock_operations");
    await pool.query("DELETE FROM timelock_batch_operations");
    await pool.query("DELETE FROM timelock_dependency_graphs");
    await pool.query("DELETE FROM timelock_partial_batch_state");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("indexes OperationScheduled and OperationExecuted events", async () => {
    const opIdBytes = Buffer.from("01020304", "hex");
    const schedEvent = makeEvent({
      contractId: TIMELOCK,
      ledger: 100,
      type: "OperationScheduled",
      value: [opIdBytes, "GTARGETADDRESS", "test_fn", BigInt(1000), BigInt(2000)],
    });

    const execEvent = makeEvent({
      contractId: TIMELOCK,
      ledger: 105,
      type: "OperationExecuted",
      value: [opIdBytes, "GCALLERADDRESS"],
    });

    const server = new FakeServer([schedEvent, execEvent]) as unknown as SorobanRpc.Server;
    const latest = await processEvents(
      server,
      { rpcUrl: "http://fake", governorAddress: GOVERNOR, timelockAddress: TIMELOCK, pollIntervalMs: 1 },
      1
    );

    expect(latest).toBe(105);

    const rows = await pool.query(
      "SELECT * FROM timelock_operations WHERE op_id = $1",
      ["01020304"]
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].target).toBe("GTARGETADDRESS");
    expect(rows.rows[0].fn_name).toBe("test_fn");
    expect(rows.rows[0].status).toBe("executed");
    expect(rows.rows[0].executed_by).toBe("GCALLERADDRESS");
    expect(rows.rows[0].executed_at_ledger).toBe(105);
  });

  it("indexes BatchOperationScheduled and DependencyDagValidated events", async () => {
    const batchIdBytes = Buffer.from("0a0b0c0d", "hex");
    const batchSchedEvent = makeEvent({
      contractId: TIMELOCK,
      ledger: 110,
      type: "BatchOperationScheduled",
      value: [batchIdBytes, ["GTARGET1"], ["fn1"], BigInt(1000), BigInt(2000)],
    });

    const dagEvent = makeEvent({
      contractId: TIMELOCK,
      ledger: 111,
      type: "DependencyDagValidated",
      value: [batchIdBytes, 3],
    });

    const server = new FakeServer([batchSchedEvent, dagEvent]) as unknown as SorobanRpc.Server;
    await processEvents(
      server,
      { rpcUrl: "http://fake", governorAddress: GOVERNOR, timelockAddress: TIMELOCK, pollIntervalMs: 1 },
      1
    );

    const batchRows = await pool.query(
      "SELECT * FROM timelock_batch_operations WHERE batch_op_id = $1",
      ["0a0b0c0d"]
    );
    expect(batchRows.rows.length).toBe(1);
    expect(batchRows.rows[0].status).toBe("scheduled");

    const dagRows = await pool.query(
      "SELECT * FROM timelock_dependency_graphs WHERE batch_op_id = $1",
      ["0a0b0c0d"]
    );
    expect(dagRows.rows.length).toBe(1);
    expect(dagRows.rows[0].op_count).toBe(3);
    expect(dagRows.rows[0].has_cycle).toBe(false);
  });

  it("indexes PartialBatchStarted and PartialOpSucceeded events", async () => {
    const batchIdBytes = Buffer.from("f0f1f2f3", "hex");
    const opIdBytes = Buffer.from("e0e1e2e3", "hex");

    const startEvent = makeEvent({
      contractId: TIMELOCK,
      ledger: 120,
      type: "PartialBatchStarted",
      value: [batchIdBytes, 5],
    });

    const succEvent = makeEvent({
      contractId: TIMELOCK,
      ledger: 122,
      type: "PartialOpSucceeded",
      value: [batchIdBytes, opIdBytes, 1, 5],
    });

    const server = new FakeServer([startEvent, succEvent]) as unknown as SorobanRpc.Server;
    await processEvents(
      server,
      { rpcUrl: "http://fake", governorAddress: GOVERNOR, timelockAddress: TIMELOCK, pollIntervalMs: 1 },
      1
    );

    const rows = await pool.query(
      "SELECT * FROM timelock_partial_batch_state WHERE batch_op_id = $1",
      ["f0f1f2f3"]
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].total_ops).toBe(5);
    expect(rows.rows[0].completed_ops).toBe(1);
    expect(rows.rows[0].last_op_id).toBe("e0e1e2e3");
    expect(rows.rows[0].last_status).toBe("succeeded");
  });
});
