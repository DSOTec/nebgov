import type { SignalingPollResults } from "@nebgov/sdk";

interface Props {
  results: SignalingPollResults;
}

/** Weighted-by-voting-power bar chart for a signaling poll's live/final results. No charting library — plain divs. */
export function SignalResultsChart({ results }: Props) {
  const max = results.totals.reduce((m, t) => (t > m ? t : m), 1n);

  return (
    <div className="space-y-3">
      {results.choices.map((choice, i) => {
        const total = results.totals[i] ?? 0n;
        const pct = max > 0n ? Number((total * 1000n) / max) / 10 : 0;
        const share =
          results.totalWeight > 0n ? Number((total * 1000n) / results.totalWeight) / 10 : 0;

        return (
          <div key={choice}>
            <div className="flex items-baseline justify-between text-sm mb-1">
              <span className="font-medium text-gray-900 dark:text-gray-100">{choice}</span>
              <span className="text-gray-500 dark:text-gray-400">
                {total.toString()} ({share}%)
              </span>
            </div>
            <div className="h-3 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
              <div
                className="h-full rounded-full bg-indigo-600 dark:bg-indigo-500 transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      })}
      <p className="text-xs text-gray-500 dark:text-gray-400 pt-1">
        {results.totalVotes} signal{results.totalVotes === 1 ? "" : "s"} · {results.totalWeight.toString()}{" "}
        total weighted power
        {results.finalized ? " · final" : " · live, before finalization"}
      </p>
    </div>
  );
}
