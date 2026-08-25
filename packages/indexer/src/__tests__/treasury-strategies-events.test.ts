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
const STRATEGIES = "CSTRATEGIES";

function toScVal(value: unknown): any {
  if (Array.isArray(value)) return xdr.ScVal.scvVec(value.map(toScVal));
  return nativeToScVal(value);
}

function makeEvent(
  id: string,
  ledger: number,
  eventType: string,
  value: unknown,
  topic1: unknown,
  contractId = STRATEGIES,
): SorobanRpc.Api.EventResponse {
  return {
    id,
    type: "contract",
    ledger,
    contractId,
    txHash: `tx-${ledger}`,
    topic: [
      nativeToScVal(eventType, { type: "symbol" }),
      nativeToScVal(topic1, { type: "u64" }),
    ],
    value: toScVal(value),
  } as unknown as SorobanRpc.Api.EventResponse;
}

describe("treasury strategies event indexing", () => {
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
        treasuryStrategiesAddress: STRATEGIES,
        pollIntervalMs: 1,
      },
      100,
    );
  }

  it("inserts a treasury_strategies row on StratReg", async () => {
    await run([
      makeEvent("e1", 100, "StratReg", { adapter: "CADAPTER", token: "CTOKEN" }, 1n),
    ]);

    const insert = (pool.query as jest.Mock).mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO treasury_strategies"),
    );
    expect(insert).toBeDefined();
    expect(insert![1]).toEqual(["1", "CADAPTER", "CTOKEN", 100]);
    expect(invalidatePattern).toHaveBeenCalledWith("treasury-strategies:");
    expect(broadcast).toHaveBeenCalledWith({
      type: "strategy_registered",
      data: { strategy_id: "1", adapter: "CADAPTER", token: "CTOKEN", ledger: 100 },
    });
  });

  it("deactivates a strategy on StratDeact", async () => {
    await run([makeEvent("e1", 100, "StratDeact", [], 1n)]);

    const update = (pool.query as jest.Mock).mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE treasury_strategies SET active = FALSE"),
    );
    expect(update).toBeDefined();
    expect(update![1]).toEqual(["1"]);
    expect(broadcast).toHaveBeenCalledWith({
      type: "strategy_deactivated",
      data: { strategy_id: "1", ledger: 100 },
    });
  });

  it("records an allocation and raises current_allocation on Deposited", async () => {
    await run([
      makeEvent("e1", 100, "Deposited", { amount: 1000n }, 1n),
    ]);

    const insert = (pool.query as jest.Mock).mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO strategy_allocations"),
    );
    expect(insert).toBeDefined();
    expect(insert![1]).toEqual(["1", "1000", 100]);

    const update = (pool.query as jest.Mock).mock.calls.find(([sql]) =>
      String(sql).includes("current_allocation = current_allocation +"),
    );
    expect(update).toBeDefined();
    expect(update![1]).toEqual(["1", "1000"]);
    expect(broadcast).toHaveBeenCalledWith({
      type: "strategy_deposited",
      data: { strategy_id: "1", amount: "1000", ledger: 100 },
    });
  });

  it("records a withdrawal and lowers current_allocation on WdrawReq", async () => {
    await run([
      makeEvent(
        "e1",
        100,
        "WdrawReq",
        { strategy_id: 1n, amount: 400n, claimable_ledger: 200 },
        9n,
      ),
    ]);

    const insert = (pool.query as jest.Mock).mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO strategy_withdrawals"),
    );
    expect(insert).toBeDefined();
    expect(insert![1]).toEqual(["9", "1", "400", 100, 200]);

    const update = (pool.query as jest.Mock).mock.calls.find(([sql]) =>
      String(sql).includes("current_allocation = current_allocation -"),
    );
    expect(update).toBeDefined();
    expect(update![1]).toEqual(["1", "400"]);
    expect(broadcast).toHaveBeenCalledWith({
      type: "strategy_withdrawal_requested",
      data: {
        withdrawal_id: "9",
        strategy_id: "1",
        amount: "400",
        claimable_ledger: 200,
      },
    });
  });

  it("records the actual amount on WdrawClaim", async () => {
    await run([
      makeEvent("e1", 100, "WdrawClaim", { actual_amount: 350n }, 9n),
    ]);

    const update = (pool.query as jest.Mock).mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE strategy_withdrawals SET actual_amount"),
    );
    expect(update).toBeDefined();
    expect(update![1]).toEqual(["9", "350", 100]);
    expect(broadcast).toHaveBeenCalledWith({
      type: "strategy_withdrawal_claimed",
      data: { withdrawal_id: "9", actual_amount: "350", ledger: 100 },
    });
  });

  it("does not route strategy topics emitted from the governor contract", async () => {
    const server = {
      getEvents: jest
        .fn()
        .mockResolvedValue({
          events: [
            makeEvent("e1", 100, "StratReg", { adapter: "CADAPTER", token: "CTOKEN" }, 1n, GOVERNOR),
          ],
        }),
    } as unknown as SorobanRpc.Server;

    await processEvents(
      server,
      {
        rpcUrl: "http://fake",
        governorAddress: GOVERNOR,
        treasuryStrategiesAddress: STRATEGIES,
        pollIntervalMs: 1,
      },
      100,
    );

    expect(
      (pool.query as jest.Mock).mock.calls.some(([sql]) =>
        String(sql).includes("treasury_strategies"),
      ),
    ).toBe(false);
    expect(broadcast).not.toHaveBeenCalled();
  });
});
