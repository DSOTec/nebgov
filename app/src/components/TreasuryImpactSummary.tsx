"use client";

import type { SimulationResult } from "@nebgov/sdk";

interface Props {
  impact: NonNullable<SimulationResult["treasuryImpact"]>;
}

/** Before/after spending-cap bar for a treasury-touching action. */
export function TreasuryImpactSummary({ impact }: Props) {
  const before = impact.capRemainingBefore;
  const after = impact.capRemainingAfter;

  if (before === null || after === null) {
    return (
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
        Spending cap: unrestricted for {impact.token}.
      </p>
    );
  }

  const beforeNum = Number(before);
  const afterNum = Number(after);
  const pctBefore = beforeNum <= 0 ? 0 : 100;
  const pctAfter = beforeNum <= 0 ? 0 : Math.max(0, Math.min(100, (afterNum / beforeNum) * 100));
  const overCap = afterNum < 0;

  return (
    <div className="mt-3 text-xs">
      <div className="flex justify-between text-gray-500 dark:text-gray-400 mb-1">
        <span>Spending cap remaining ({impact.token})</span>
        <span className={overCap ? "text-rose-600 font-semibold" : "font-medium"}>
          {before.toString()} → {after.toString()}
        </span>
      </div>
      <div className="relative h-2 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 bg-gray-300 dark:bg-gray-600"
          style={{ width: `${pctBefore}%` }}
        />
        <div
          className={`absolute inset-y-0 left-0 ${overCap ? "bg-rose-500" : "bg-indigo-500"}`}
          style={{ width: `${pctAfter}%` }}
        />
      </div>
      {overCap && (
        <p className="text-rose-600 mt-1">This action would exceed the current period&apos;s spending cap.</p>
      )}
    </div>
  );
}
