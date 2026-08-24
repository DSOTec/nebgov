"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { GovernorClient, type TuningRecommendation } from "@nebgov/sdk";
import { xdr } from "@stellar/stellar-sdk";
import { readGovernorConfig } from "../lib/nebgov-env";
import { useWallet } from "../lib/wallet-context";

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function DirectionBadge({ direction }: { direction: "up" | "down" | "unchanged" }) {
  const styles =
    direction === "up"
      ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300"
      : direction === "down"
      ? "bg-rose-50 text-rose-700 dark:bg-rose-900/20 dark:text-rose-300"
      : "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400";
  const label = direction === "up" ? "↑ Up" : direction === "down" ? "↓ Down" : "No change";
  return <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${styles}`}>{label}</span>;
}

export function TuningRecommendationCard({
  recommendation,
}: {
  recommendation: TuningRecommendation;
}) {
  const router = useRouter();
  const { isConnected, publicKey } = useWallet();
  const config = useMemo(() => readGovernorConfig(), []);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const quorumChanged =
    recommendation.recommendedQuorumNumerator !== recommendation.currentQuorumNumerator;
  const thresholdChanged =
    recommendation.recommendedProposalThreshold !== recommendation.currentProposalThreshold;
  const hasChange = quorumChanged || thresholdChanged;

  async function handlePropose() {
    if (!config) return;
    try {
      setSubmitting(true);
      setError(null);
      const governor = new GovernorClient(config);
      const source = publicKey ?? config.governorAddress;
      const currentSettings = await governor.getSettings(source);

      // The recommendation's delta was computed against a prior on-chain
      // snapshot (via the indexer's /config-history). If settings drifted
      // since then, blending the recommended delta onto today's baseline
      // would misrepresent what the recommendation's rationale was based on.
      if (
        currentSettings.quorumNumerator !== recommendation.currentQuorumNumerator ||
        currentSettings.proposalThreshold !== recommendation.currentProposalThreshold
      ) {
        throw new Error(
          `Governor settings have changed on-chain since this recommendation was computed ` +
            `(${new Date(recommendation.computedAt).toLocaleString()}). Refresh recommendations before proposing.`,
        );
      }

      const nextSettings = {
        ...currentSettings,
        quorumNumerator: recommendation.recommendedQuorumNumerator,
        proposalThreshold: recommendation.recommendedProposalThreshold,
      };
      const { target, fnName, calldata } = governor.buildUpdateConfigProposal(nextSettings);
      const encodedArg = xdr.ScVal.fromXDR(Buffer.from(calldata));
      const simulation = await governor.simulateTargetInvocation(source, target, fnName, [encodedArg]);
      if (!simulation.ok) {
        throw new Error(simulation.error ?? "Simulation failed");
      }

      const q = new URLSearchParams({
        step: "2",
        target,
        fnName,
        calldataHex: toHex(calldata),
        from: "governance-tuning",
      });
      router.push(`/propose?${q.toString()}`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Could not build update_config proposal");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Latest recommendation
        </h3>
        <span className="text-xs text-gray-400 dark:text-gray-500">
          {new Date(recommendation.computedAt).toLocaleString()}
        </span>
      </div>

      {error && (
        <p className="rounded-lg border border-rose-200 bg-rose-50 dark:border-rose-900 dark:bg-rose-900/20 p-3 text-sm text-rose-700 dark:text-rose-300">
          {error}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-gray-100 dark:border-gray-800 p-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-200">quorum_numerator</span>
            <DirectionBadge direction={recommendation.rationale.quorumNumerator.direction} />
          </div>
          <p className="font-mono text-sm tabular-nums text-gray-900 dark:text-gray-100">
            {recommendation.currentQuorumNumerator} {"->"} {recommendation.recommendedQuorumNumerator}
          </p>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {recommendation.rationale.quorumNumerator.reason}
          </p>
        </div>

        <div className="rounded-lg border border-gray-100 dark:border-gray-800 p-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-200">proposal_threshold</span>
            <DirectionBadge direction={recommendation.rationale.proposalThreshold.direction} />
          </div>
          <p className="font-mono text-sm tabular-nums text-gray-900 dark:text-gray-100">
            {recommendation.currentProposalThreshold.toString()} {"->"}{" "}
            {recommendation.recommendedProposalThreshold.toString()}
          </p>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {recommendation.rationale.proposalThreshold.reason}
          </p>
        </div>
      </div>

      <p className="text-xs text-gray-400 dark:text-gray-500">
        voting_period: {recommendation.rationale.votingPeriod.reason}
      </p>

      {recommendation.autoProposed ? (
        <p className="text-sm text-indigo-600 dark:text-indigo-300">
          Already submitted on-chain{recommendation.proposalId !== null ? ` as proposal #${recommendation.proposalId}` : ""}.
        </p>
      ) : (
        <button
          type="button"
          onClick={handlePropose}
          disabled={!isConnected || !config || submitting || !hasChange}
          className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting
            ? "Verifying calldata..."
            : !hasChange
            ? "No parameter change to propose"
            : "Propose This Change"}
        </button>
      )}
    </div>
  );
}
