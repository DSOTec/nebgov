import request from "supertest";
import express, { Express } from "express";

// --- We don't want real network calls in a unit test, so
// @stellar/stellar-sdk is fully mocked. Only the surface relayer.ts actually
// touches is implemented. (Not `{ virtual: true }`: the package is a real
// dependency here, and virtual-mocking a resolvable module is order-dependent
// on which test file requires the real thing first within the same Jest run
// — `../index` pulls in the real SDK via `security-monitor.ts`, which made
// this mock silently no-op whenever a suite importing `../index` ran first.)
const mockGetAccount = jest.fn();
const mockPrepareTransaction = jest.fn();
const mockSendTransaction = jest.fn();

jest.mock(
  "@stellar/stellar-sdk",
  () => {
    class FakeAuthEntry {
      static fromXDR(base64Xdr: string) {
        // Return the delegator based on the signature (sig1 -> DELEGATOR, sig2 -> DELEGATOR, sig3 -> OTHER_DELEGATOR)
        const address = base64Xdr === "sig3" ? OTHER_DELEGATOR : DELEGATOR;
        return {
          credentials: () => ({
            switch: () => ({ name: "sorobanCredentialsAddress" }),
            address: () => ({
              address: () => ({
                toString: () => address,
              }),
            }),
          }),
        };
      }
    }

    class FakeTransactionBuilder {
      constructor(_account: unknown, _opts: unknown) {}
      addOperation() {
        return this;
      }
      setTimeout() {
        return this;
      }
      build() {
        return {};
      }
    }

    class FakeServer {
      getAccount(...args: unknown[]) {
        return mockGetAccount(...args);
      }
      prepareTransaction(...args: unknown[]) {
        return mockPrepareTransaction(...args);
      }
      sendTransaction(...args: unknown[]) {
        return mockSendTransaction(...args);
      }
    }

    return {
      Contract: class {
        contractId() {
          return "CCONTRACT";
        }
      },
      Keypair: {
        fromSecret: () => ({
          publicKey: () => "GRELAYERPUBKEY",
          sign: () => {},
        }),
      },
      Networks: { TESTNET: "testnet", PUBLIC: "public", FUTURENET: "futurenet" },
      BASE_FEE: "100",
      Operation: { invokeContractFunction: (a: unknown) => a },
      TransactionBuilder: FakeTransactionBuilder,
      nativeToScVal: (v: unknown) => v,
      rpc: { Server: FakeServer },
      xdr: { SorobanAuthorizationEntry: FakeAuthEntry },
    };
  },
);

const mockConnect = jest.fn();
jest.mock("../db/pool", () => ({
  __esModule: true,
  default: {
    connect: (...args: unknown[]) => mockConnect(...args),
    query: jest.fn(),
  },
}));

import relayerRouter from "./relayer";

function createApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/relayer", relayerRouter);
  return app;
}

/**
 * A fake pg PoolClient whose `query` inspects the SQL text to serve BEGIN /
 * advisory-lock / count / insert / COMMIT / ROLLBACK, so the route's
 * transaction logic runs against realistic responses without a real
 * database. `countByDelegator` simulates rows already committed to
 * relayer_permit_log *before* this request started — it deliberately does
 * NOT change as the fake client is queried multiple times in one request,
 * mirroring how the real table looks mid-race before any commit.
 */
function createFakeClient(countByDelegator: Record<string, number>) {
  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [] };
    }
    if (sql.includes("pg_advisory_xact_lock")) {
      return { rows: [] };
    }
    if (sql.includes("SELECT COUNT(*)")) {
      const delegator = params?.[0] as string;
      return { rows: [{ count: String(countByDelegator[delegator] ?? 0) }] };
    }
    if (sql.includes("INSERT INTO relayer_permit_log")) {
      return { rows: [] };
    }
    throw new Error(`createFakeClient: unexpected query ${sql}`);
  });
  return { query, release: jest.fn() };
}

const DELEGATOR = "G" + "A".repeat(55);
const DELEGATEE = "G" + "B".repeat(55);
const OTHER_DELEGATOR = "G" + "D".repeat(55);
const CONTRACT_ID = "C" + "C".repeat(55);

function makePermit(nonce: number, delegator = DELEGATOR) {
  return {
    delegator,
    delegatee: DELEGATEE,
    nonce: String(nonce),
    expiryLedger: 1_000_000,
    chainId: Buffer.from("fake-network-id").toString("base64"),
    contractId: CONTRACT_ID,
  };
}

describe("Relayer API — daily permit-limit race (#822)", () => {
  let app: Express;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RELAYER_SECRET_KEY = "SPLACEHOLDERSECRET";
    process.env.TOKEN_VOTES_CONTRACT_ID = CONTRACT_ID;
    process.env.RELAYER_DAILY_PERMIT_LIMIT = "5";
    mockGetAccount.mockResolvedValue({});
    mockPrepareTransaction.mockResolvedValue({ sign: () => {} });
    mockSendTransaction.mockResolvedValue({ status: "PENDING", hash: "deadbeef" });
    app = createApp();
  });

  describe("POST /relayer/delegate", () => {
    it("rejects when the delegator has already hit the daily limit", async () => {
      const client = createFakeClient({ [DELEGATOR]: 5 });
      mockConnect.mockResolvedValueOnce(client);

      const res = await request(app)
        .post("/relayer/delegate")
        .send({ permit: makePermit(1), signature: "sig" });

      expect(res.status).toBe(429);
      expect(mockSendTransaction).not.toHaveBeenCalled();
      expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    });

    it("submits and logs when under the daily limit", async () => {
      const client = createFakeClient({ [DELEGATOR]: 4 });
      mockConnect.mockResolvedValueOnce(client);

      const res = await request(app)
        .post("/relayer/delegate")
        .send({ permit: makePermit(1), signature: "sig" });

      expect(res.status).toBe(200);
      expect(mockSendTransaction).toHaveBeenCalledTimes(1);
      const insertCall = client.query.mock.calls.find(([sql]) =>
        String(sql).includes("INSERT INTO relayer_permit_log"),
      );
      expect(insertCall).toBeDefined();
      expect(client.query).toHaveBeenCalledWith("COMMIT");
    });
  });

  describe("POST /relayer/delegate-batch", () => {
    it("rejects the whole batch when permits for one delegator would jointly exceed the limit, even though a stale per-permit count would pass each individually", async () => {
      // Only one slot left (4 of 5 used). Two permits for the SAME delegator
      // in one batch: the pre-fix code would call relayedPermitCountToday
      // once per permit and see the same stale count=4 both times, letting
      // both through. The fix must track an in-memory running tally so the
      // second permit sees the first has already "spent" the last slot.
      const client = createFakeClient({ [DELEGATOR]: 4 });
      mockConnect.mockResolvedValueOnce(client);

      const res = await request(app)
        .post("/relayer/delegate-batch")
        .send({
          permits: [makePermit(1), makePermit(2)],
          signatures: ["sig1", "sig2"],
        });

      expect(res.status).toBe(429);
      // Must not have submitted on-chain at all once the tally caught the
      // over-limit permit — otherwise the batch's atomicity would mean both
      // permits still land even though the response says 429.
      expect(mockSendTransaction).not.toHaveBeenCalled();
      expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    });

    it("allows a batch that stays within each delegator's own limit", async () => {
      const client = createFakeClient({ [DELEGATOR]: 2, [OTHER_DELEGATOR]: 0 });
      mockConnect.mockResolvedValueOnce(client);

      const res = await request(app)
        .post("/relayer/delegate-batch")
        .send({
          permits: [
            makePermit(1, DELEGATOR),
            makePermit(2, DELEGATOR),
            makePermit(1, OTHER_DELEGATOR),
          ],
          signatures: ["sig1", "sig2", "sig3"],
        });

      expect(res.status).toBe(200);
      expect(mockSendTransaction).toHaveBeenCalledTimes(1);
      expect(client.query).toHaveBeenCalledWith("COMMIT");
    });
  });
});
