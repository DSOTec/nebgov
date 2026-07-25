"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import toast from "react-hot-toast";
import { useWallet } from "../../../lib/wallet-context";
import {
  TreasuryClient,
  type TreasuryBudgetStream,
  type TreasuryBudgetSummary,
} from "../../../lib/treasury-client";
import { StreamCard } from "../../../components/StreamCard";
import { BudgetSummaryCard } from "../../../components/BudgetSummaryCard";
import { CreateStreamModal } from "../../../components/CreateStreamModal";

type StellarNetwork = "mainnet" | "testnet" | "futurenet";

export default function StreamsPage() {
  const { publicKey, signTransaction } = useWallet();
  const [streams, setStreams] = useState<TreasuryBudgetStream[]>([]);
  const [summary, setSummary] = useState<TreasuryBudgetSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [client, setClient] = useState<TreasuryClient | null>(null);

  const network: StellarNetwork = (process.env.NEXT_PUBLIC_NETWORK as StellarNetwork) ?? "testnet";
  const treasuryAddress = process.env.NEXT_PUBLIC_TREASURY_ADDRESS ?? "";
  const tokenAddress = process.env.NEXT_PUBLIC_TREASURY_TOKEN_ADDRESS ?? "";

  const fetchData = useCallback(async () => {
    if (!client || !publicKey) {
      setLoading(false);
      return;
    }
    try {
      const [streamList, budgetSummary] = await Promise.all([
        client.getStreams(publicKey, 0, 50),
        client.getBudgetSummary(publicKey),
      ]);
      setStreams(streamList);
      setSummary(budgetSummary);
      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setStreams([]);
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }, [client, publicKey]);

  useEffect(() => {
    if (!treasuryAddress) return;
    setClient(
      new TreasuryClient({
        network,
        treasuryAddress,
      }),
    );
  }, [treasuryAddress, network]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleSignXdr = async (xdr: string): Promise<string> => {
    return signTransaction(xdr);
  };

  return (
    <div className="max-w-4xl mx-auto p-4">
      <div className="flex items-center justify-between mb-6">
        <div>
          <Link href="/treasury" className="text-xs text-gray-400 hover:text-gray-600">
            ← Back to Treasury
          </Link>
          <h1 className="text-xl font-bold text-gray-900 mt-1">Budget Streams</h1>
        </div>
        {publicKey && (
          <button
            onClick={() => setShowCreate(true)}
            className="bg-indigo-600 text-white rounded-md px-4 py-2 text-sm hover:bg-indigo-700"
          >
            Create Stream
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="md:col-span-1">
          <BudgetSummaryCard summary={summary} />
        </div>
        <div className="md:col-span-2">
          {loading ? (
            <div className="text-center py-8 text-gray-400">Loading streams...</div>
          ) : !publicKey ? (
            <div className="border border-dashed border-gray-200 rounded-lg p-8 text-center">
              <p className="text-sm text-gray-400">Connect your wallet to view streams</p>
            </div>
          ) : error ? (
            <div className="border border-red-200 bg-red-50 rounded-lg p-8 text-center">
              <p className="text-sm text-red-600">Failed to load streams</p>
              <p className="text-xs text-red-500 mt-2">{error}</p>
              <button
                onClick={() => fetchData()}
                className="mt-3 text-red-600 text-sm hover:underline"
              >
                Retry
              </button>
            </div>
          ) : streams.length === 0 ? (
            <div className="border border-dashed border-gray-200 rounded-lg p-8 text-center">
              <p className="text-sm text-gray-400">No budget streams yet</p>
              {publicKey && (
                <button
                  onClick={() => setShowCreate(true)}
                  className="mt-3 text-indigo-600 text-sm hover:underline"
                >
                  Create the first stream
                </button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {streams.map((stream) => (
                <StreamCard key={stream.id.toString()} stream={stream} />
              ))}
            </div>
          )}
        </div>
      </div>

      {showCreate && client && publicKey && (
        <CreateStreamModal
          client={client}
          signerPublicKey={publicKey}
          tokenAddress={tokenAddress}
          signUnsignedXdr={handleSignXdr}
          onClose={() => setShowCreate(false)}
          onCreated={fetchData}
        />
      )}
    </div>
  );
}
