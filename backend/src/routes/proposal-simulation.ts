import { Response, Router } from "express";
import { z } from "zod";
import { Networks, type rpc } from "@stellar/stellar-sdk";
import pool from "../db/pool";
import { validate } from "../middleware/validate";
import { logger } from "../logger";
import {
  getLatestLedger,
  getProposalActions,
  rpcServer,
  simulateActions,
  type ProposalAction,
} from "../proposal-simulation/simulate";
import { decodeAction } from "../proposal-simulation/decode";
import { computeTreasuryImpact } from "../proposal-simulation/treasury-impact";

const router = Router();

const STELLAR_ADDRESS_RE = /^[GC][A-Z2-7]{55}$/;

function networkPassphrase(): string {
  const key = (process.env.STELLAR_NETWORK ?? "testnet").toLowerCase();
  return key === "mainnet" || key === "public" ? Networks.PUBLIC : Networks.TESTNET;
}

export interface SimulationResultDTO {
  target: string;
  fn_name: string;
  success: boolean;
  decoded_summary: string;
  return_value?: unknown;
  revert_reason?: string;
  treasury_impact?: {
    token: string;
    cap_remaining_before: string | null;
    cap_remaining_after: string | null;
  };
}

async function buildSimulationResults(
  server: rpc.Server,
  actions: ProposalAction[],
): Promise<{ results: SimulationResultDTO[]; anyActionWouldRevert: boolean }> {
  const simulationAccount = process.env.PROPOSAL_SIMULATION_ACCOUNT;
  if (!simulationAccount) {
    throw new Error("PROPOSAL_SIMULATION_ACCOUNT must be set to run proposal simulations");
  }
  const treasuryAddress = process.env.TREASURY_CONTRACT_ID;
  const passphrase = networkPassphrase();

  const outcomes = await simulateActions(server, actions);

  const results: SimulationResultDTO[] = [];
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const outcome = outcomes[i];

    const decodedSummary = await decodeAction(
      server,
      simulationAccount,
      passphrase,
      action.target,
      action.fnName,
      outcome.args,
      treasuryAddress,
    );

    const dto: SimulationResultDTO = {
      target: action.target,
      fn_name: action.fnName,
      success: outcome.success,
      decoded_summary: decodedSummary,
      return_value: outcome.returnValue,
      revert_reason: outcome.revertReason,
    };

    // Treasury spending-cap impact is only meaningful for a direct
    // token-moving action with a resolvable (token, amount) pair — see
    // decode.ts's decodeBatchTransfer for the same field extraction.
    if (
      treasuryAddress &&
      action.target === treasuryAddress &&
      action.fnName === "batch_transfer" &&
      outcome.success
    ) {
      const [, token, recipients] = outcome.args as [
        unknown,
        string,
        Array<{ recipient: string; amount: bigint | number | string }>,
      ];
      if (typeof token === "string" && Array.isArray(recipients)) {
        const spendAmount = recipients.reduce(
          (sum, r) => sum + BigInt(r.amount ?? 0),
          0n,
        );
        try {
          const impact = await computeTreasuryImpact(
            server,
            treasuryAddress,
            simulationAccount,
            passphrase,
            token,
            spendAmount,
          );
          dto.treasury_impact = {
            token: impact.token,
            cap_remaining_before: impact.capRemainingBefore?.toString() ?? null,
            cap_remaining_after: impact.capRemainingAfter?.toString() ?? null,
          };
        } catch (err) {
          logger.warn({ err }, "proposal-simulation: treasury impact read failed");
        }
      }
    }

    results.push(dto);
  }

  const anyActionWouldRevert = results.some((r) => !r.success);
  return { results, anyActionWouldRevert };
}

async function persistSimulation(
  proposalId: bigint | null,
  descriptionHash: string | null,
  simulatedAtLedger: number,
  results: SimulationResultDTO[],
  anyActionWouldRevert: boolean,
): Promise<void> {
  await pool.query(
    `INSERT INTO proposal_simulations
       (proposal_id, description_hash, simulated_at_ledger, results, any_action_would_revert)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      proposalId === null ? null : proposalId.toString(),
      descriptionHash,
      simulatedAtLedger,
      JSON.stringify(results),
      anyActionWouldRevert,
    ],
  );
}

const previewSchema = z
  .object({
    targets: z.array(z.string().regex(STELLAR_ADDRESS_RE, "invalid target address")).min(1),
    fnNames: z.array(z.string().min(1)).min(1),
    // base64-encoded XDR of each action's calldata (may be an empty string for a no-arg call).
    calldatas: z.array(z.string()).min(1),
    descriptionHash: z.string().max(64).optional(),
  })
  .refine(
    (b) => b.targets.length === b.fnNames.length && b.targets.length === b.calldatas.length,
    { message: "targets, fnNames, and calldatas must be the same length" },
  );

// POST /proposal-simulation/preview
router.post(
  "/preview",
  validate({ body: previewSchema }),
  async (req, res: Response): Promise<void> => {
    const body = req.body as z.infer<typeof previewSchema>;
    try {
      const actions: ProposalAction[] = body.targets.map((target, i) => ({
        target,
        fnName: body.fnNames[i],
        calldata: Buffer.from(body.calldatas[i] ?? "", "base64"),
      }));

      const server = rpcServer();
      const [ledger, { results, anyActionWouldRevert }] = await Promise.all([
        getLatestLedger(server),
        buildSimulationResults(server, actions),
      ]);

      await persistSimulation(
        null,
        body.descriptionHash ?? null,
        ledger,
        results,
        anyActionWouldRevert,
      );

      res.json({
        results,
        any_action_would_revert: anyActionWouldRevert,
        simulated_at_ledger: ledger,
      });
    } catch (err) {
      logger.error({ err }, "proposal-simulation: preview failed");
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

const proposalIdParamSchema = z.object({
  proposalId: z.coerce.bigint().nonnegative(),
});

// GET /proposal-simulation/:proposalId
router.get(
  "/:proposalId",
  validate({ params: proposalIdParamSchema }),
  async (req, res: Response): Promise<void> => {
    const { proposalId } = req.params as unknown as z.infer<typeof proposalIdParamSchema>;
    try {
      const server = rpcServer();
      const proposal = await getProposalActions(server, proposalId);
      if (!proposal) {
        res.status(404).json({ error: "Proposal not found" });
        return;
      }

      const actions: ProposalAction[] = proposal.targets.map((target, i) => ({
        target,
        fnName: proposal.fnNames[i],
        calldata: proposal.calldatas[i],
      }));

      const [ledger, { results, anyActionWouldRevert }] = await Promise.all([
        getLatestLedger(server),
        buildSimulationResults(server, actions),
      ]);

      await persistSimulation(proposalId, null, ledger, results, anyActionWouldRevert);

      res.json({
        proposal_id: proposalId.toString(),
        results,
        any_action_would_revert: anyActionWouldRevert,
        simulated_at_ledger: ledger,
      });
    } catch (err) {
      logger.error({ err, proposalId: proposalId.toString() }, "proposal-simulation: simulate failed");
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

// GET /proposal-simulation/:proposalId/history
router.get(
  "/:proposalId/history",
  validate({ params: proposalIdParamSchema, query: historyQuerySchema }),
  async (req, res: Response): Promise<void> => {
    const { proposalId } = req.params as unknown as z.infer<typeof proposalIdParamSchema>;
    const { limit } = req.query as unknown as z.infer<typeof historyQuerySchema>;
    try {
      const { rows } = await pool.query(
        // Ties on simulated_at are real: two simulations persisted within
        // the same clock tick (or, in tests, the same INSERT statement's
        // single NOW() evaluation) would otherwise sort arbitrarily —
        // `id DESC` as a tiebreaker keeps "newest first" well-defined.
        `SELECT simulated_at, simulated_at_ledger, results, any_action_would_revert
         FROM proposal_simulations
         WHERE proposal_id = $1
         ORDER BY simulated_at DESC, id DESC
         LIMIT $2`,
        [proposalId.toString(), limit],
      );
      res.json(
        rows.map((row) => ({
          simulated_at: row.simulated_at,
          simulated_at_ledger: row.simulated_at_ledger,
          results: row.results,
          any_action_would_revert: row.any_action_would_revert,
        })),
      );
    } catch (err) {
      logger.error({ err }, "proposal-simulation: history fetch failed");
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

export default router;
