"use client";

import type { TreasuryBudgetSummary } from "../lib/treasury-client";

interface BudgetSummaryCardProps {
  summary: TreasuryBudgetSummary | null;
}

export function BudgetSummaryCard({ summary }: BudgetSummaryCardProps) {
  if (!summary) {
    return (
      <div className="border border-gray-200 rounded-lg p-4">
        <h3 className="text-sm font-semibold text-gray-900 mb-2">Budget Summary</h3>
        <p className="text-xs text-gray-400">No budget data available</p>
      </div>
    );
  }

  return (
    <div className="border border-gray-200 rounded-lg p-4">
      <h3 className="text-sm font-semibold text-gray-900 mb-3">Budget Summary</h3>

      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="bg-gray-50 rounded-md p-2">
          <div className="text-xs text-gray-400">Total Streams</div>
          <div className="text-lg font-bold text-gray-900">{summary.totalStreams}</div>
        </div>
        <div className="bg-emerald-50 rounded-md p-2">
          <div className="text-xs text-gray-400">Active</div>
          <div className="text-lg font-bold text-emerald-700">{summary.activeStreams}</div>
        </div>
      </div>

      {summary.totalAllocatedByToken.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-gray-500">By Token</div>
          {summary.totalAllocatedByToken.map((entry, i) => {
            const spent = summary.totalSpentByToken[i];
            const remaining = summary.totalRemainingByToken[i];
            return (
              <div key={i} className="border-t border-gray-100 pt-2">
                <div className="font-mono text-xs text-gray-600 truncate">{entry.token}</div>
                <div className="flex justify-between text-xs mt-1">
                  <span className="text-gray-400">
                    Allocated: <span className="font-medium text-gray-700">{entry.amount.toString()}</span>
                  </span>
                  <span className="text-gray-400">
                    Spent: <span className="font-medium text-gray-700">{spent?.amount.toString() ?? "0"}</span>
                  </span>
                  <span className="text-gray-400">
                    Remaining: <span className="font-medium text-emerald-600">{remaining?.amount.toString() ?? "0"}</span>
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
