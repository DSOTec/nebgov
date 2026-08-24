"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { StrategyPerformancePoint, TreasuryStrategiesClient } from "@nebgov/sdk";
import { useWallet } from "../../../lib/wallet-context";
import {
  useTreasuryStrategies,
  buildTreasuryStrategiesClient,
  type StrategyRow,
} from "../../../hooks/useTreasuryStrategies";
import { StrategyPerformanceChart } from "../../../components/StrategyPerformanceChart";
import { WithdrawalRequestModal } from "../../../components/WithdrawalRequestModal";

export default function TreasuryStrategiesPage() {
  const { publicKey, signTransaction } = useWallet();
  const { strategies, loading, error, refetch } = useTreasuryStrategies();
  const [client] = useState<TreasuryStrategiesClient | null>(() =>
    buildTreasuryStrategiesClient(),
  );
  const [performance, setPerformance] = useState<Record<number, StrategyPerformancePoint[]>>({});
  const [withdrawTarget, setWithdrawTarget] = useState<StrategyRow | null>(null);
  const treasuryAddress = process.env.NEXT_PUBLIC_TREASURY_ADDRESS ?? "";
  const canRequestWithdrawal = Boolean(publicKey && publicKey === treasuryAddress);

  useEffect(() => {
    if (!client || strategies.length === 0) return;
    let cancelled = false;
    Promise.all(
      strategies.map(async (s) => {
        try {
          const points = await client.getPerformanceHistory(s.strategyId, 50);
          return [s.strategyId, points] as const;
        } catch {
          return [s.strategyId, []] as const;
        }
      }),
    ).then((entries) => {
      if (!cancelled) setPerformance(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [client, strategies]);

  const handleSignXdr = async (xdr: string): Promise<string> => signTransaction(xdr);

  // Cap headroom is a display estimate: it uses the currently-indexed
  // per-token total across strategies, which can differ slightly from the
  // on-chain `total_after` a pending deposit would actually be checked
  // against (see `deposit`'s cap check in contracts/treasury-strategies).
  const totalsByToken = strategies.reduce<Record<string, bigint>>((acc, s) => {
    acc[s.token] = (acc[s.token] ?? 0n) + s.currentAllocation;
    return acc;
  }, {});

  return (
    <div className="max-w-4xl mx-auto p-4">
      <div className="flex items-center justify-between mb-6">
        <div>
          <Link href="/treasury" className="text-xs text-gray-400 hover:text-gray-600">
            ← Back to Treasury
          </Link>
          <h1 className="text-xl font-bold text-gray-900 mt-1">Treasury Strategies</h1>
          <p className="text-sm text-gray-500 mt-1">
            Governance-whitelisted yield strategies for idle treasury funds.
          </p>
        </div>
      </div>

      {!client && (
        <div className="mb-6 bg-yellow-50 border border-yellow-200 rounded-xl p-4 text-sm text-yellow-800">
          Missing{" "}
          <span className="font-mono">NEXT_PUBLIC_TREASURY_STRATEGIES_ADDRESS</span> in{" "}
          <span className="font-mono">app/.env.local</span>.
        </div>
      )}

      {error && (
        <div className="mb-6 bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-center py-8 text-gray-400">Loading strategies…</div>
      ) : strategies.length === 0 ? (
        <div className="border border-dashed border-gray-200 rounded-lg p-8 text-center">
          <p className="text-sm text-gray-400">No strategies registered yet.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {strategies.map((s) => {
            const tokenTotal = totalsByToken[s.token] ?? 0n;
            const cap = (tokenTotal * BigInt(s.maxAllocationBps)) / 10_000n;
            const headroom = cap > s.currentAllocation ? cap - s.currentAllocation : 0n;

            return (
              <div
                key={s.strategyId}
                className="bg-white border border-gray-200 rounded-xl p-5"
              >
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900">
                      Strategy #{s.strategyId}{" "}
                      {!s.active && (
                        <span className="ml-2 text-xs font-normal text-gray-400 bg-gray-100 rounded-full px-2 py-0.5">
                          Inactive
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-gray-400 font-mono mt-1 break-all">
                      Adapter: {s.adapter}
                    </p>
                    <p className="text-xs text-gray-400 font-mono break-all">
                      Token: {s.token}
                    </p>
                  </div>
                  {canRequestWithdrawal && (
                    <button
                      type="button"
                      onClick={() => setWithdrawTarget(s)}
                      disabled={s.currentAllocation <= 0n}
                      className="shrink-0 text-sm rounded-lg px-4 py-2 font-medium border border-indigo-200 text-indigo-600 hover:bg-indigo-50 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Request Withdrawal
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-4">
                  <div>
                    <p className="text-xs uppercase tracking-wide text-gray-500">
                      Current allocation
                    </p>
                    <p className="mt-1 text-sm text-gray-800">
                      {s.currentAllocation.toString()}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-wide text-gray-500">Max cap</p>
                    <p className="mt-1 text-sm text-gray-800">
                      {(s.maxAllocationBps / 100).toFixed(2)}%
                    </p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-wide text-gray-500">Headroom (est.)</p>
                    <p className="mt-1 text-sm text-gray-800">{headroom.toString()}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-wide text-gray-500">Cooldown</p>
                    <p className="mt-1 text-sm text-gray-800">
                      {s.withdrawalCooldownLedgers} ledgers
                    </p>
                  </div>
                </div>

                <div className="mt-4">
                  <StrategyPerformanceChart
                    points={performance[s.strategyId] ?? []}
                    label={`Strategy #${s.strategyId} principal deposited over time`}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {withdrawTarget && client && publicKey && canRequestWithdrawal && (
        <WithdrawalRequestModal
          client={client}
          strategy={withdrawTarget}
          signerPublicKey={publicKey}
          signUnsignedXdr={handleSignXdr}
          onClose={() => setWithdrawTarget(null)}
          onChanged={refetch}
        />
      )}
    </div>
  );
}
