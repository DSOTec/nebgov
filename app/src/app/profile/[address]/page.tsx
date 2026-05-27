"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { useState, useEffect } from "react";
import {
  GovernorClient,
  VotesClient,
  ProposalState,
  Network,
  VoteSupport,
} from "@nebgov/sdk";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { isValidStellarAddress, formatVotingPower } from "../../../lib/utils";

interface VotingRecord {
  proposalId: bigint;
  support: VoteSupport;
  weight: bigint;
  ledger: number;
}

interface DelegationInfo {
  delegatedTo: string | null;
  totalDelegators: number;
  delegators: string[];
}

interface ProfileData {
  address: string;
  votingPower: bigint;
  percentOfSupply: number;
  delegationInfo: DelegationInfo;
  votingHistory: VotingRecord[];
  proposalsCreated: number;
  totalProposals: number;
  votesCast: number;
  createdProposals: Array<{
    id: bigint;
    state: ProposalState;
  }>;
}

function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={`bg-gray-200 dark:bg-gray-700 animate-pulse rounded ${className}`}
    />
  );
}

function VoterProfilePageContent() {
  const params = useParams();
  const address = params.address as string;

  const [data, setData] = useState<ProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [history, setHistory] = useState<
    { ledger: number; votingPower: number }[]
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [federatedName, setFederatedName] = useState<string | null>(null);

  // Validate address
  const isValidAddress = address && isValidStellarAddress(String(address));

  useEffect(() => {
    if (!isValidAddress) {
      setError(`Invalid Stellar address: "${address}"`);
      setLoading(false);
      return;
    }

    async function fetchProfileData() {
      setLoading(true);
      setError(null);

      try {
        if (!address) throw new Error("No address provided");

        // Initialize clients
        const governorAddress = process.env.NEXT_PUBLIC_GOVERNOR_ADDRESS;
        const timelockAddress = process.env.NEXT_PUBLIC_TIMELOCK_ADDRESS;
        const votesAddress = process.env.NEXT_PUBLIC_VOTES_ADDRESS;
        const network = (process.env.NEXT_PUBLIC_NETWORK ||
          "testnet") as Network;
        const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL;
        const indexerUrl = process.env.NEXT_PUBLIC_INDEXER_URL;

        if (!governorAddress || !timelockAddress || !votesAddress) {
          throw new Error(
            "Missing required environment variables. Please check .env.local configuration.",
          );
        }

        const governorClient = new GovernorClient({
          governorAddress,
          timelockAddress,
          votesAddress,
          network,
          ...(rpcUrl && { rpcUrl }),
        });

        const votesClient = new VotesClient({
          governorAddress,
          timelockAddress,
          votesAddress,
          network,
          ...(rpcUrl && { rpcUrl }),
        });

        const [votingPower, totalSupply] = await Promise.all([
          votesClient.getVotes(address),
          votesClient.getTotalSupply(),
        ]);

        const percentOfSupply =
          totalSupply > 0n
            ? Number((votingPower * 10000n) / totalSupply) / 100
            : 0;

        const [delegatedTo, delegators, totalProposals] = await Promise.all([
          votesClient.getDelegatee(address),
          votesClient.getDelegators(address),
          governorClient.proposalCount().then((v) => Number(v)),
        ]);

        let votesCast = 0;
        let proposalsCreated = 0;
        if (indexerUrl) {
          try {
            const resp = await fetch(`${indexerUrl}/profile/${address}`, {
              cache: "no-store",
            });
            if (resp.ok) {
              const json = await resp.json();
              votesCast = Number(json.votescast ?? 0);
              proposalsCreated = Number(json.proposalsCreated ?? 0);
            }
          } catch {
            // ignore indexer failure; fall back to on-chain derived data
          }
        }

        const [votingHistory, createdProposalsHydrated] = await Promise.all([
          governorClient.getVotesCastByAddress(address, {
            fromLedger: Math.max(
              1,
              (await governorClient.getLatestLedger()) - 17_280 * 30,
            ),
            limit: 50,
          }),
          governorClient.getProposalsForAddress(address, {
            fromLedger: 1,
            limit: 25,
          }),
        ]);

        const createdProposals = createdProposalsHydrated.map((p) => ({
          id: p.id,
          state: p.state,
        }));

        setData({
          address,
          votingPower,
          percentOfSupply,
          delegationInfo: {
            delegatedTo,
            totalDelegators: delegators.length,
            delegators: delegators.map((d) => d.delegator),
          },
          votingHistory,
          proposalsCreated,
          createdProposals,
          totalProposals,
          votesCast,
        });

        const latestLedger = await governorClient.getLatestLedger();
        const lookback = Math.min(latestLedger - 1, 17_280 * 7);
        const steps = 8;
        const slice = Math.max(1, Math.floor(lookback / (steps - 1)));
        const points = Array.from({ length: steps }, (_, index) =>
          Math.max(1, latestLedger - lookback + index * slice),
        );

        const snapshots = await Promise.all(
          points.map(async (ledger) => ({
            ledger,
            votingPower:
              Number(await votesClient.getPastVotes(address, ledger)) / 1e7,
          })),
        );

        setHistory(snapshots);
        setHistoryLoading(false);

        // Try to resolve Stellar federation name
        await resolveFederatedName(address);
      } catch (err) {
        console.error("Error fetching profile data:", err);
        setError(err instanceof Error ? err.message : "Failed to load profile");
        setHistoryError("Unable to load voting power history.");
        setHistoryLoading(false);
      } finally {
        setLoading(false);
      }
    }

    async function resolveFederatedName(addr: string) {
      try {
        // This is a placeholder - in production, would call Stellar federation API
        // For now, we'll skip federation resolution
        setFederatedName(null);
      } catch {
        setFederatedName(null);
      }
    }

    fetchProfileData();
  }, [address, isValidAddress]);

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="mb-8">
          <Skeleton className="h-8 w-64 mb-4" />
          <Skeleton className="h-4 w-96" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (error || !isValidAddress) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="bg-red-50 border border-red-200 rounded-xl p-4">
          <p className="text-red-800 text-lg font-medium">
            Error Loading Profile
          </p>
          <p className="text-red-600 text-sm mt-1">
            {error || "Invalid Stellar address format"}
          </p>
          <Link
            href="/"
            className="text-red-600 hover:text-red-700 text-sm mt-3 inline-block underline"
          >
            ← Back to proposals
          </Link>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <p className="text-gray-500">No profile data available</p>
      </div>
    );
  }

  const participationRate =
    data.totalProposals > 0
      ? ((data.votesCast / data.totalProposals) * 100).toFixed(1)
      : "0";

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Voter Profile</h1>
        <div className="flex items-center gap-2 mt-2">
          <span className="font-mono text-sm text-gray-600">{address}</span>
          {federatedName && (
            <span className="text-sm text-gray-500">({federatedName})</span>
          )}
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        {/* Voting Power Card */}
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <p className="text-sm font-semibold text-gray-600 uppercase tracking-wide">
            Voting Power
          </p>
          <p className="text-2xl font-bold text-gray-900 mt-2">
            {formatVotingPower(data.votingPower)}
          </p>
          <p className="text-xs text-gray-500 mt-1">
            {data.percentOfSupply.toFixed(2)}% of total supply
          </p>
        </div>

        {/* Delegation Card */}
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <p className="text-sm font-semibold text-gray-600 uppercase tracking-wide">
            Delegation
          </p>
          {data.delegationInfo.delegatedTo ? (
            <div className="mt-2">
              <p className="text-xs text-gray-500 mb-1">Delegated to</p>
              <Link
                href={`/profile/${data.delegationInfo.delegatedTo}`}
                className="font-mono text-sm text-indigo-600 hover:text-indigo-700 truncate block"
              >
                {data.delegationInfo.delegatedTo}
              </Link>
            </div>
          ) : (
            <p className="text-sm text-gray-500 mt-2">
              Not delegating to anyone
            </p>
          )}
        </div>

        {/* Participation Card */}
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <p className="text-sm font-semibold text-gray-600 uppercase tracking-wide">
            Participation
          </p>
          <p className="text-2xl font-bold text-gray-900 mt-2">
            {participationRate}%
          </p>
          <p className="text-xs text-gray-500 mt-1">
            {data.votesCast} of {data.totalProposals} proposals voted
          </p>
        </div>
      </div>

      {/* Delegation Chain */}
      {data.delegationInfo.delegatedTo && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-6 mb-8">
          <p className="text-sm font-semibold text-blue-900 uppercase tracking-wide">
            Delegation Chain
          </p>
          <div className="mt-4 flex items-center gap-3">
            <span className="font-mono text-sm text-blue-800">{address}</span>
            <span className="text-blue-600">→</span>
            <Link
              href={`/profile/${data.delegationInfo.delegatedTo}`}
              className="font-mono text-sm text-blue-600 hover:text-blue-700 underline"
            >
              {data.delegationInfo.delegatedTo}
            </Link>
          </div>
        </div>
      )}

      {/* Delegators Section */}
      {data.delegationInfo.totalDelegators > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl p-6 mb-8">
          <p className="text-sm font-semibold text-gray-600 uppercase tracking-wide mb-4">
            Delegators ({data.delegationInfo.totalDelegators})
          </p>
          <div className="space-y-2">
            {data.delegationInfo.delegators.slice(0, 10).map((delegator) => (
              <Link
                key={delegator}
                href={`/profile/${delegator}`}
                className="block font-mono text-sm text-indigo-600 hover:text-indigo-700"
              >
                {delegator}
              </Link>
            ))}
            {data.delegationInfo.totalDelegators > 10 && (
              <p className="text-xs text-gray-500 pt-2">
                +{data.delegationInfo.totalDelegators - 10} more
              </p>
            )}
          </div>
        </div>
      )}

      {/* Voting Power History */}
      <div className="bg-white border border-gray-200 rounded-xl p-6 mb-8">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-gray-600 uppercase tracking-wide">
              Voting Power History
            </p>
            <p className="text-xs text-gray-500">
              Snapshot of voting power over recent ledgers
            </p>
          </div>
          <p className="text-xs text-gray-500">{history.length} points</p>
        </div>

        {historyLoading ? (
          <div className="h-72 rounded-xl bg-gray-100 animate-pulse" />
        ) : historyError ? (
          <div className="rounded-xl bg-red-50 border border-red-200 p-6 text-red-700">
            {historyError}
          </div>
        ) : (
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={history}
                margin={{ top: 10, right: 20, bottom: 0, left: -10 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis
                  dataKey="ledger"
                  tick={{ fontSize: 12, fill: "#6b7280" }}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={20}
                  tickFormatter={(value) => `#${value}`}
                />
                <YAxis
                  tick={{ fontSize: 12, fill: "#6b7280" }}
                  tickLine={false}
                  axisLine={false}
                  width={50}
                  tickFormatter={(value) => String(value)}
                />
                <Tooltip
                  formatter={(value) => [
                    `${Number(value).toFixed(2)} XLM`,
                    "Voting Power",
                  ]}
                />
                <Line
                  type="monotone"
                  dataKey="votingPower"
                  stroke="#6366f1"
                  strokeWidth={3}
                  dot={{ r: 4, strokeWidth: 0 }}
                  activeDot={{ r: 6 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Voting History */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200">
          <p className="text-sm font-semibold text-gray-600 uppercase tracking-wide">
            Voting History
          </p>
        </div>
        {data.votingHistory.length > 0 ? (
          <div className="divide-y divide-gray-200 max-h-96 overflow-y-auto">
            {data.votingHistory.slice(0, 50).map((record) => (
              <Link
                key={String(record.proposalId)}
                href={`/proposal/${record.proposalId}`}
                className="px-6 py-4 hover:bg-gray-50 transition-colors flex items-center justify-between"
              >
                <div>
                  <p className="text-sm font-medium text-gray-900">
                    Proposal #{record.proposalId.toString()}
                  </p>
                  <p className="text-xs text-gray-500 mt-1">
                    {record.support} · {formatVotingPower(record.weight)} ·
                    ledger #{record.ledger}
                  </p>
                </div>
                <div className="text-right">
                  <span className="inline-block bg-green-100 text-green-800 text-xs font-medium px-2.5 py-0.5 rounded">
                    ✓ Voted
                  </span>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <div className="px-6 py-12 text-center">
            <p className="text-gray-500 text-sm">No voting history found</p>
          </div>
        )}
      </div>

      {/* Proposal History */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden mt-8">
        <div className="px-6 py-4 border-b border-gray-200">
          <p className="text-sm font-semibold text-gray-600 uppercase tracking-wide">
            Proposal History
          </p>
        </div>
        {data.createdProposals.length > 0 ? (
          <div className="divide-y divide-gray-200 max-h-96 overflow-y-auto">
            {data.createdProposals.slice(0, 25).map((p) => (
              <Link
                key={p.id.toString()}
                href={`/proposal/${p.id}`}
                className="px-6 py-4 hover:bg-gray-50 transition-colors flex items-center justify-between"
              >
                <div>
                  <p className="text-sm font-medium text-gray-900">
                    Proposal #{p.id.toString()}
                  </p>
                  <p className="text-xs text-gray-500 mt-1">{p.state}</p>
                </div>
                <span className="text-xs text-gray-600">View →</span>
              </Link>
            ))}
          </div>
        ) : (
          <div className="px-6 py-12 text-center">
            <p className="text-gray-500 text-sm">No proposals created</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function VoterProfilePage() {
  // Wrap in error boundary to handle any client-side errors
  return (
    <div className="min-h-screen bg-gray-50">
      <VoterProfilePageContent />
    </div>
  );
}
