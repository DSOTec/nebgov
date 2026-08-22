import request from "supertest";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { randomBytes } from "crypto";

// On-chain reads/simulation are mocked here — this suite exercises the
// route layer (validation, response shape, description_hash correlation,
// DB persistence) against a real Postgres instance, same DB-backed
// integration pattern as backend/src/__tests__/signaling-routes.test.ts,
// not RPC connectivity.
jest.mock("../proposal-simulation/simulate", () => ({
  __esModule: true,
  rpcServer: jest.fn(() => ({})),
  getLatestLedger: jest.fn(),
  getProposalActions: jest.fn(),
  simulateActions: jest.fn(),
}));
jest.mock("../proposal-simulation/decode", () => ({
  __esModule: true,
  decodeAction: jest.fn(),
}));
jest.mock("../proposal-simulation/treasury-impact", () => ({
  __esModule: true,
  computeTreasuryImpact: jest.fn(),
}));

import app from "../index";
import pool from "../db/pool";
import {
  getLatestLedger,
  getProposalActions,
  simulateActions,
} from "../proposal-simulation/simulate";
import { decodeAction } from "../proposal-simulation/decode";

const mockGetLatestLedger = getLatestLedger as jest.Mock;
const mockGetProposalActions = getProposalActions as jest.Mock;
const mockSimulateActions = simulateActions as jest.Mock;
const mockDecodeAction = decodeAction as jest.Mock;

const TARGET = StrKey.encodeContract(randomBytes(32));

describe("Proposal Simulation Endpoints", () => {
  const insertedIds: number[] = [];

  beforeEach(() => {
    // buildSimulationResults() (routes/proposal-simulation.ts, not mocked
    // here) reads this directly and throws if it's unset — RPC-level calls
    // it makes are all covered by the mocks above, so no real account is
    // needed, just a syntactically valid one.
    process.env.PROPOSAL_SIMULATION_ACCOUNT = Keypair.random().publicKey();
  });

  afterEach(async () => {
    delete process.env.PROPOSAL_SIMULATION_ACCOUNT;
    if (insertedIds.length > 0) {
      await pool.query("DELETE FROM proposal_simulations WHERE id = ANY($1::int[])", [insertedIds]);
      insertedIds.length = 0;
    }
    jest.clearAllMocks();
  });

  async function trackInserted(where: string, params: unknown[]) {
    const { rows } = await pool.query(`SELECT id FROM proposal_simulations WHERE ${where}`, params);
    for (const row of rows) insertedIds.push(row.id);
  }

  describe("POST /proposal-simulation/preview", () => {
    it("rejects mismatched-length targets/fnNames/calldatas", async () => {
      const response = await request(app)
        .post("/proposal-simulation/preview")
        .send({ targets: [TARGET], fnNames: ["a", "b"], calldatas: [""] })
        .expect(400);
      expect(response.body).toHaveProperty("errors");
    });

    it("rejects an invalid target address", async () => {
      const response = await request(app)
        .post("/proposal-simulation/preview")
        .send({ targets: ["not-an-address"], fnNames: ["a"], calldatas: [""] })
        .expect(400);
      expect(response.body).toHaveProperty("errors");
    });

    it("simulates each action, persists the run, and returns any_action_would_revert", async () => {
      mockGetLatestLedger.mockResolvedValue(123456);
      mockSimulateActions.mockResolvedValue([
        { success: true, args: ["a"], returnValue: 1 },
        { success: false, args: ["b"], revertReason: "Error(Contract, #5)" },
      ]);
      mockDecodeAction
        .mockResolvedValueOnce("some_fn(a) on " + TARGET)
        .mockResolvedValueOnce("other_fn(b) on " + TARGET);

      const response = await request(app)
        .post("/proposal-simulation/preview")
        .send({
          targets: [TARGET, TARGET],
          fnNames: ["some_fn", "other_fn"],
          calldatas: ["", ""],
          descriptionHash: "deadbeef",
        })
        .expect(200);

      expect(response.body.any_action_would_revert).toBe(true);
      expect(response.body.simulated_at_ledger).toBe(123456);
      expect(response.body.results).toHaveLength(2);
      expect(response.body.results[0]).toMatchObject({ success: true, fn_name: "some_fn" });
      expect(response.body.results[1]).toMatchObject({
        success: false,
        fn_name: "other_fn",
        revert_reason: "Error(Contract, #5)",
      });

      await trackInserted("description_hash = $1", ["deadbeef"]);
      const { rows } = await pool.query(
        "SELECT proposal_id, description_hash, any_action_would_revert FROM proposal_simulations WHERE description_hash = $1",
        ["deadbeef"],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].proposal_id).toBeNull();
      expect(rows[0].any_action_would_revert).toBe(true);
    });
  });

  describe("GET /proposal-simulation/:proposalId", () => {
    it("returns 404 when the proposal doesn't exist on-chain", async () => {
      mockGetProposalActions.mockResolvedValue(null);
      await request(app).get("/proposal-simulation/999999").expect(404);
    });

    it("fetches the proposal's actions, simulates them, and persists proposal_id-scoped results", async () => {
      mockGetLatestLedger.mockResolvedValue(200000);
      mockGetProposalActions.mockResolvedValue({
        targets: [TARGET],
        fnNames: ["update_config"],
        calldatas: [Buffer.alloc(0)],
      });
      mockSimulateActions.mockResolvedValue([{ success: true, args: [], returnValue: null }]);
      mockDecodeAction.mockResolvedValue("update_config(...) on " + TARGET);

      const response = await request(app).get("/proposal-simulation/42").expect(200);

      expect(response.body.proposal_id).toBe("42");
      expect(response.body.any_action_would_revert).toBe(false);
      expect(response.body.results).toHaveLength(1);

      await trackInserted("proposal_id = $1", ["42"]);
      const { rows } = await pool.query(
        "SELECT proposal_id, description_hash FROM proposal_simulations WHERE proposal_id = $1",
        ["42"],
      );
      expect(rows).toHaveLength(1);
      // A proposal-id-scoped simulation isn't correlated to a draft's
      // description_hash — that correlation only applies to preview rows,
      // which is why the two write paths key different columns.
      expect(rows[0].description_hash).toBeNull();
    });
  });

  describe("GET /proposal-simulation/:proposalId/history", () => {
    it("returns only rows scoped to that proposal_id, newest first", async () => {
      await pool.query(
        `INSERT INTO proposal_simulations (proposal_id, simulated_at_ledger, results, any_action_would_revert)
         VALUES ($1, 100, '[]'::jsonb, false), ($1, 200, '[]'::jsonb, true)`,
        ["777"],
      );
      await trackInserted("proposal_id = $1", ["777"]);

      const response = await request(app).get("/proposal-simulation/777/history").expect(200);
      expect(response.body).toHaveLength(2);
      expect(response.body[0].simulated_at_ledger).toBe(200);
      expect(response.body[1].simulated_at_ledger).toBe(100);
    });

    it("does not return a different proposal's rows", async () => {
      await pool.query(
        `INSERT INTO proposal_simulations (proposal_id, simulated_at_ledger, results, any_action_would_revert)
         VALUES ($1, 100, '[]'::jsonb, false)`,
        ["778"],
      );
      await trackInserted("proposal_id = $1", ["778"]);

      const response = await request(app).get("/proposal-simulation/779/history").expect(200);
      expect(response.body).toHaveLength(0);
    });
  });
});
