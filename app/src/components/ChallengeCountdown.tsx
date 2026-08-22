"use client";

/**
 * Countdown to an optimistic-governance proposal's challenge_end_ledger.
 * Thin wrapper around the existing generic `CountdownTimer` (its
 * label/targetLedger override mode), rather than reimplementing ledger→time
 * estimation — see `lib/utils/ledgerTime.ts`.
 */
import { CountdownTimer } from "./CountdownTimer";

interface ChallengeCountdownProps {
  challengeEndLedger: number;
  isElapsed?: boolean;
}

export function ChallengeCountdown({ challengeEndLedger, isElapsed }: ChallengeCountdownProps) {
  if (isElapsed) {
    return <span className="text-sm text-slate-500">Challenge window closed</span>;
  }
  return (
    <CountdownTimer label="Challenge window closes in" targetLedger={challengeEndLedger} />
  );
}
