import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import pool from "../db/pool";
import { validate } from "../middleware/validate";
import { logger } from "../logger";
import { cached, invalidate } from "../cache";
import { verifySignalVote } from "../signaling/signature";
import { computeWeightedTally, getCurrentVotingPower, getProposalThreshold } from "../signaling/tally";

const router = Router();

// computeWeightedTally does one sequential on-chain simulate call per
// distinct voter plus one sequential DB write per vote — expensive on a
// popular poll, and this route is polled every 30s by the frontend
// (app/src/hooks/useSignalingPolls.ts). Cached for a short TTL so repeated
// polls within the window are free; invalidated below the moment a new vote
// is recorded so the tally doesn't look stale to the voter who just cast it.
const RESULTS_CACHE_TTL_MS = Number(process.env.SIGNAL_RESULTS_CACHE_TTL_MS ?? "15000");
const resultsCacheKey = (pollId: number) => `signaling:results:${pollId}`;

// Poll creation and voting are free/gasless — unlike /relayer (which costs
// the relayer real transaction fees and is throttled at 10 req/min), there's
// no natural cost throttle here, so a scoped limiter guards against a public
// write path being used to spam polls or brute-force nonce/signature guesses.
const signalingWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many signaling requests" },
});

// Matches G... (account) strkey addresses — signaling participants sign
// with a real Stellar keypair, so only account addresses are valid here
// (unlike relayer.ts's STELLAR_ADDRESS_RE, which also allows C... contracts).
const STELLAR_ACCOUNT_RE = /^G[A-Z2-7]{55}$/;

const idParamSchema = z.object({ id: z.coerce.number().int().min(1) });

const createPollSchema = z.object({
  creatorAddress: z.string().regex(STELLAR_ACCOUNT_RE, "invalid creator address"),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1),
  choices: z.array(z.string().trim().min(1).max(100)).min(2).max(10),
  snapshotLedger: z.coerce.number().int().positive(),
  startTime: z.coerce.date(),
  endTime: z.coerce.date(),
}).refine((body) => body.endTime > body.startTime, {
  message: "endTime must be after startTime",
  path: ["endTime"],
});

const listPollsSchema = z.object({
  status: z.enum(["active", "closed"]).optional(),
});

const castVoteSchema = z.object({
  choiceIndex: z.coerce.number().int().min(0),
  // Not .trim()'d: nonce is an opaque token folded verbatim into the signed
  // canonical payload (see signaling/signature.ts's canonicalSignalPayload)
  // — trimming it here would verify against different bytes than whatever
  // the client actually signed, silently rejecting any legitimate vote
  // whose nonce (from a future/different client) contains leading or
  // trailing whitespace.
  nonce: z.string().min(1).max(64),
  signature: z.string().trim().min(1),
});

const listVotesSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

function rowToPoll(row: any) {
  return {
    id: row.id,
    creatorAddress: row.creator_address,
    title: row.title,
    description: row.description,
    choices: row.choices,
    snapshotLedger: row.snapshot_ledger,
    startTime: row.start_time,
    endTime: row.end_time,
    finalized: row.finalized,
    resultHash: row.result_hash,
    anchoredTxHash: row.anchored_tx_hash,
    createdAt: row.created_at,
  };
}

// POST /signaling/polls — create a temperature-check poll. The creator must
// currently hold at least the governor's proposal_threshold in voting power
// (the same bar formal proposals use), read live rather than hardcoded.
router.post("/polls", signalingWriteLimiter, validate({ body: createPollSchema }), async (req, res) => {
  const body = req.body as z.infer<typeof createPollSchema>;

  try {
    const [power, threshold] = await Promise.all([
      getCurrentVotingPower(body.creatorAddress),
      getProposalThreshold(),
    ]);
    if (power < threshold) {
      return res.status(403).json({
        error: `Creator voting power (${power}) is below the proposal threshold (${threshold})`,
      });
    }

    const { rows } = await pool.query(
      `INSERT INTO signaling_polls
         (creator_address, title, description, choices, snapshot_ledger, start_time, end_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        body.creatorAddress,
        body.title,
        body.description,
        JSON.stringify(body.choices),
        body.snapshotLedger,
        body.startTime.toISOString(),
        body.endTime.toISOString(),
      ],
    );
    res.status(201).json(rowToPoll(rows[0]));
  } catch (error) {
    logger.error({ err: error }, "Error in POST /signaling/polls");
    res.status(500).json({ error: "Failed to create signaling poll" });
  }
});

// GET /signaling/polls?status=active|closed
router.get("/polls", validate({ query: listPollsSchema }), async (req, res) => {
  const { status } = req.query as unknown as z.infer<typeof listPollsSchema>;

  try {
    let query = `SELECT * FROM signaling_polls`;
    const params: unknown[] = [];
    if (status === "active") {
      query += ` WHERE finalized = FALSE AND end_time > NOW()`;
    } else if (status === "closed") {
      query += ` WHERE finalized = TRUE OR end_time <= NOW()`;
    }
    query += ` ORDER BY created_at DESC`;

    const { rows } = await pool.query(query, params);
    res.json(rows.map(rowToPoll));
  } catch (error) {
    logger.error({ err: error }, "Error in GET /signaling/polls");
    res.status(500).json({ error: "Failed to list signaling polls" });
  }
});

// GET /signaling/polls/:id
router.get("/polls/:id", validate({ params: idParamSchema }), async (req, res) => {
  const { id } = req.params as unknown as z.infer<typeof idParamSchema>;

  try {
    const { rows } = await pool.query(`SELECT * FROM signaling_polls WHERE id = $1`, [id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: "Poll not found" });
    }
    res.json(rowToPoll(rows[0]));
  } catch (error) {
    logger.error({ err: error }, "Error in GET /signaling/polls/:id");
    res.status(500).json({ error: "Failed to fetch signaling poll" });
  }
});

// POST /signaling/polls/:id/vote — gasless: verifies a signed message,
// never a Soroban transaction. Rejects a second vote from the same address
// (see signaling_votes' UNIQUE(poll_id, voter_address) constraint) and
// rejects casting outside [start_time, end_time].
router.post(
  "/polls/:id/vote",
  signalingWriteLimiter,
  validate({ params: idParamSchema, body: castVoteSchema }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParamSchema>;
    const { choiceIndex, nonce, signature } = req.body as z.infer<typeof castVoteSchema>;
    const voterAddress = req.header("X-Voter-Address");

    if (!voterAddress || !STELLAR_ACCOUNT_RE.test(voterAddress)) {
      return res.status(400).json({ error: "Missing or invalid X-Voter-Address header" });
    }

    try {
      const { rows: pollRows } = await pool.query(
        `SELECT * FROM signaling_polls WHERE id = $1`,
        [id],
      );
      if (pollRows.length === 0) {
        return res.status(404).json({ error: "Poll not found" });
      }
      const poll = pollRows[0];

      const now = new Date();
      if (now < new Date(poll.start_time) || now > new Date(poll.end_time)) {
        return res.status(400).json({ error: "Poll is not currently open for voting" });
      }
      if (choiceIndex >= (poll.choices as string[]).length) {
        return res.status(400).json({ error: "choiceIndex is out of range for this poll's choices" });
      }

      const verified = verifySignalVote(
        { pollId: id, choiceIndex, voterAddress, nonce },
        signature,
      );
      if (!verified) {
        return res.status(400).json({ error: "Invalid signature" });
      }

      const { rows } = await pool.query(
        `INSERT INTO signaling_votes (poll_id, voter_address, choice_index, nonce, signature)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (poll_id, voter_address) DO NOTHING
         RETURNING id`,
        [id, voterAddress, choiceIndex, nonce, signature],
      );
      if (rows.length === 0) {
        return res.status(409).json({ error: "This address has already voted in this poll" });
      }

      invalidate(resultsCacheKey(id));
      res.status(201).json({ ok: true });
    } catch (error) {
      logger.error({ err: error }, "Error in POST /signaling/polls/:id/vote");
      res.status(500).json({ error: "Failed to cast signal vote" });
    }
  },
);

// GET /signaling/polls/:id/results — live running tally before
// finalization, the persisted final tally after.
router.get("/polls/:id/results", validate({ params: idParamSchema }), async (req, res) => {
  const { id } = req.params as unknown as z.infer<typeof idParamSchema>;

  try {
    const body = await cached(resultsCacheKey(id), RESULTS_CACHE_TTL_MS, async () => {
      const { rows: pollRows } = await pool.query(
        `SELECT * FROM signaling_polls WHERE id = $1`,
        [id],
      );
      if (pollRows.length === 0) {
        return null;
      }
      const poll = pollRows[0];
      const choices = poll.choices as string[];

      if (poll.finalized) {
        const { rows: voteRows } = await pool.query(
          `SELECT choice_index, voting_power FROM signaling_votes WHERE poll_id = $1`,
          [id],
        );
        const totals = new Array(choices.length).fill(0n) as bigint[];
        for (const row of voteRows) {
          if (row.choice_index >= 0 && row.choice_index < totals.length) {
            totals[row.choice_index] += BigInt(row.voting_power ?? 0);
          }
        }
        const totalWeight = totals.reduce((sum, t) => sum + t, 0n);
        return {
          finalized: true,
          resultHash: poll.result_hash,
          anchoredTxHash: poll.anchored_tx_hash,
          choices,
          totals: totals.map((t) => t.toString()),
          totalVotes: voteRows.length,
          totalWeight: totalWeight.toString(),
        };
      }

      const results = await computeWeightedTally(id, poll.snapshot_ledger, choices);
      return { finalized: false, ...results };
    });

    if (body === null) {
      return res.status(404).json({ error: "Poll not found" });
    }
    res.json(body);
  } catch (error) {
    logger.error({ err: error }, "Error in GET /signaling/polls/:id/results");
    res.status(500).json({ error: "Failed to compute signaling poll results" });
  }
});

// GET /signaling/polls/:id/votes — paginated raw vote list for auditability.
router.get(
  "/polls/:id/votes",
  validate({ params: idParamSchema, query: listVotesSchema }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParamSchema>;
    const { limit, offset } = req.query as unknown as z.infer<typeof listVotesSchema>;

    try {
      const { rows } = await pool.query(
        `SELECT voter_address, choice_index, nonce, signature, voting_power, created_at
         FROM signaling_votes
         WHERE poll_id = $1
         ORDER BY created_at ASC
         LIMIT $2 OFFSET $3`,
        [id, limit, offset],
      );
      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*)::int AS count FROM signaling_votes WHERE poll_id = $1`,
        [id],
      );
      const total = countRows[0]?.count ?? 0;

      res.json({
        votes: rows,
        pagination: { limit, offset, hasMore: offset + rows.length < total },
      });
    } catch (error) {
      logger.error({ err: error }, "Error in GET /signaling/polls/:id/votes");
      res.status(500).json({ error: "Failed to list signaling poll votes" });
    }
  },
);

export default router;
