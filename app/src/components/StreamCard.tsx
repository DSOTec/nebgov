"use client";

import Link from "next/link";
import type { TreasuryBudgetStream } from "../lib/treasury-client";
import { StreamUtilizationBar } from "./StreamUtilizationBar";

interface StreamCardProps {
  stream: TreasuryBudgetStream;
}

export function StreamCard({ stream }: StreamCardProps) {
  const remaining = stream.totalAllocated - stream.totalSpent;
  const utilizationBps = stream.totalAllocated > 0n
    ? Number((stream.totalSpent * 10000n) / stream.totalAllocated)
    : 0;

  const statusColor = stream.isRevoked
    ? "bg-red-100 text-red-700"
    : stream.isActive
      ? "bg-emerald-100 text-emerald-700"
      : "bg-gray-100 text-gray-500";

  const statusLabel = stream.isRevoked
    ? "Revoked"
    : stream.isActive
      ? "Active"
      : "Inactive";

  return (
    <Link href={`/treasury/streams/${stream.id.toString()}`}>
      <div className="border border-gray-200 rounded-lg p-4 hover:shadow-md transition-shadow cursor-pointer">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-gray-900">{stream.name}</h3>
            <span className={`text-xs px-2 py-0.5 rounded-full ${statusColor}`}>
              {statusLabel}
            </span>
          </div>
          <span className="text-xs text-gray-400">#{stream.id.toString()}</span>
        </div>

        <div className="grid grid-cols-2 gap-2 text-xs text-gray-600 mb-3">
          <div>
            <span className="text-gray-400">Owner:</span>
            <div className="font-mono truncate">{stream.owner}</div>
          </div>
          <div>
            <span className="text-gray-400">Spends:</span>
            <span className="font-medium">{stream.spendCount}</span>
          </div>
        </div>

        <StreamUtilizationBar
          utilizationBps={utilizationBps}
          remaining={remaining}
          total={stream.totalAllocated}
        />
      </div>
    </Link>
  );
}
