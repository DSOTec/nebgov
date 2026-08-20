import { Response, Router } from "express";
import { z } from "zod";
import { isAdmin } from "../middleware/admin";
import { validate } from "../middleware/validate";
import {
  getGovernanceTuningConfig,
  GovernanceTuningConfigValidationError,
  updateGovernanceTuningConfig,
} from "../governance-tuning/config-store";
import {
  getLatestRecommendation,
  listRecommendations,
} from "../governance-tuning/recommendation-store";

const router = Router();

function serializeRecommendation(rec: Awaited<ReturnType<typeof getLatestRecommendation>>) {
  if (!rec) return null;
  return {
    id: rec.id,
    computed_at: rec.computedAt,
    current_quorum_numerator: rec.currentQuorumNumerator,
    recommended_quorum_numerator: rec.recommendedQuorumNumerator,
    current_proposal_threshold: rec.currentProposalThreshold.toString(),
    recommended_proposal_threshold: rec.recommendedProposalThreshold.toString(),
    rationale: rec.rationale,
    auto_proposed: rec.autoProposed,
    proposal_id: rec.proposalId === null ? null : rec.proposalId.toString(),
  };
}

function serializeConfig(config: Awaited<ReturnType<typeof getGovernanceTuningConfig>>) {
  return {
    min_quorum_numerator: config.minQuorumNumerator,
    max_quorum_numerator: config.maxQuorumNumerator,
    max_quorum_delta_bps: config.maxQuorumDeltaBps,
    min_proposal_threshold: config.minProposalThreshold.toString(),
    max_proposal_threshold: config.maxProposalThreshold === null ? null : config.maxProposalThreshold.toString(),
    max_threshold_delta_bps: config.maxThresholdDeltaBps,
    trailing_window: config.trailingWindow,
    interval_ms: config.intervalMs,
    auto_propose: config.autoPropose,
    updated_at: config.updatedAt,
  };
}

// GET /governance-tuning/recommendations?limit=20&offset=0
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

router.get(
  "/recommendations",
  validate({ query: listQuerySchema }),
  async (req, res: Response): Promise<void> => {
    const { limit, offset } = req.query as unknown as z.infer<typeof listQuerySchema>;
    try {
      const { recommendations, hasMore } = await listRecommendations(limit, offset);
      res.json({
        data: recommendations.map(serializeRecommendation),
        pagination: { limit, offset, hasMore },
      });
    } catch {
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// GET /governance-tuning/recommendations/latest
router.get(
  "/recommendations/latest",
  async (_req, res: Response): Promise<void> => {
    try {
      const rec = await getLatestRecommendation();
      res.json(serializeRecommendation(rec));
    } catch {
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// GET /governance-tuning/config
router.get("/config", async (_req, res: Response): Promise<void> => {
  try {
    const config = await getGovernanceTuningConfig();
    res.json(serializeConfig(config));
  } catch {
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /governance-tuning/config — admin-only
const updateConfigSchema = z
  .object({
    min_quorum_numerator: z.number().int().min(0).max(10_000).optional(),
    max_quorum_numerator: z.number().int().min(0).max(10_000).optional(),
    max_quorum_delta_bps: z.number().int().min(0).max(10_000).optional(),
    min_proposal_threshold: z.coerce.bigint().nonnegative().optional(),
    max_proposal_threshold: z.coerce.bigint().nonnegative().nullable().optional(),
    max_threshold_delta_bps: z.number().int().min(0).max(10_000).optional(),
    trailing_window: z.number().int().min(2).max(1000).optional(),
    interval_ms: z.number().int().min(60_000).optional(),
    auto_propose: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "at least one field is required",
  });

router.put(
  "/config",
  isAdmin,
  validate({ body: updateConfigSchema }),
  async (req, res: Response): Promise<void> => {
    const body = req.body as z.infer<typeof updateConfigSchema>;
    try {
      const config = await updateGovernanceTuningConfig({
        minQuorumNumerator: body.min_quorum_numerator,
        maxQuorumNumerator: body.max_quorum_numerator,
        maxQuorumDeltaBps: body.max_quorum_delta_bps,
        minProposalThreshold: body.min_proposal_threshold,
        maxProposalThreshold: body.max_proposal_threshold,
        maxThresholdDeltaBps: body.max_threshold_delta_bps,
        trailingWindow: body.trailing_window,
        intervalMs: body.interval_ms,
        autoPropose: body.auto_propose,
      });
      res.json(serializeConfig(config));
    } catch (err) {
      if (err instanceof GovernanceTuningConfigValidationError) {
        res.status(400).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

export default router;
