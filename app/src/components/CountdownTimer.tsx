"use client";

import { useState, useEffect } from "react";
import { ledgerToEstimatedDate, formatCountdown, getProposalTimeInfo, type ProposalTimeInfo } from "../lib/utils/ledgerTime";
import { useLedgerClock } from "../lib/hooks/useLedgerClock";

interface CountdownTimerProps {
  state?: string;
  startLedger?: number;
  endLedger?: number;
  vetoWindowCloseLedger?: number;
  queueDeadlineLedger?: number;
  // Overrides for generic use
  label?: string;
  targetLedger?: number;
}

export function CountdownTimer({ 
  state, 
  startLedger, 
  endLedger, 
  vetoWindowCloseLedger,
  queueDeadlineLedger,
  label: labelOverride,
  targetLedger: targetOverride
}: CountdownTimerProps) {
  const { currentLedger, isLoading } = useLedgerClock();
  const [displayText, setDisplayText] = useState<string>("");
  const [label, setLabel] = useState<string>("");
  const [target, setTarget] = useState<number>(0);

  useEffect(() => {
    if (labelOverride && targetOverride) {
      setLabel(labelOverride);
      setTarget(targetOverride);
    } else if (state && startLedger !== undefined && endLedger !== undefined) {
      const timeInfo = getProposalTimeInfo(
        state, 
        startLedger, 
        endLedger, 
        currentLedger, 
        vetoWindowCloseLedger,
        queueDeadlineLedger
      );
      if (timeInfo) {
        setLabel(timeInfo.label);
        setTarget(timeInfo.targetLedger);
      } else {
        setLabel("");
        setTarget(0);
      }
    }
  }, [state, startLedger, endLedger, currentLedger, vetoWindowCloseLedger, queueDeadlineLedger, labelOverride, targetOverride]);

  useEffect(() => {
    if (target === 0 || currentLedger === 0) {
      setDisplayText("");
      return;
    }

    const updateCountdown = () => {
      const estimatedDate = ledgerToEstimatedDate(target, currentLedger);
      setDisplayText(formatCountdown(estimatedDate));
    };

    updateCountdown();
    const interval = setInterval(updateCountdown, 1000);

    return () => clearInterval(interval);
  }, [target, currentLedger]);

  if (isLoading || !displayText) {
    return null;
  }

  return (
    <div className="flex items-center gap-1 text-sm" title={`Target ledger: ${target}`}>
      <span className="text-gray-500">{label}</span>
      <span className="font-medium text-gray-900">{displayText}</span>
      <span className="text-xs text-gray-400 ml-1">(estimated)</span>
    </div>
  );
}
