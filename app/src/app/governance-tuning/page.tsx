"use client";

import { useGovernanceTuning } from "../../hooks/useGovernanceTuning";
import { TuningRecommendationCard } from "../../components/TuningRecommendationCard";

function ParticipationTrendChart({ snapshotVotesCast }: { snapshotVotesCast: string[] }) {
  if (!snapshotVotesCast || snapshotVotesCast.length < 2) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Not enough snapshot history yet to plot a trend.
      </p>
    );
  }

  const values = snapshotVotesCast.map((v) => Number(BigInt(v)));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const width = 320;
  const height = 80;
  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * width;
      const y = height - ((v - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full h-20"
      role="img"
      aria-label="Trailing participation trend (cumulative votes cast per snapshot)"
    >
      <polyline
        points={points}
        fill="none"
        className="stroke-indigo-500 dark:stroke-indigo-400"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function GovernanceTuningPage() {
  const { latest, history, loading, error } = useGovernanceTuning();

  const snapshotVotesCast = (latest?.rationale.inputs.snapshotVotesCast as string[] | undefined) ?? [];

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-semibold text-gray-900 dark:text-white">Governance tuning</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Analytics-driven recommendations for quorum and proposal threshold, computed periodically
          from the indexer&apos;s governance analytics. Recommendations are never applied
          automatically by default — review one and submit it as an ordinary proposal.
        </p>
      </div>

      {error && (
        <p className="rounded-xl border border-rose-200 bg-rose-50 dark:border-rose-900 dark:bg-rose-900/20 p-4 text-sm text-rose-700 dark:text-rose-300">
          {error}
        </p>
      )}

      {loading ? (
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-6 text-sm text-gray-500 dark:text-gray-400">
          Loading recommendations...
        </div>
      ) : !latest ? (
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-6 text-sm text-gray-500 dark:text-gray-400">
          No recommendation has been computed yet.
        </div>
      ) : (
        <>
          <TuningRecommendationCard recommendation={latest} />

          <section className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-3">
              Participation trend
            </h2>
            <ParticipationTrendChart snapshotVotesCast={snapshotVotesCast} />
          </section>
        </>
      )}

      <section className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-3">
          Recommendation history
        </h2>
        {history.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">No history yet.</p>
        ) : (
          <ul className="space-y-2">
            {history.map((rec) => (
              <li
                key={rec.id}
                className="rounded-lg border border-gray-100 dark:border-gray-800 p-3 text-sm flex flex-wrap items-center justify-between gap-2"
              >
                <span className="text-gray-500 dark:text-gray-400">
                  {new Date(rec.computedAt).toLocaleString()}
                </span>
                <span className="font-mono text-xs tabular-nums text-gray-700 dark:text-gray-300">
                  quorum {rec.currentQuorumNumerator} → {rec.recommendedQuorumNumerator}, threshold{" "}
                  {rec.currentProposalThreshold.toString()} → {rec.recommendedProposalThreshold.toString()}
                </span>
                {rec.autoProposed && (
                  <span className="px-2 py-0.5 rounded-full bg-indigo-50 dark:bg-indigo-900/20 text-indigo-700 dark:text-indigo-300 text-xs font-semibold">
                    auto-proposed
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
