import pool from "../db/pool";

export interface GovernanceTuningConfig {
  minQuorumNumerator: number;
  maxQuorumNumerator: number;
  maxQuorumDeltaBps: number;
  minProposalThreshold: bigint;
  maxProposalThreshold: bigint | null;
  maxThresholdDeltaBps: number;
  trailingWindow: number;
  intervalMs: number;
  autoPropose: boolean;
  updatedAt: string;
}

function rowToConfig(row: Record<string, unknown>): GovernanceTuningConfig {
  return {
    minQuorumNumerator: Number(row.min_quorum_numerator),
    maxQuorumNumerator: Number(row.max_quorum_numerator),
    maxQuorumDeltaBps: Number(row.max_quorum_delta_bps),
    minProposalThreshold: BigInt(row.min_proposal_threshold as string),
    maxProposalThreshold:
      row.max_proposal_threshold === null ? null : BigInt(row.max_proposal_threshold as string),
    maxThresholdDeltaBps: Number(row.max_threshold_delta_bps),
    trailingWindow: Number(row.trailing_window),
    intervalMs: Number(row.interval_ms),
    autoPropose: Boolean(row.auto_propose),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

/** Reads the singleton governance-tuning config row, seeded by migration `009_add_governance_tuning.sql`. */
export async function getGovernanceTuningConfig(): Promise<GovernanceTuningConfig> {
  const result = await pool.query(
    `SELECT * FROM governance_tuning_config WHERE id = 1`,
  );
  if (result.rows.length === 0) {
    throw new Error("governance_tuning_config row is missing — migration 009 did not seed it");
  }
  return rowToConfig(result.rows[0]);
}

export interface GovernanceTuningConfigPatch {
  minQuorumNumerator?: number;
  maxQuorumNumerator?: number;
  maxQuorumDeltaBps?: number;
  minProposalThreshold?: bigint;
  maxProposalThreshold?: bigint | null;
  maxThresholdDeltaBps?: number;
  trailingWindow?: number;
  intervalMs?: number;
  autoPropose?: boolean;
}

const PATCH_COLUMNS: Record<keyof GovernanceTuningConfigPatch, string> = {
  minQuorumNumerator: "min_quorum_numerator",
  maxQuorumNumerator: "max_quorum_numerator",
  maxQuorumDeltaBps: "max_quorum_delta_bps",
  minProposalThreshold: "min_proposal_threshold",
  maxProposalThreshold: "max_proposal_threshold",
  maxThresholdDeltaBps: "max_threshold_delta_bps",
  trailingWindow: "trailing_window",
  intervalMs: "interval_ms",
  autoPropose: "auto_propose",
};

/** Thrown when a patch would leave the config in an internally inconsistent state (e.g. min > max). */
export class GovernanceTuningConfigValidationError extends Error {}

/** Admin-only: updates whichever fields are present in `patch`, leaving the rest unchanged. */
export async function updateGovernanceTuningConfig(
  patch: GovernanceTuningConfigPatch,
): Promise<GovernanceTuningConfig> {
  // Filters out `undefined` explicitly, not just absent keys — callers (e.g.
  // the PUT /governance-tuning/config route) build this object by naming
  // every field, so an unset field arrives as `{ key: undefined }` rather
  // than an absent key, and `Object.keys` would otherwise still report it.
  const keys = (Object.keys(patch) as (keyof GovernanceTuningConfigPatch)[]).filter(
    (key) => patch[key] !== undefined,
  );
  if (keys.length === 0) {
    return getGovernanceTuningConfig();
  }

  // Cross-field validation needs the *effective* post-patch values, not just
  // the fields present in this patch — a PUT that only touches one side of a
  // min/max pair must still be checked against the other side's current value.
  const current = await getGovernanceTuningConfig();
  const effectiveMinQuorum = patch.minQuorumNumerator ?? current.minQuorumNumerator;
  const effectiveMaxQuorum = patch.maxQuorumNumerator ?? current.maxQuorumNumerator;
  if (effectiveMinQuorum > effectiveMaxQuorum) {
    throw new GovernanceTuningConfigValidationError(
      `min_quorum_numerator (${effectiveMinQuorum}) must be <= max_quorum_numerator (${effectiveMaxQuorum})`,
    );
  }

  const effectiveMinThreshold = patch.minProposalThreshold ?? current.minProposalThreshold;
  const effectiveMaxThreshold =
    patch.maxProposalThreshold !== undefined ? patch.maxProposalThreshold : current.maxProposalThreshold;
  if (effectiveMaxThreshold !== null && effectiveMinThreshold > effectiveMaxThreshold) {
    throw new GovernanceTuningConfigValidationError(
      `min_proposal_threshold (${effectiveMinThreshold}) must be <= max_proposal_threshold (${effectiveMaxThreshold})`,
    );
  }

  const setClauses: string[] = [];
  const values: unknown[] = [];
  keys.forEach((key, i) => {
    const value = patch[key];
    setClauses.push(`${PATCH_COLUMNS[key]} = $${i + 1}`);
    values.push(typeof value === "bigint" ? value.toString() : value);
  });
  setClauses.push("updated_at = NOW()");

  const result = await pool.query(
    `UPDATE governance_tuning_config SET ${setClauses.join(", ")} WHERE id = 1 RETURNING *`,
    values,
  );
  return rowToConfig(result.rows[0]);
}
