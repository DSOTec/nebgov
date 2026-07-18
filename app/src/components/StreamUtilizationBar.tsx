"use client";

interface StreamUtilizationBarProps {
  utilizationBps: number;
  remaining: bigint;
  total: bigint;
}

export function StreamUtilizationBar({ utilizationBps, remaining, total }: StreamUtilizationBarProps) {
  const percent = utilizationBps / 100;
  const barColor = percent >= 90 ? "bg-red-500" : percent >= 70 ? "bg-amber-500" : "bg-emerald-500";

  return (
    <div className="w-full">
      <div className="flex justify-between text-xs text-gray-500 mb-1">
        <span>Utilization</span>
        <span>{percent.toFixed(1)}%</span>
      </div>
      <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
        <div
          className={`h-full ${barColor} rounded-full transition-all duration-300`}
          style={{ width: `${Math.min(percent, 100)}%` }}
        />
      </div>
      <div className="flex justify-between text-xs text-gray-400 mt-1">
        <span>Remaining: {remaining.toString()}</span>
        <span>Total: {total.toString()}</span>
      </div>
    </div>
  );
}
