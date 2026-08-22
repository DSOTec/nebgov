"use client";

import { useCallback, useEffect, useState } from "react";
import { TreasuryStrategiesClient, type IndexedStrategy } from "@nebgov/sdk";
import { readGovernorConfig, readIndexerUrl } from "../lib/nebgov-env";

/** A strategy row merging the indexer's tracked fields with the on-chain
 * config (`maxAllocationBps`/`withdrawalCooldownLedgers`) that isn't
 * emitted in any event, so the indexer alone can't carry it. */
export interface StrategyRow extends IndexedStrategy {
  maxAllocationBps: number;
  withdrawalCooldownLedgers: number;
}

export function buildTreasuryStrategiesClient(): TreasuryStrategiesClient | null {
  const config = readGovernorConfig();
  if (!config || !config.treasuryStrategiesAddress) return null;
  const indexerUrl = readIndexerUrl();
  return new TreasuryStrategiesClient({
    ...config,
    ...(indexerUrl ? { indexerUrl } : {}),
  });
}

interface UseTreasuryStrategiesResult {
  strategies: StrategyRow[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/** List active + inactive strategies for a token, merged with on-chain config. */
export function useTreasuryStrategies(token?: string): UseTreasuryStrategiesResult {
  const [strategies, setStrategies] = useState<StrategyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refetchToken, setRefetchToken] = useState(0);

  const refetch = useCallback(() => setRefetchToken((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      const client = buildTreasuryStrategiesClient();
      if (!client) {
        if (!cancelled) {
          setError("Treasury strategies contract is not configured.");
          setLoading(false);
        }
        return;
      }
      try {
        const indexed = await client.listStrategies({ token, limit: 100 });
        const merged = await Promise.all(
          indexed.map(async (row) => {
            const onChain = await client.getStrategy(row.strategyId);
            return {
              ...row,
              maxAllocationBps: onChain.maxAllocationBps,
              withdrawalCooldownLedgers: onChain.withdrawalCooldownLedgers,
            };
          }),
        );
        if (!cancelled) setStrategies(merged);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load strategies");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [token, refetchToken]);

  return { strategies, loading, error, refetch };
}
