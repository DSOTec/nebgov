"use client";

/**
 * Co-sponsorship drafts list page.
 *
 * Drafts let addresses below the governor's proposal_threshold pool their
 * voting power before a real proposal is created — see the CoSponsorship
 * contract (contracts/co-sponsorship) and CoSponsorshipClient in the SDK.
 */

import Link from "next/link";
import { useActiveDrafts } from "../../hooks/useDraft";
import { Skeleton } from "../../components/ui/Skeleton";
import { useLedgerClock } from "../../lib/hooks/useLedgerClock";
import { getTimerInfo } from "../../lib/utils/ledgerTime";

function formatAddress(address: string): string {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function DraftCardSkeleton() {
  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-xl p-4">
      <Skeleton className="h-4 w-1/3 mb-2" />
      <Skeleton className="h-3 w-2/3 mb-4" />
      <Skeleton className="h-2 w-full" />
    </div>
  );
}

export default function DraftsPage() {
  const { drafts, loading, error } = useActiveDrafts(0, 20);
  const { currentLedger } = useLedgerClock();

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            Co-Sponsorship Drafts
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-300">
            Pool voting power with other addresses to meet the proposal threshold together.
          </p>
        </div>
        <Link
          href="/propose"
          className="px-4 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 text-sm font-medium"
        >
          New Draft
        </Link>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 dark:bg-red-900/20 dark:border-red-800 p-4 text-sm text-red-700 dark:text-red-300 mb-4">
          {error}
        </div>
      )}

      {loading && (
        <div className="space-y-4">
          <DraftCardSkeleton />
          <DraftCardSkeleton />
          <DraftCardSkeleton />
        </div>
      )}

      {!loading && !error && drafts.length === 0 && (
        <div className="text-center py-16 text-gray-500 dark:text-gray-400">
          No active drafts right now.
        </div>
      )}

      {!loading && drafts.length > 0 && (
        <div className="space-y-4">
          {drafts.map((draft) => {
            const isExpired = currentLedger > 0 && draft.expiryLedger <= currentLedger;
            const expiryTimer = getTimerInfo("Expires in", draft.expiryLedger, currentLedger);
            return (
              <Link
                key={draft.id.toString()}
                href={`/drafts/${draft.id.toString()}`}
                className="block border border-gray-200 dark:border-gray-700 rounded-xl p-4 hover:border-indigo-400 dark:hover:border-indigo-500 transition-colors"
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-medium text-gray-900 dark:text-gray-100 flex items-center gap-2">
                    Draft #{draft.id.toString()}
                    {isExpired && (
                      <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                        Expired
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    by {formatAddress(draft.creator)}
                  </span>
                </div>
                <p className="text-sm text-gray-600 dark:text-gray-300 mb-3 line-clamp-2">
                  {draft.description}
                </p>
                <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
                  <span>{draft.coSponsors.length} co-sponsor{draft.coSponsors.length === 1 ? "" : "s"}</span>
                  <span>Total pledged power: {draft.totalPower.toString()}</span>
                </div>
                <div className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                  {isExpired
                    ? `Expired at ledger ${draft.expiryLedger}`
                    : expiryTimer
                      ? `${expiryTimer.label} ${expiryTimer.countdown} (ledger ${draft.expiryLedger})`
                      : `Expires at ledger ${draft.expiryLedger}`}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
