"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import toast from "react-hot-toast";
import type { StrategyPerformancePoint, TreasuryStrategiesClient } from "@nebgov/sdk";
import { useWallet } from "../../../lib/wallet-context";
import { readGovernorConfig } from "../../../lib/nebgov-env";
import { TreasuryClient } from "../../../lib/treasury-client";
import { encodeRegisterStrategyCalldata } from "../../../lib/treasury-calldata";
import {
  useTreasuryStrategies,
  buildTreasuryStrategiesClient,
  type StrategyRow,
} from "../../../hooks/useTreasuryStrategies";
import { StrategyPerformanceChart } from "../../../components/StrategyPerformanceChart";
import { WithdrawalRequestModal } from "../../../components/WithdrawalRequestModal";

type StellarNetwork = "mainnet" | "testnet" | "futurenet";

export default function TreasuryStrategiesPage() {
  const { isConnected, publicKey, signTransaction } = useWallet();
  const { strategies, loading, error, refetch } = useTreasuryStrategies();
  const [client] = useState<TreasuryStrategiesClient | null>(() =>
    buildTreasuryStrategiesClient(),
  );
  const [performance, setPerformance] = useState<Record<number, StrategyPerformancePoint[]>>({});
  const [withdrawTarget, setWithdrawTarget] = useState<StrategyRow | null>(null);
  const treasuryAddress = process.env.NEXT_PUBLIC_TREASURY_ADDRESS ?? "";
  const canRequestWithdrawal = Boolean(publicKey && publicKey === treasuryAddress);

  const config = useMemo(() => readGovernorConfig(), []);
  const network = (process.env.NEXT_PUBLIC_NETWORK || "testnet") as StellarNetwork;
  const treasuryAddress = process.env.NEXT_PUBLIC_TREASURY_ADDRESS || "";
  const treasuryStrategiesAddress = config?.treasuryStrategiesAddress ?? "";

  const treasuryClient = useMemo(() => {
    if (!treasuryAddress) return null;
    return new TreasuryClient({ network, treasuryAddress });
  }, [network, treasuryAddress]);

  const [regAdapter, setRegAdapter] = useState("");
  const [regToken, setRegToken] = useState("");
  const [regMaxAllocationBps, setRegMaxAllocationBps] = useState("");
  const [regCooldownLedgers, setRegCooldownLedgers] = useState("");
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);

  const canRegister = Boolean(
    isConnected && publicKey && treasuryClient && treasuryAddress && treasuryStrategiesAddress,
  );

  async function handleRegisterStrategy(e: React.FormEvent) {
    e.preventDefault();
    if (!treasuryClient || !publicKey || !treasuryAddress || !treasuryStrategiesAddress) return;
    setRegistering(true);
    setRegisterError(null);
    try {
      const maxAllocationBps = Number(regMaxAllocationBps);
      const withdrawalCooldownLedgers = Number(regCooldownLedgers);
      if (!regAdapter.trim() || !regToken.trim()) {
        throw new Error("Adapter and token addresses are required.");
      }
      if (!Number.isInteger(maxAllocationBps) || maxAllocationBps < 0 || maxAllocationBps > 10_000) {
        throw new Error("Max allocation must be a whole number of bps between 0 and 10000.");
      }
      if (!Number.isInteger(withdrawalCooldownLedgers) || withdrawalCooldownLedgers < 0) {
        throw new Error("Withdrawal cooldown must be a non-negative whole number of ledgers.");
      }

      const data = encodeRegisterStrategyCalldata(
        treasuryAddress,
        regAdapter.trim(),
        regToken.trim(),
        maxAllocationBps,
        withdrawalCooldownLedgers,
      );
      const txId = await treasuryClient.submit(
        publicKey,
        treasuryStrategiesAddress,
        "register_strategy",
        data,
        signTransaction,
      );
      setRegAdapter("");
      setRegToken("");
      setRegMaxAllocationBps("");
      setRegCooldownLedgers("");
      toast.success(
        txId > 0n
          ? `Submitted treasury transaction #${txId} — pending owner approvals.`
          : "Registration submitted to the treasury — pending owner approvals.",
      );
      refetch();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Could not submit registration";
      setRegisterError(msg);
      toast.error(msg);
    } finally {
      setRegistering(false);
    }
  }

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

      <div className="mb-6 bg-white border border-gray-200 rounded-xl p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-1">
          Register new strategy
        </h2>
        <p className="text-xs text-gray-500 mb-4">
          Admin-only. Submits a treasury multisig transaction that calls{" "}
          <span className="font-mono">register_strategy</span> — it executes once treasury
          owners approve it.
        </p>

        {!isConnected && (
          <p className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900 mb-4">
            Connect a wallet to register a strategy.
          </p>
        )}

        {registerError && (
          <p className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 mb-4">
            {registerError}
          </p>
        )}

        {!treasuryAddress || !treasuryStrategiesAddress ? (
          <p className="text-sm text-gray-500">
            Missing <span className="font-mono">NEXT_PUBLIC_TREASURY_ADDRESS</span> or{" "}
            <span className="font-mono">NEXT_PUBLIC_TREASURY_STRATEGIES_ADDRESS</span> in{" "}
            <span className="font-mono">app/.env.local</span>.
          </p>
        ) : (
          <form onSubmit={handleRegisterStrategy} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-gray-700">Adapter address</span>
                <input
                  type="text"
                  value={regAdapter}
                  disabled={!isConnected}
                  onChange={(e) => setRegAdapter(e.target.value)}
                  placeholder="C…"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm disabled:bg-gray-50 disabled:text-gray-400"
                  required
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-gray-700">Token address</span>
                <input
                  type="text"
                  value={regToken}
                  disabled={!isConnected}
                  onChange={(e) => setRegToken(e.target.value)}
                  placeholder="C…"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm disabled:bg-gray-50 disabled:text-gray-400"
                  required
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-gray-700">
                  Max allocation (bps, 0–10000)
                </span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={regMaxAllocationBps}
                  disabled={!isConnected}
                  onChange={(e) => setRegMaxAllocationBps(e.target.value)}
                  placeholder="2000"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm tabular-nums disabled:bg-gray-50 disabled:text-gray-400"
                  required
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-gray-700">
                  Withdrawal cooldown (ledgers)
                </span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={regCooldownLedgers}
                  disabled={!isConnected}
                  onChange={(e) => setRegCooldownLedgers(e.target.value)}
                  placeholder="17280"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm tabular-nums disabled:bg-gray-50 disabled:text-gray-400"
                  required
                />
              </label>
            </div>

            <button
              type="submit"
              disabled={!canRegister || registering}
              className="w-full sm:w-auto rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {registering ? "Submitting…" : "Submit registration"}
            </button>
          </form>
        )}
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
