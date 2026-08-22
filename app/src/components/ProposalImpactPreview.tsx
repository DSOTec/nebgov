"use client";

import { AlertTriangle, CheckCircle2, Loader2, XCircle } from "lucide-react";
import type { SimulationResult } from "@nebgov/sdk";
import { TreasuryImpactSummary } from "./TreasuryImpactSummary";

interface Props {
  results: SimulationResult[] | null;
  loading: boolean;
  error: string | null;
}

/**
 * Renders a proposal's simulated per-action impact preview. Reused in both
 * the propose wizard's review step and the live proposal detail page, so
 * voters can re-check impact against current chain state, not just what it
 * looked like at submission time.
 */
export function ProposalImpactPreview({ results, loading, error }: Props) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-gray-500 text-sm py-2">
        <Loader2 className="w-4 h-4 animate-spin" />
        Simulating proposal actions against current chain state...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 text-amber-700 bg-amber-50 dark:bg-amber-950/40 dark:text-amber-400 p-3 rounded-lg text-sm">
        <AlertTriangle className="w-4 h-4 shrink-0" />
        Could not simulate this proposal: {error}
      </div>
    );
  }

  if (!results || results.length === 0) {
    return (
      <p className="text-sm text-gray-500 italic">No on-chain actions to preview.</p>
    );
  }

  const anyActionWouldRevert = results.some((r) => !r.success);

  return (
    <div className="space-y-3">
      {anyActionWouldRevert && (
        <div className="flex items-center gap-2 text-rose-700 bg-rose-50 dark:bg-rose-950/40 dark:text-rose-400 p-3 rounded-lg text-sm font-medium">
          <XCircle className="w-4 h-4 shrink-0" />
          At least one action would fail to execute — this proposal cannot succeed as written.
        </div>
      )}
      <ul className="space-y-3">
        {results.map((result, i) => (
          <li
            key={i}
            className={`p-3 rounded-lg border text-sm ${
              result.success
                ? "border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900"
                : "border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/30"
            }`}
          >
            <div className="flex items-start gap-2">
              {result.success ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
              ) : (
                <XCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-gray-900 dark:text-gray-200 break-words">{result.decodedSummary}</p>
                {!result.success && result.revertReason && (
                  <p className="text-rose-600 text-xs mt-1 font-mono break-words">
                    {result.revertReason}
                  </p>
                )}
                {result.treasuryImpact && (
                  <TreasuryImpactSummary impact={result.treasuryImpact} />
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
