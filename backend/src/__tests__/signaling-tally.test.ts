// Fully mocks @stellar/stellar-sdk and ../db/pool so this exercises
// computeWeightedTally's aggregation logic against a controlled set of
// voting powers, without a real RPC endpoint or database — same rationale
// as backend/src/routes/relayer.test.ts's mock.
const mockGetAccount = jest.fn();
const mockSimulateTransaction = jest.fn();

jest.mock("@stellar/stellar-sdk", () => {
  class FakeTransactionBuilder {
    ops: unknown[] = [];
    constructor(_account: unknown, _opts: unknown) {}
    addOperation(op: unknown) {
      this.ops.push(op);
      return this;
    }
    setTimeout() {
      return this;
    }
    build() {
      return { ops: this.ops };
    }
  }

  class FakeServer {
    getAccount(...args: unknown[]) {
      return mockGetAccount(...args);
    }
    simulateTransaction(...args: unknown[]) {
      return mockSimulateTransaction(...args);
    }
  }

  return {
    Contract: class {
      constructor(private id: string) {}
      call(fn: string, ...args: unknown[]) {
        return { fn, args };
      }
    },
    Keypair: {
      fromSecret: () => ({ publicKey: () => "GRELAYERPUBKEY" }),
    },
    Networks: { TESTNET: "testnet", PUBLIC: "public", FUTURENET: "futurenet" },
    BASE_FEE: "100",
    TransactionBuilder: FakeTransactionBuilder,
    nativeToScVal: (v: unknown) => v,
    scValToNative: (v: unknown) => v,
    rpc: {
      Server: FakeServer,
      Api: { isSimulationError: (r: unknown) => (r as { error?: unknown }).error !== undefined },
    },
    xdr: {},
  };
});

const mockQuery = jest.fn();
jest.mock("../db/pool", () => ({
  __esModule: true,
  default: { query: (...args: unknown[]) => mockQuery(...args) },
}));

import { computeWeightedTally } from "../signaling/tally";

const VOTER_HIGH = "GHIGHPOWERVOTERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const VOTER_LOW = "GLOWPOWERVOTERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const VOTER_ZERO = "GZEROPOWERVOTERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const POWER_BY_VOTER: Record<string, bigint> = {
  [VOTER_HIGH]: 1000n,
  [VOTER_LOW]: 250n,
  [VOTER_ZERO]: 0n,
};

describe("computeWeightedTally", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TOKEN_VOTES_CONTRACT_ID = "CVOTESCONTRACT";
    process.env.RELAYER_SECRET_KEY = "SFAKESECRET";
    mockGetAccount.mockResolvedValue({});
    mockSimulateTransaction.mockImplementation(async (tx: { ops: { fn: string; args: unknown[] }[] }) => {
      const op = tx.ops[0];
      const [account] = op.args as [string, number];
      return { result: { retval: POWER_BY_VOTER[account] ?? 0n } };
    });
  });

  it("weights each choice's total by the voter's resolved voting power", async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id, voter_address, choice_index")) {
        return {
          rows: [
            { id: 1, voter_address: VOTER_HIGH, choice_index: 0 },
            { id: 2, voter_address: VOTER_LOW, choice_index: 1 },
          ],
        };
      }
      return { rows: [] };
    });

    const results = await computeWeightedTally(1, 100, ["For", "Against"]);

    expect(results.totals).toEqual(["1000", "250"]);
    expect(results.totalVotes).toBe(2);
    expect(results.totalWeight).toBe("1250");
  });

  it("counts a zero-voting-power vote toward totalVotes but contributes zero weight, rather than dropping it", async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id, voter_address, choice_index")) {
        return {
          rows: [
            { id: 1, voter_address: VOTER_HIGH, choice_index: 0 },
            { id: 2, voter_address: VOTER_ZERO, choice_index: 0 },
          ],
        };
      }
      return { rows: [] };
    });

    const results = await computeWeightedTally(1, 100, ["For", "Against"]);

    expect(results.totalVotes).toBe(2);
    expect(results.totals).toEqual(["1000", "0"]);

    // The zero-power vote must still have been persisted (voting_power = 0),
    // not silently skipped.
    const updateCalls = mockQuery.mock.calls.filter(([sql]) =>
      String(sql).includes("UPDATE signaling_votes SET voting_power"),
    );
    expect(updateCalls).toHaveLength(2);
    expect(updateCalls.some(([, params]) => params[0] === "0" && params[1] === 2)).toBe(true);
  });
});
