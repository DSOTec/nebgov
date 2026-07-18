"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import toast from "react-hot-toast";
import { useWallet } from "../../../../lib/wallet-context";
import {
  TreasuryClient,
  type TreasuryBudgetStream,
  type TreasuryStreamSpend,
  type TreasuryStreamReport,
} from "../../../../lib/treasury-client";
import { StreamUtilizationBar } from "../../../../components/StreamUtilizationBar";
import { StreamSpendModal } from "../../../../components/StreamSpendModal";

type StellarNetwork = "mainnet" | "testnet" | "futurenet";

export default function StreamDetailPage() {
  const params = useParams();
  const streamId = Number(params.id);
  const { publicKey, signTransaction } = useWallet();
  const [stream, setStream] = useState<TreasuryBudgetStream | null>(null);
  const [report, setReport] = useState<TreasuryStreamReport | null>(null);
  const [spends, setSpends] = useState<TreasuryStreamSpend[]>([]);
  const [loading, setLoading] = useState(true);
  const [showSpend, setShowSpend] = useState(false);
  const [client, setClient] = useState<TreasuryClient | null>(null);

  const network: StellarNetwork = (process.env.NEXT_PUBLIC_NETWORK as StellarNetwork) ?? "testnet";
  const treasuryAddress = process.env.NEXT_PUBLIC_TREASURY_ADDRESS ?? "";

  const fetchData = useCallback(async () => {
    if (!client || !publicKey) return;
    try {
      const [s, r, sp] = await Promise.all([
        client.getStream(publicKey, streamId),
        client.getStreamReport(publicKey, streamId),
        client.getStreamSpends(publicKey, streamId),
      ]);
      setStream(s);
      setReport(r);
      setSpends(sp);
    } catch {
      toast.error("Failed to load stream data");
    } finally {
      setLoading(false);
    }
  }, [client, publicKey, streamId]);

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

  const handleRevoke = async () => {
    if (!client || !publicKey || !stream) return;
    if (!confirm("Are you sure you want to revoke this stream?")) return;
    try {
      await client.revokeStream(publicKey, streamId, handleSignXdr);
      toast.success("Stream revoked");
      fetchData();
    } catch (err) {
      toast.error(`Revoke failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleExtend = async () => {
    if (!client || !publicKey || !stream) return;
    const newEnd = prompt("Enter new end ledger:", String(stream.endLedger + 50000));
    if (!newEnd) return;
    try {
      await client.extendStream(publicKey, streamId, Number(newEnd), handleSignXdr);
      toast.success("Stream extended");
      fetchData();
    } catch (err) {
      toast.error(`Extend failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleTopUp = async () => {
    if (!client || !publicKey || !stream) return;
    const amount = prompt("Enter additional allocation amount:");
    if (!amount) return;
    try {
      await client.topUpStream(publicKey, streamId, BigInt(amount), handleSignXdr);
      toast.success("Stream topped up");
      fetchData();
    } catch (err) {
      toast.error(`Top-up failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto p-4">
        <p className="text-gray-400">Loading stream...</p>
      </div>
    );
  }

  if (!stream) {
    return (
      <div className="max-w-4xl mx-auto p-4">
        <Link href="/treasury/streams" className="text-xs text-gray-400 hover:text-gray-600">
          ← Back to Streams
        </Link>
        <p className="text-gray-500 mt-4">Stream not found</p>
      </div>
    );
  }

  const remaining = stream.totalAllocated - stream.totalSpent;
  const isOwner = publicKey === stream.owner;

  return (
    <div className="max-w-4xl mx-auto p-4">
      <Link href="/treasury/streams" className="text-xs text-gray-400 hover:text-gray-600">
        ← Back to Streams
      </Link>

      <div className="flex items-center justify-between mt-2 mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold text-gray-900">{stream.name}</h1>
          <span className="text-xs text-gray-400">#{stream.id.toString()}</span>
          {stream.isRevoked && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700">Revoked</span>
          )}
          {stream.isActive && !stream.isRevoked && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">Active</span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div className="border border-gray-200 rounded-lg p-4">
          <h3 className="text-sm font-semibold mb-3">Stream Details</h3>
          <dl className="space-y-2 text-xs">
            <div className="flex justify-between">
              <dt className="text-gray-400">Owner</dt>
              <dd className="font-mono text-gray-700 truncate ml-2">{stream.owner}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-400">Token</dt>
              <dd className="font-mono text-gray-700 truncate ml-2">{stream.token}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-400">Total Allocated</dt>
              <dd className="font-medium text-gray-900">{stream.totalAllocated.toString()}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-400">Total Spent</dt>
              <dd className="font-medium text-gray-900">{stream.totalSpent.toString()}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-400">Remaining</dt>
              <dd className="font-medium text-emerald-600">{remaining.toString()}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-400">Max Single Spend</dt>
              <dd className="font-medium text-gray-900">{stream.maxSingleSpend.toString()}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-400">Cooldown</dt>
              <dd className="font-medium text-gray-900">{stream.cooldownLedgers} ledgers</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-400">Start Ledger</dt>
              <dd className="font-medium text-gray-900">{stream.startLedger}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-400">End Ledger</dt>
              <dd className="font-medium text-gray-900">{stream.endLedger}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-400">Spend Count</dt>
              <dd className="font-medium text-gray-900">{stream.spendCount}</dd>
            </div>
            {stream.revokedAtLedger !== null && (
              <div className="flex justify-between">
                <dt className="text-gray-400">Revoked At</dt>
                <dd className="font-medium text-red-600">{stream.revokedAtLedger}</dd>
              </div>
            )}
          </dl>
        </div>

        <div className="border border-gray-200 rounded-lg p-4">
          <h3 className="text-sm font-semibold mb-3">Budget Report</h3>
          {report ? (
            <>
              <StreamUtilizationBar
                utilizationBps={report.utilizationBps}
                remaining={report.remaining}
                total={report.totalAllocated}
              />
              <dl className="space-y-2 text-xs mt-4">
                <div className="flex justify-between">
                  <dt className="text-gray-400">Utilization</dt>
                  <dd className="font-medium">{(report.utilizationBps / 100).toFixed(1)}%</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-400">Days Remaining</dt>
                  <dd className="font-medium">{report.daysRemaining}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-400">Avg Spend</dt>
                  <dd className="font-medium">{report.avgSpend.toString()}</dd>
                </div>
              </dl>
            </>
          ) : (
            <p className="text-xs text-gray-400">No report available</p>
          )}

          {publicKey && (
            <div className="flex flex-wrap gap-2 mt-4">
              {isOwner && stream.isActive && (
                <button
                  onClick={() => setShowSpend(true)}
                  className="bg-indigo-600 text-white rounded-md px-3 py-1.5 text-xs hover:bg-indigo-700"
                >
                  Spend
                </button>
              )}
              <button
                onClick={handleExtend}
                className="border border-gray-300 text-gray-700 rounded-md px-3 py-1.5 text-xs hover:bg-gray-50"
              >
                Extend
              </button>
              <button
                onClick={handleTopUp}
                className="border border-gray-300 text-gray-700 rounded-md px-3 py-1.5 text-xs hover:bg-gray-50"
              >
                Top Up
              </button>
              <button
                onClick={handleRevoke}
                className="border border-red-300 text-red-600 rounded-md px-3 py-1.5 text-xs hover:bg-red-50"
              >
                Revoke
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="border border-gray-200 rounded-lg p-4">
        <h3 className="text-sm font-semibold mb-3">Spend History</h3>
        {spends.length === 0 ? (
          <p className="text-xs text-gray-400">No spends recorded</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-100 text-left text-gray-400">
                  <th className="py-2 pr-4">#</th>
                  <th className="py-2 pr-4">Recipient</th>
                  <th className="py-2 pr-4">Amount</th>
                  <th className="py-2 pr-4">Memo</th>
                  <th className="py-2 pr-4">Ledger</th>
                </tr>
              </thead>
              <tbody>
                {spends.map((spend) => (
                  <tr key={spend.spendIndex} className="border-b border-gray-50">
                    <td className="py-2 pr-4 text-gray-500">{spend.spendIndex}</td>
                    <td className="py-2 pr-4 font-mono text-gray-700 truncate max-w-[120px]}>
                      {spend.recipient}
                    </td>
                    <td className="py-2 pr-4 font-medium text-gray-900">{spend.amount.toString()}</td>
                    <td className="py-2 pr-4 text-gray-600 truncate max-w-[150px]">{spend.memo}</td>
                    <td className="py-2 pr-4 text-gray-500">{spend.executedAtLedger}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showSpend && client && publicKey && stream && (
        <StreamSpendModal
          client={client}
          stream={stream}
          signerPublicKey={publicKey}
          signUnsignedXdr={handleSignXdr}
          onClose={() => setShowSpend(false)}
          onSpent={fetchData}
        />
      )}
    </div>
  );
}
