import pool from "../db/pool";

export interface TuningRecommendationRationale {
  /** Human-readable explanation per adjusted field, plus the raw analytics inputs used. */
  quorumNumerator: {
    direction: "up" | "down" | "unchanged";
    reason: string;
  };
  proposalThreshold: {
    direction: "up" | "down" | "unchanged";
    reason: string;
  };
  votingPeriod: {
    direction: "unchanged";
    reason: string;
  };
  inputs: Record<string, unknown>;
}

export interface TuningRecommendation {
  id: number;
  computedAt: string;
  currentQuorumNumerator: number;
  recommendedQuorumNumerator: number;
  currentProposalThreshold: bigint;
  recommendedProposalThreshold: bigint;
  rationale: TuningRecommendationRationale;
  autoProposed: boolean;
  proposalId: bigint | null;
}

function rowToRecommendation(row: Record<string, unknown>): TuningRecommendation {
  return {
    id: Number(row.id),
    computedAt: new Date(row.computed_at as string).toISOString(),
    currentQuorumNumerator: Number(row.current_quorum_numerator),
    recommendedQuorumNumerator: Number(row.recommended_quorum_numerator),
    currentProposalThreshold: BigInt(row.current_proposal_threshold as string),
    recommendedProposalThreshold: BigInt(row.recommended_proposal_threshold as string),
    rationale: row.rationale as TuningRecommendationRationale,
    autoProposed: Boolean(row.auto_proposed),
    proposalId: row.proposal_id === null ? null : BigInt(row.proposal_id as string),
  };
}

export interface NewTuningRecommendation {
  currentQuorumNumerator: number;
  recommendedQuorumNumerator: number;
  currentProposalThreshold: bigint;
  recommendedProposalThreshold: bigint;
  rationale: TuningRecommendationRationale;
  autoProposed: boolean;
  proposalId: bigint | null;
}

export async function insertRecommendation(
  rec: NewTuningRecommendation,
): Promise<TuningRecommendation> {
  const result = await pool.query(
    `INSERT INTO governance_tuning_recommendations
       (current_quorum_numerator, recommended_quorum_numerator,
        current_proposal_threshold, recommended_proposal_threshold,
        rationale, auto_proposed, proposal_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      rec.currentQuorumNumerator,
      rec.recommendedQuorumNumerator,
      rec.currentProposalThreshold.toString(),
      rec.recommendedProposalThreshold.toString(),
      JSON.stringify(rec.rationale),
      rec.autoProposed,
      rec.proposalId === null ? null : rec.proposalId.toString(),
    ],
  );
  return rowToRecommendation(result.rows[0]);
}

export async function getLatestRecommendation(): Promise<TuningRecommendation | null> {
  const result = await pool.query(
    `SELECT * FROM governance_tuning_recommendations ORDER BY computed_at DESC, id DESC LIMIT 1`,
  );
  return result.rows.length === 0 ? null : rowToRecommendation(result.rows[0]);
}

export async function listRecommendations(
  limit: number,
  offset: number,
): Promise<{ recommendations: TuningRecommendation[]; hasMore: boolean }> {
  const result = await pool.query(
    `SELECT * FROM governance_tuning_recommendations
     ORDER BY computed_at DESC, id DESC LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return {
    recommendations: result.rows.map(rowToRecommendation),
    hasMore: result.rows.length === limit,
  };
}
