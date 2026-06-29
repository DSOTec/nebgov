"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
} from "@stellar/stellar-sdk";
import {
  FactoryClient,
  GovernorClient,
  VotesClient,
  ProposalState,
  type Network,
} from "@nebgov/sdk";
import { ExternalLink, Loader2 } from "lucide-react";
import { useGovernorConfig } from "@/hooks/useGovernorConfig";

interface GovernorCardData {
  id: bigint;
  governor: string;
  timelock: string;
  token: string;
  deployer: string;
  tokenName: string | null;
  proposalCount: number;
  activeProposals: number;
  totalDelegates: bigint;
}

const STATE_COLORS: Record<string, string> = {
  Pending: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400",
  Active: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  Succeeded: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  Defeated: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
  Queued: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400",
  Executed: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300",
  Cancelled: "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-500",
  Expired: "bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-400",
};

const NETWORK_PASSPHRASES: Record<Network, string> = {
  mainnet: Networks.PUBLIC,
  testnet: Networks.TESTNET,
  futurenet: Networks.FUTURENET,
};

const RPC_URLS: Record<Network, string> = {
  mainnet: "https://soroban-rpc.mainnet.stellar.gateway.fm",
  testnet: "https://soroban-testnet.stellar.org",
  futurenet: "https://rpc-futurenet.stellar.org",
};

function formatAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-6)}`;
}

function formatVotes(votes: bigint, divisor: number): string {
  const value = Number(votes) / divisor;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  return value.toLocaleString();
}

function GovernorSkeleton() {
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-2xl p-6 animate-pulse">
      <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-48 mb-4" />
      <div className="grid grid-cols-2 gap-4">
        <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded" />
        <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded" />
        <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded" />
        <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded" />
      </div>
    </div>
  );
}

export default function GovernorsPage() {
  const { divisor } = useGovernorConfig();
  const [governors, setGovernors] = useState<GovernorCardData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const envConfig = useMemo(() => {
    const factoryAddress = process.env.NEXT_PUBLIC_FACTORY_ADDRESS;
    const network = (process.env.NEXT_PUBLIC_NETWORK || "testnet") as Network;
    const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL;

    if (!factoryAddress) return null;
    return { factoryAddress, network, rpcUrl };
  }, []);

  useEffect(() => {
    async function loadGovernors() {
      if (!envConfig) {
        setError("Missing environment variable NEXT_PUBLIC_FACTORY_ADDRESS.");
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const factory = new FactoryClient(envConfig);
        const entries = await factory.getAllGovernors();

        const cards = await Promise.all(
          entries.map(async (entry) => {
            const config = {
              governorAddress: entry.governor,
              timelockAddress: entry.timelock,
              votesAddress: entry.token,
              network: envConfig.network,
              ...(envConfig.rpcUrl ? { rpcUrl: envConfig.rpcUrl } : {}),
            };
            const governorClient = new GovernorClient(config);
            const votesClient = new VotesClient(config);

            const proposalCount = Number(await governorClient.proposalCount());
            let activeProposals = 0;
            for (let i = 1; i <= proposalCount; i += 1) {
              const state = await governorClient.getProposalState(BigInt(i));
              if (state === ProposalState.Active) activeProposals += 1;
            }

            let tokenName: string | null = null;
            try {
              const server = new SorobanRpc.Server(envConfig.rpcUrl ?? RPC_URLS[envConfig.network], {
                allowHttp: false,
              });
              const tokenVotesContract = new Contract(entry.token);
              const tokenResult = await server.simulateTransaction(
                new TransactionBuilder(await server.getAccount(entry.token), {
                  fee: BASE_FEE,
                  networkPassphrase: NETWORK_PASSPHRASES[envConfig.network],
                })
                  .addOperation(tokenVotesContract.call("token"))
                  .setTimeout(30)
                  .build(),
              );

              if (!SorobanRpc.Api.isSimulationError(tokenResult)) {
                const tokenAddress = scValToNative(
                  (tokenResult as SorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval,
                ) as string;
                if (tokenAddress) {
                  const underlyingToken = new Contract(tokenAddress);
                  const nameResult = await server.simulateTransaction(
                    new TransactionBuilder(await server.getAccount(tokenAddress), {
                      fee: BASE_FEE,
                      networkPassphrase: NETWORK_PASSPHRASES[envConfig.network],
                    })
                      .addOperation(underlyingToken.call("name"))
                      .setTimeout(30)
                      .build(),
                  );

                  if (!SorobanRpc.Api.isSimulationError(nameResult)) {
                    tokenName = String(
                      scValToNative(
                        (nameResult as SorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval,
                      ),
                    );
                  }
                }
              }
            } catch {
              tokenName = null;
            }

            const latestLedger = await governorClient.getLatestLedger();
            const totalDelegates = await votesClient.getPastTotalSupply(latestLedger);

            return {
              ...entry,
              tokenName,
              proposalCount,
              activeProposals,
              totalDelegates,
            };
          }),
        );

        setGovernors(cards);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load governor registry");
      } finally {
        setLoading(false);
      }
    }

    void loadGovernors();
  }, [envConfig]);

  const stats = useMemo(() => {
    if (governors.length === 0) return null;
    const total = governors.length;
    const mostActive = governors.reduce((prev, current) =>
      current.proposalCount > prev.proposalCount ? current : prev,
    governors[0]);
    const mostRecent = governors.reduce((prev, current) =>
      current.id > prev.id ? current : prev,
    governors[0]);
    return { total, mostActive, mostRecent };
  }, [governors]);

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Governors</h1>
          <p className="mt-2 text-gray-500 dark:text-gray-400 max-w-2xl">
            Browse the on-chain governor factory registry and inspect live governance deployments.
          </p>
        </div>
      </div>

      {error && (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-700 mb-6">
          <p className="font-semibold">Unable to load governors</p>
          <p>{error}</p>
        </div>
      )}

      {loading ? (
        <div className="space-y-4">
          <GovernorSkeleton />
          <GovernorSkeleton />
          <GovernorSkeleton />
        </div>
      ) : governors.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-gray-300 bg-white/80 dark:bg-gray-900/70 p-10 text-center">
          <p className="text-xl font-semibold text-gray-900 dark:text-white">No governors registered yet</p>
          <p className="mt-2 text-gray-500 dark:text-gray-400">
            Deployments through the factory will appear here once the registry is populated.
          </p>
        </div>
      ) : (
        <>
          {stats && (
            <div className="grid gap-4 md:grid-cols-3 mb-8">
              <div className="rounded-2xl border border-gray-200 bg-white p-6">
                <p className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Total governors</p>
                <p className="mt-3 text-3xl font-bold text-gray-900">{stats.total}</p>
              </div>
              <div className="rounded-2xl border border-gray-200 bg-white p-6">
                <p className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Most active governor</p>
                <p className="mt-3 text-base font-semibold text-gray-900 truncate">{formatAddress(stats.mostActive.governor)}</p>
                <p className="mt-1 text-sm text-gray-500">{stats.mostActive.proposalCount} proposals</p>
              </div>
              <div className="rounded-2xl border border-gray-200 bg-white p-6">
                <p className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Most recent deployment</p>
                <p className="mt-3 text-base font-semibold text-gray-900 truncate">{formatAddress(stats.mostRecent.governor)}</p>
                <p className="mt-1 text-sm text-gray-500">ID #{stats.mostRecent.id.toString()}</p>
              </div>
            </div>
          )}

          <div className="space-y-4">
            {governors.map((governor) => (
              <div key={governor.id.toString()} className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm hover:shadow-md transition-shadow">
                <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0">
                    <p className="text-sm text-gray-500">Governor ID #{governor.id.toString()}</p>
                    <h2 className="mt-1 text-xl font-semibold text-gray-900 truncate">{formatAddress(governor.governor)}</h2>
                    <div className="mt-3 grid gap-3 sm:grid-cols-3">
                      <div>
                        <p className="text-xs uppercase tracking-wide text-gray-400">Deployer</p>
                        <p className="mt-1 text-sm font-mono text-gray-700 dark:text-gray-200 truncate">{governor.deployer}</p>
                      </div>
                      <div>
                        <p className="text-xs uppercase tracking-wide text-gray-400">Token</p>
                        <p className="mt-1 text-sm text-gray-700 dark:text-gray-200 truncate">
                          {formatAddress(governor.token)}
                          {governor.tokenName ? ` · ${governor.tokenName}` : ""}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs uppercase tracking-wide text-gray-400">Proposals</p>
                        <p className="mt-1 text-sm font-semibold text-gray-900 dark:text-white">{governor.proposalCount}</p>
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-col gap-3 items-start sm:items-end">
                    <Link
                      href={`https://stellar.expert/explorer/${envConfig?.network === "mainnet" ? "public" : "testnet"}/contract/${governor.governor}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-2 text-sm font-medium text-indigo-600 hover:text-indigo-700"
                    >
                      View contract <ExternalLink className="w-4 h-4" />
                    </Link>
                    <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-semibold text-gray-700">{governor.activeProposals} active</span>
                  </div>
                </div>

                <div className="mt-6 grid gap-4 sm:grid-cols-3">
                  <div className="rounded-2xl bg-gray-50 p-4">
                    <p className="text-xs uppercase tracking-wide text-gray-400">Total delegates</p>
                    <p className="mt-2 text-lg font-semibold text-gray-900">{formatVotes(governor.totalDelegates, divisor)}</p>
                  </div>
                  <div className="rounded-2xl bg-gray-50 p-4">
                    <p className="text-xs uppercase tracking-wide text-gray-400">Timelock</p>
                    <p className="mt-2 text-sm font-mono text-gray-700 dark:text-gray-200 truncate">{governor.timelock}</p>
                  </div>
                  <div className="rounded-2xl bg-gray-50 p-4">
                    <p className="text-xs uppercase tracking-wide text-gray-400">Governor UI</p>
                    <p className="mt-2 text-sm text-gray-700 dark:text-gray-200">Not available</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
