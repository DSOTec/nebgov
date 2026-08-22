"use client";

interface StrategyPerformanceChartProps {
  points: Array<{ amount: bigint; ledger: number }>;
  label?: string;
}

/** Dependency-free inline-SVG sparkline of a strategy's principal-deposited
 * history, following the same pattern as governance-tuning's
 * `ParticipationTrendChart`. */
export function StrategyPerformanceChart({
  points,
  label = "Principal deposited over time",
}: StrategyPerformanceChartProps) {
  if (!points || points.length < 2) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Not enough deposit history yet to plot a trend.
      </p>
    );
  }

  const values = points.map((p) => Number(p.amount));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const width = 320;
  const height = 80;
  const coords = values
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
      aria-label={label}
    >
      <polyline
        points={coords}
        fill="none"
        className="stroke-indigo-500 dark:stroke-indigo-400"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
