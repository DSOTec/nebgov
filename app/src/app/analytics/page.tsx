"use client";

import React from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  CartesianGrid,
  Legend,
} from "recharts";
import { useTheme } from "../../hooks/useTheme";
import { useEffect, useMemo, useState } from "react";
import { Network, VotesClient } from "@nebgov/sdk";
import { Skeleton } from "../../components/ui/Skeleton";

const COLORS = ["#60a5fa", "#34d399", "#f97316", "#f87171", "#a78bfa"];

type TimeRange = "7d" | "30d" | "all";

export default function AnalyticsPage() {
  const { theme } = useTheme();
  const isDark = theme === "dark";
  const [timeRange, setTimeRange] = useState<TimeRange>("30d");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [proposals, setProposals] = useState<any[]>([]);
  const [topDelegates, setTopDelegates] = useState<
    Array<{ name: string; votes: number }>
  >([]);
  const [summary, setSummary] = useState<{
    totalProposals: number;
    totalUniqueVoters: number;
    averageVotesPerProposal: number;
    mostActiveProposers: Array<{ proposer: string; count: number }>;
    outcomes: { executed: number; cancelled: number; queued: number };
  } | null>(null);
  const [stats, setStats] = useState<{
    total_proposals: number;
    active_proposals: number;
    total_votes_cast: number;
    unique_voters: number;
    total_delegates: number;
    participation_rate: number;
    last_updated: string;
  } | null>(null);
  const [totalSupply, setTotalSupply] = useState<bigint>(0n);

  const chartTheme = {
    textColor: isDark ? "#94a3b8" : "#64748b",
    gridColor: isDark ? "#374151" : "#e5e7eb",
    tooltipBg: isDark ? "#1f2937" : "#ffffff",
    tooltipBorder: isDark ? "#374151" : "#e5e7eb",
  };

  useEffect(() => {
    let cancelled = false;

    async function fetchAll() {
      setLoading(true);
      setError(null);
      try {
        const indexerUrl = process.env.NEXT_PUBLIC_INDEXER_URL;
        const governorAddress = process.env.NEXT_PUBLIC_GOVERNOR_ADDRESS;
        const timelockAddress = process.env.NEXT_PUBLIC_TIMELOCK_ADDRESS;
        const votesAddress = process.env.NEXT_PUBLIC_VOTES_ADDRESS;
        const network = (process.env.NEXT_PUBLIC_NETWORK ||
          "testnet") as Network;
        const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL;

        if (!indexerUrl) {
          throw new Error(
            "Missing NEXT_PUBLIC_INDEXER_URL. Analytics requires the indexer API.",
          );
        }
        if (!governorAddress || !timelockAddress || !votesAddress) {
          throw new Error(
            "Missing required environment variables. Please check .env.local configuration.",
          );
        }

        const votesClient = new VotesClient({
          governorAddress,
          timelockAddress,
          votesAddress,
          network,
          ...(rpcUrl && { rpcUrl }),
        });

        const [summaryResp, delegatesResp, statsResp, supply] =
          await Promise.all([
            fetch(`${indexerUrl}/analytics/summary`, { cache: "no-store" }),
            fetch(`${indexerUrl}/delegates?top=10`, { cache: "no-store" }),
            fetch(`${indexerUrl}/stats`, { cache: "no-store" }),
            votesClient.getTotalSupply(),
          ]);

        if (!summaryResp.ok)
          throw new Error(`Indexer error: ${summaryResp.status}`);
        if (!delegatesResp.ok)
          throw new Error(`Indexer error: ${delegatesResp.status}`);
        if (!statsResp.ok)
          throw new Error(`Indexer error: ${statsResp.status}`);

        const [summaryJson, delegatesJson, statsJson] = await Promise.all([
          summaryResp.json(),
          delegatesResp.json(),
          statsResp.json(),
        ]);

        // Fetch proposals (paginate all-time; stop early for 7d/30d)
        const cutoffMs =
          timeRange === "7d"
            ? Date.now() - 7 * 24 * 60 * 60 * 1000
            : timeRange === "30d"
              ? Date.now() - 30 * 24 * 60 * 60 * 1000
              : 0;

        const collected: any[] = [];
        let before: number | undefined = undefined;
        let safetyPages = 0;
        while (safetyPages < 50) {
          safetyPages += 1;
          const url = new URL(`${indexerUrl}/proposals`);
          url.searchParams.set("limit", "100");
          if (before) url.searchParams.set("before", String(before));
          const resp = await fetch(url.toString(), { cache: "no-store" });
          if (!resp.ok) break;
          const json = await resp.json();
          const batch = Array.isArray(json.proposals) ? json.proposals : [];
          if (batch.length === 0) break;

          for (const p of batch) {
            if (cutoffMs > 0) {
              const createdAt = p.created_at ? Date.parse(p.created_at) : 0;
              if (createdAt && createdAt < cutoffMs) {
                // We've paged back beyond the range; stop.
                safetyPages = 50;
                break;
              }
            }
            collected.push(p);
          }

          before = json.nextCursor;
          if (!json.hasMore || !before) break;
        }

        if (cancelled) return;

        setSummary(summaryJson);
        setStats(statsJson);
        setTopDelegates(
          (delegatesJson.delegates ?? []).map((d: any) => ({
            name: String(d.address ?? "").slice(0, 8) + "…",
            votes: Number(d.delegator_count ?? 0),
          })),
        );
        setProposals(collected);
        setTotalSupply(supply);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load analytics");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchAll();
    return () => {
      cancelled = true;
    };
  }, [timeRange]);

  const participationData = useMemo(() => {
    const supply = totalSupply > 0n ? Number(totalSupply) : 0;
    return proposals
      .slice()
      .reverse()
      .map((p) => {
        const totalVotes =
          Number(p.votes_for ?? 0) +
          Number(p.votes_against ?? 0) +
          Number(p.votes_abstain ?? 0);
        const participation = supply > 0 ? (totalVotes / supply) * 100 : 0;
        const date = p.created_at
          ? new Date(p.created_at).toLocaleDateString()
          : `#${p.id}`;
        return { date, participation: Number(participation.toFixed(2)) };
      });
  }, [proposals, totalSupply]);

  const outcomeData = useMemo(() => {
    const executed = summary?.outcomes.executed ?? 0;
    const cancelled = summary?.outcomes.cancelled ?? 0;
    const queued = summary?.outcomes.queued ?? 0;
    const other = Math.max(
      0,
      (summary?.totalProposals ?? 0) - executed - cancelled - queued,
    );
    return [
      { name: "Executed", value: executed },
      { name: "Cancelled", value: cancelled },
      { name: "Queued", value: queued },
      { name: "Other", value: other },
    ];
  }, [summary]);

  const avgParticipationPct = useMemo(() => {
    if (!summary) return 0;
    if (totalSupply <= 0n) return 0;
    return Number(
      (
        (Number(summary.averageVotesPerProposal) / Number(totalSupply)) *
        100
      ).toFixed(2),
    );
  }, [summary, totalSupply]);

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">
            Analytics
          </h1>
          <p className="text-gray-500 dark:text-gray-400 mt-1">
            Participation and voting trends.
          </p>
        </div>
        <div className="flex gap-3">
          <a
            href="/api/upgrade-history"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
          >
            Upgrade History
          </a>
          <span className="text-gray-400">|</span>
          <a
            href="/api/config-history"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
          >
            Config History
          </a>
        </div>
      </div>

      <div className="flex items-center gap-2 mb-6">
        <button
          onClick={() => setTimeRange("7d")}
          className={`px-3 py-1.5 text-sm rounded-lg border ${
            timeRange === "7d"
              ? "bg-indigo-600 text-white border-indigo-600"
              : "bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 border-gray-200 dark:border-gray-700"
          }`}
        >
          7d
        </button>
        <button
          onClick={() => setTimeRange("30d")}
          className={`px-3 py-1.5 text-sm rounded-lg border ${
            timeRange === "30d"
              ? "bg-indigo-600 text-white border-indigo-600"
              : "bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 border-gray-200 dark:border-gray-700"
          }`}
        >
          30d
        </button>
        <button
          onClick={() => setTimeRange("all")}
          className={`px-3 py-1.5 text-sm rounded-lg border ${
            timeRange === "all"
              ? "bg-indigo-600 text-white border-indigo-600"
              : "bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 border-gray-200 dark:border-gray-700"
          }`}
        >
          all-time
        </button>
      </div>

      {error && (
        <div className="mb-6 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl p-4">
          <p className="text-red-800 dark:text-red-200 font-medium">
            Failed to load analytics
          </p>
          <p className="text-red-700 dark:text-red-300 text-sm mt-1">{error}</p>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Total proposals
          </p>
          {loading ? (
            <Skeleton className="h-7 w-16 mt-2" />
          ) : (
            <p className="text-2xl font-semibold text-gray-900 dark:text-white">
              {stats?.total_proposals ?? summary?.totalProposals ?? 0}
            </p>
          )}
        </div>
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Active proposals
          </p>
          {loading ? (
            <Skeleton className="h-7 w-16 mt-2" />
          ) : (
            <p className="text-2xl font-semibold text-gray-900 dark:text-white">
              {stats?.active_proposals ?? 0}
            </p>
          )}
        </div>
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Unique voters
          </p>
          {loading ? (
            <Skeleton className="h-7 w-20 mt-2" />
          ) : (
            <p className="text-2xl font-semibold text-gray-900 dark:text-white">
              {stats?.unique_voters ?? summary?.totalUniqueVoters ?? 0}
            </p>
          )}
        </div>
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Participation rate
          </p>
          {loading ? (
            <Skeleton className="h-7 w-16 mt-2" />
          ) : (
            <p className="text-2xl font-semibold text-gray-900 dark:text-white">
              {(
                (stats?.participation_rate ?? avgParticipationPct) * 100
              ).toFixed(1)}
              %
            </p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Total votes cast
          </p>
          {loading ? (
            <Skeleton className="h-7 w-16 mt-2" />
          ) : (
            <p className="text-2xl font-semibold text-gray-900 dark:text-white">
              {stats?.total_votes_cast ?? 0}
            </p>
          )}
        </div>
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Total delegates
          </p>
          {loading ? (
            <Skeleton className="h-7 w-16 mt-2" />
          ) : (
            <p className="text-2xl font-semibold text-gray-900 dark:text-white">
              {stats?.total_delegates ?? 0}
            </p>
          )}
        </div>
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Most active proposer
          </p>
          {loading ? (
            <Skeleton className="h-7 w-32 mt-2" />
          ) : (
            <p className="text-sm font-semibold text-gray-900 dark:text-white mt-2">
              {(summary?.mostActiveProposers?.[0]?.proposer ?? "—").slice(
                0,
                10,
              )}
              …
              <span className="text-gray-500 dark:text-gray-400 font-normal">
                {" "}
                ({summary?.mostActiveProposers?.[0]?.count ?? 0})
              </span>
            </p>
          )}
        </div>
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Last updated
          </p>
          {loading ? (
            <Skeleton className="h-7 w-28 mt-2" />
          ) : (
            <p className="text-sm font-semibold text-gray-900 dark:text-white mt-2">
              {stats?.last_updated
                ? new Date(stats.last_updated).toLocaleDateString()
                : "—"}
            </p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-gray-600 dark:text-gray-400 mb-4">
            Participation Over Time
          </h3>
          <div style={{ width: "100%", height: 240 }}>
            <ResponsiveContainer width="100%" height={240}>
              <LineChart
                data={participationData}
                margin={{ top: 5, right: 20, left: 0, bottom: 5 }}
              >
                <XAxis
                  dataKey="date"
                  tick={{ fill: chartTheme.textColor }}
                  axisLine={{ stroke: chartTheme.gridColor }}
                  tickLine={{ stroke: chartTheme.gridColor }}
                />
                <YAxis
                  tick={{ fill: chartTheme.textColor }}
                  axisLine={{ stroke: chartTheme.gridColor }}
                  tickLine={{ stroke: chartTheme.gridColor }}
                  unit="%"
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: chartTheme.tooltipBg,
                    borderColor: chartTheme.tooltipBorder,
                    color: isDark ? "#fff" : "#000",
                  }}
                  itemStyle={{ color: isDark ? "#fff" : "#000" }}
                />
                <Line
                  type="monotone"
                  dataKey="participation"
                  stroke="#6366f1"
                  strokeWidth={2}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-gray-600 dark:text-gray-400 mb-4">
            Proposal Outcomes
          </h3>
          <div style={{ width: "100%", height: 220 }}>
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie
                  data={outcomeData}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={40}
                  outerRadius={80}
                  paddingAngle={4}
                >
                  {outcomeData.map((entry, index) => (
                    <Cell
                      key={`cell-${index}`}
                      fill={COLORS[index % COLORS.length]}
                    />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    backgroundColor: chartTheme.tooltipBg,
                    borderColor: chartTheme.tooltipBorder,
                    color: isDark ? "#fff" : "#000",
                  }}
                  itemStyle={{ color: isDark ? "#fff" : "#000" }}
                />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="lg:col-span-3 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-gray-600 dark:text-gray-400 mb-4">
            Top Delegates (by delegators)
          </h3>
          <div style={{ width: "100%", height: 220 }}>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart
                data={topDelegates}
                layout="vertical"
                margin={{ top: 5, right: 30, left: 50, bottom: 5 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke={chartTheme.gridColor}
                />
                <XAxis
                  type="number"
                  tick={{ fill: chartTheme.textColor }}
                  axisLine={{ stroke: chartTheme.gridColor }}
                  tickLine={{ stroke: chartTheme.gridColor }}
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={120}
                  tick={{ fill: chartTheme.textColor }}
                  axisLine={{ stroke: chartTheme.gridColor }}
                  tickLine={{ stroke: chartTheme.gridColor }}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: chartTheme.tooltipBg,
                    borderColor: chartTheme.tooltipBorder,
                    color: isDark ? "#fff" : "#000",
                  }}
                  itemStyle={{ color: isDark ? "#fff" : "#000" }}
                />
                <Bar dataKey="votes" fill="#60a5fa">
                  {topDelegates.map((_, idx) => (
                    <Cell
                      key={`bar-${idx}`}
                      fill={COLORS[idx % COLORS.length]}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}
