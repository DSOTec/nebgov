"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { AllTimeStats } from "@nebgov/sdk";
import { Skeleton } from "./ui/Skeleton";

interface ProposalOutcomeBreakdownProps {
  stats: AllTimeStats | null;
  loading?: boolean;
  isDark?: boolean;
}

/**
 * Quorum-hit vs quorum-miss and pass-vs-fail breakdown across every
 * resolved proposal, sourced from the governor's on-chain `AllTimeStats`
 * (issue #765) rather than the legacy indexer-derived outcome pie already
 * on this page.
 */
export function ProposalOutcomeBreakdown({ stats, loading, isDark }: ProposalOutcomeBreakdownProps) {
  if (loading || !stats) {
    return (
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
        <Skeleton className="h-4 w-40 mb-4" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  const totalResolved = stats.quorumHitCount + stats.quorumMissCount;
  const passed = Math.round((stats.passRateBps / 10_000) * Number(totalResolved));
  const failed = Number(totalResolved) - passed;

  const data = [
    { name: "Quorum met", count: Number(stats.quorumHitCount) },
    { name: "Quorum missed", count: Number(stats.quorumMissCount) },
    { name: "Passed", count: passed },
    { name: "Failed", count: Math.max(0, failed) },
  ];

  const textColor = isDark ? "#94a3b8" : "#64748b";
  const gridColor = isDark ? "#374151" : "#e5e7eb";

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
      <h3 className="text-sm font-semibold text-gray-600 dark:text-gray-400 mb-4">
        Quorum &amp; Pass Rate (on-chain, all-time)
      </h3>
      <div style={{ width: "100%", height: 200 }}>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
            <XAxis
              dataKey="name"
              tick={{ fill: textColor, fontSize: 12 }}
              axisLine={{ stroke: gridColor }}
              tickLine={{ stroke: gridColor }}
            />
            <YAxis tick={{ fill: textColor }} axisLine={{ stroke: gridColor }} tickLine={{ stroke: gridColor }} />
            <Tooltip />
            <Bar dataKey="count" fill="#6366f1" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
