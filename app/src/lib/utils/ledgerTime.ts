const parsedLedgerCloseTime = Number(
  process.env.NEXT_PUBLIC_LEDGER_CLOSE_TIME_SECONDS,
);
const LEDGER_CLOSE_TIME_SECONDS =
  Number.isFinite(parsedLedgerCloseTime) && parsedLedgerCloseTime > 0
    ? parsedLedgerCloseTime
    : 5;

export function ledgerToEstimatedDate(
  targetLedger: number,
  currentLedger: number
): Date {
  const deltaSeconds = (targetLedger - currentLedger) * LEDGER_CLOSE_TIME_SECONDS;
  return new Date(Date.now() + deltaSeconds * 1000);
}

export function formatCountdown(targetDate: Date): string {
  const now = Date.now();
  const diff = targetDate.getTime() - now;

  if (diff <= 0) {
    return "Now";
  }

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    const remainingHours = hours % 24;
    const remainingMinutes = minutes % 60;
    return `${days}d ${remainingHours}h ${remainingMinutes}m`;
  }

  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  }

  if (minutes > 0) {
    return `${minutes}m`;
  }

  return `${seconds}s`;
}

export interface ProposalTimeInfo {
  label: string;
  countdown: string;
  targetLedger: number;
}

export function getProposalTimeInfo(
  state: string,
  startLedger: number,
  endLedger: number,
  currentLedger: number,
  vetoWindowCloseLedger?: number,
  queueDeadlineLedger?: number,
): ProposalTimeInfo | null {
  if (currentLedger === 0) return null;

  if (state === "Pending" && currentLedger < startLedger) {
    return {
      label: "Voting starts in",
      countdown: formatCountdown(ledgerToEstimatedDate(startLedger, currentLedger)),
      targetLedger: startLedger,
    };
  }

  if (state === "Active" && currentLedger <= endLedger) {
    return {
      label: "Voting ends in",
      countdown: formatCountdown(ledgerToEstimatedDate(endLedger, currentLedger)),
      targetLedger: endLedger,
    };
  }

  if (state === "Succeeded" && queueDeadlineLedger && currentLedger < queueDeadlineLedger) {
    return {
      label: "Queue deadline",
      countdown: formatCountdown(ledgerToEstimatedDate(queueDeadlineLedger, currentLedger)),
      targetLedger: queueDeadlineLedger,
    };
  }

  if (state === "Queued" && vetoWindowCloseLedger && currentLedger < vetoWindowCloseLedger) {
    return {
      label: "Veto window closes in",
      countdown: formatCountdown(ledgerToEstimatedDate(vetoWindowCloseLedger, currentLedger)),
      targetLedger: vetoWindowCloseLedger,
    };
  }

  return null;
}

/**
 * Get a specific countdown for a target ledger.
 */
export function getTimerInfo(
  label: string,
  targetLedger: number,
  currentLedger: number
): ProposalTimeInfo | null {
  if (currentLedger === 0 || targetLedger <= currentLedger) return null;
  return {
    label,
    countdown: formatCountdown(ledgerToEstimatedDate(targetLedger, currentLedger)),
    targetLedger,
  };
}
