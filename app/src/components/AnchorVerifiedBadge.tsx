"use client";

import { useEffect, useState } from "react";
import { SignalingClient } from "@nebgov/sdk";
import { readGovernorConfig } from "../lib/nebgov-env";

interface Props {
  pollId: number;
  /** The poll's `resultHash` as published by the backend — compared against the on-chain anchor. */
  resultHash: string | null;
}

type Status = "loading" | "unanchored" | "verified" | "mismatch" | "unavailable";

/** Shown once `getAnchor()` confirms the backend's published result_hash matches the on-chain anchor. */
export function AnchorVerifiedBadge({ pollId, resultHash }: Props) {
  const [status, setStatus] = useState<Status>("loading");

  useEffect(() => {
    let cancelled = false;
    const config = readGovernorConfig();
    if (!resultHash || !config?.signalAnchorAddress) {
      setStatus("unavailable");
      return;
    }

    const client = new SignalingClient(config);
    client
      .getAnchor(pollId)
      .then((anchor) => {
        if (cancelled) return;
        if (!anchor) {
          setStatus("unanchored");
        } else {
          setStatus(anchor.resultHash === resultHash ? "verified" : "mismatch");
        }
      })
      .catch(() => {
        if (!cancelled) setStatus("unavailable");
      });

    return () => {
      cancelled = true;
    };
  }, [pollId, resultHash]);

  if (status === "loading" || status === "unavailable" || status === "unanchored") return null;

  if (status === "mismatch") {
    return (
      <span
        className="px-2 py-0.5 rounded-full text-xs font-medium bg-rose-100 text-rose-800 border border-rose-200 dark:bg-rose-900/30 dark:text-rose-300 dark:border-rose-800"
        title="The published result hash does not match the on-chain anchor."
      >
        ⚠️ Anchor mismatch
      </span>
    );
  }

  return (
    <span
      className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 border border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-800"
      title="This poll's result hash matches its on-chain anchor — it cannot have been edited after publication."
    >
      ✅ Anchor verified
    </span>
  );
}
