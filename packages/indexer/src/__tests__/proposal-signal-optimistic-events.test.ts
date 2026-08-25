import { nativeToScVal, SorobanRpc, xdr } from "@stellar/stellar-sdk";
import { pool } from "../db";
import { processEvents } from "../events";
import { invalidatePattern } from "../cache";
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

const GOVERNOR_ADDRESS = "CGOVERNOR";
const PROPOSAL_BONDS_ADDRESS = "CPROPOSALBONDS";
const SIGNAL_ANCHOR_ADDRESS = "CSIGNALANCHOR";
const OPTIMISTIC_GOVERNOR_ADDRESS = "COPTIMISTICGOVERNOR";

function toScVal(value: unknown): xdr.ScVal {
  if (Array.isArray(value)) {
    return xdr.ScVal.scvVec(value.map(toScVal));
  }
  return nativeToScVal(value);
}

function makeEvent(
  ledger: number,
  contractId: string,
  eventType: string,
  value: unknown,
  topics: unknown[] = [],
): SorobanRpc.Api.EventResponse {
  return {
    type: "contract",
    ledger,
    contractId,
    txHash: `tx-${ledger}`,
    topic: [
      nativeToScVal(eventType, { type: "symbol" }),
      ...topics.map(toScVal),
    ],
    value: toScVal(value),
  } as unknown as SorobanRpc.Api.EventResponse;
}

describe("proposal-bonds event indexing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (pool.query as jest.Mock).mockResolvedValue({ rows: [] });
  });

  it("routes bond lifecycle events to the proposal-bonds handlers", async () => {
    const descriptionHash = Buffer.from("ab".repeat(32), "hex");
    const proposer = "GPROPOSER";
    const recipient = "GRECIPIENT";
    const events = [
      makeEvent(
        10,
        PROPOSAL_BONDS_ADDRESS,
        "BondLocked",
        [descriptionHash, 100n],
        [proposer],
      ),
      makeEvent(
        11,
        PROPOSAL_BONDS_ADDRESS,
        "BondRefunded",
        [descriptionHash, 100n],
        [proposer],
      ),
      makeEvent(
        12,
        PROPOSAL_BONDS_ADDRESS,
        "BondSlashed",
        [descriptionHash, 100n, recipient],
        [proposer],
      ),
    ];
    const server = {
      getEvents: jest.fn().mockResolvedValue({ events }),
    } as unknown as SorobanRpc.Server;

    const latest = await processEvents(
      server,
      {
        rpcUrl: "http://fake",
        governorAddress: GOVERNOR_ADDRESS,
        proposalBondsAddress: PROPOSAL_BONDS_ADDRESS,
        pollIntervalMs: 1,
      },
      10,
    );

    expect(latest).toBe(12);
    expect(server.getEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [
          {
            type: "contract",
            contractIds: [GOVERNOR_ADDRESS, PROPOSAL_BONDS_ADDRESS],
          },
        ],
      }),
    );
    expect(invalidatePattern).toHaveBeenCalledTimes(3);
    expect(invalidatePattern).toHaveBeenCalledWith("proposal-bonds:");
    expect((broadcast as jest.Mock).mock.calls.map(([event]) => event.type)).toEqual([
      "bond_locked",
      "bond_refunded",
      "bond_slashed",
    ]);
    expect(broadcast).toHaveBeenCalledWith({
      type: "bond_slashed",
      data: {
        description_hash: "ab".repeat(32),
        proposer,
        amount: "100",
        recipient,
        ledger: 12,
      },
    });

    const queries = (pool.query as jest.Mock).mock.calls.map(([sql]) =>
      String(sql),
    );
    expect(queries.filter((sql) => sql.includes("INSERT INTO event_log"))).toHaveLength(
      3,
    );
    expect(
      queries.some((sql) => sql.includes("INSERT INTO proposal_bonds")),
    ).toBe(true);
    expect(
      queries.filter((sql) => sql.includes("UPDATE proposal_bonds")),
    ).toHaveLength(2);
  });
});

describe("signal-anchor event indexing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (pool.query as jest.Mock).mockResolvedValue({ rows: [] });
  });

  it("persists and broadcasts ResultAnchored events", async () => {
    const resultHash = Buffer.from("cd".repeat(32), "hex");
    const anchorer = "GANCHORER";
    const server = {
      getEvents: jest.fn().mockResolvedValue({
        events: [
          makeEvent(
            20,
            SIGNAL_ANCHOR_ADDRESS,
            "ResultAnchored",
            [7n, resultHash, 19],
            [anchorer],
          ),
        ],
      }),
    } as unknown as SorobanRpc.Server;

    const latest = await processEvents(
      server,
      {
        rpcUrl: "http://fake",
        governorAddress: GOVERNOR_ADDRESS,
        signalAnchorAddress: SIGNAL_ANCHOR_ADDRESS,
        pollIntervalMs: 1,
      },
      20,
    );

    expect(latest).toBe(20);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO signal_anchors"),
      ["7", "cd".repeat(32), 19, anchorer, "tx-20"],
    );
    expect(invalidatePattern).toHaveBeenCalledWith("signal-anchors:");
    expect(broadcast).toHaveBeenCalledWith({
      type: "result_anchored",
      data: {
        poll_id: "7",
        result_hash: "cd".repeat(32),
        anchored_ledger: 19,
        anchorer,
      },
    });
  });
});

describe("optimistic-governor event indexing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (pool.query as jest.Mock).mockResolvedValue({ rows: [] });
  });

  it("routes the optimistic governance lifecycle event surface", async () => {
    const proposalId = 42n;
    const events = [
      makeEvent(
        30,
        OPTIMISTIC_GOVERNOR_ADDRESS,
        "ProposalCreated",
        ["GPROPOSER", 1000n],
        [proposalId],
      ),
      makeEvent(
        31,
        OPTIMISTIC_GOVERNOR_ADDRESS,
        "ObjectionCast",
        ["GOBJECTOR", 25n, 25n],
        [proposalId],
      ),
      makeEvent(
        32,
        OPTIMISTIC_GOVERNOR_ADDRESS,
        "ProposalObjected",
        [],
        [proposalId],
      ),
      makeEvent(
        33,
        OPTIMISTIC_GOVERNOR_ADDRESS,
        "ProposalPassed",
        [],
        [proposalId],
      ),
      makeEvent(
        34,
        OPTIMISTIC_GOVERNOR_ADDRESS,
        "ProposalExecuted",
        [],
        [proposalId],
      ),
      makeEvent(
        35,
        OPTIMISTIC_GOVERNOR_ADDRESS,
        "ProposalCancelled",
        [],
        [proposalId],
      ),
    ];
    const server = {
      getEvents: jest.fn().mockResolvedValue({ events }),
    } as unknown as SorobanRpc.Server;

    const latest = await processEvents(
      server,
      {
        rpcUrl: "http://fake",
        governorAddress: GOVERNOR_ADDRESS,
        optimisticGovernorAddress: OPTIMISTIC_GOVERNOR_ADDRESS,
        pollIntervalMs: 1,
      },
      30,
    );

    expect(latest).toBe(35);
    expect((broadcast as jest.Mock).mock.calls.map(([event]) => event.type)).toEqual([
      "optimistic_proposal_created",
      "optimistic_objection_cast",
      "optimistic_proposal_objected",
      "optimistic_proposal_passed",
      "optimistic_proposal_executed",
      "optimistic_proposal_cancelled",
    ]);
    expect(invalidatePattern).toHaveBeenCalledTimes(6);
    expect(invalidatePattern).toHaveBeenCalledWith("optimistic:");

    const queries = (pool.query as jest.Mock).mock.calls.map(([sql]) =>
      String(sql),
    );
    expect(
      queries.some((sql) => sql.includes("INSERT INTO optimistic_proposals")),
    ).toBe(true);
    expect(
      queries.some((sql) => sql.includes("INSERT INTO optimistic_objections")),
    ).toBe(true);
    expect(
      queries.filter((sql) => sql.includes("UPDATE optimistic_proposals")),
    ).toHaveLength(5);
  });
});
