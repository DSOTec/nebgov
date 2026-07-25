"use client";

import { useState } from "react";
import Link from "next/link";
import toast from "react-hot-toast";
import { useNotifications, type NotificationRule } from "../../../hooks/useNotifications";
import { NotificationRuleBuilder } from "../../../components/NotificationRuleBuilder";
import { useWallet } from "../../../lib/wallet-context";

function channelSummary(rule: NotificationRule): string {
  return rule.channels.map((c) => c.type).join(", ");
}

export default function NotificationRulesPage() {
  const { isConnected } = useWallet();
  const { rules, loading, updateRule, deleteRule, testRule } = useNotifications();
  const [showBuilder, setShowBuilder] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

  async function handleToggle(rule: NotificationRule) {
    setBusyId(rule.id);
    try {
      await updateRule(rule.id, { enabled: !rule.enabled });
    } catch {
      toast.error("Failed to update rule");
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(rule: NotificationRule) {
    setBusyId(rule.id);
    try {
      await deleteRule(rule.id);
    } catch {
      toast.error("Failed to delete rule");
    } finally {
      setBusyId(null);
    }
  }

  async function handleTest(rule: NotificationRule) {
    setBusyId(rule.id);
    try {
      await testRule(rule.id);
      toast.success("Test notification sent");
    } catch {
      toast.error("Failed to send test notification");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Notification rules</h1>
        {isConnected && (
          <button
            onClick={() => setShowBuilder(true)}
            className="px-4 py-2 rounded-full bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 transition-colors"
          >
            Add rule
          </button>
        )}
      </div>
      <p className="text-gray-500 mt-1 mb-6">
        Get notified in-app, by email, webhook, or Telegram when specific governance events happen.{" "}
        <Link href="/notifications" className="text-indigo-600 hover:text-indigo-800">
          View activity &amp; browser alerts
        </Link>
      </p>

      {!isConnected ? (
        <p className="text-sm text-gray-500 rounded-xl border border-dashed border-gray-200 dark:border-gray-800 bg-gray-50/80 dark:bg-gray-900/50 p-6">
          Connect your wallet to create notification rules.
        </p>
      ) : loading && rules.length === 0 ? (
        <p className="text-sm text-gray-500">Loading rules…</p>
      ) : rules.length === 0 ? (
        <p className="text-sm text-gray-500 rounded-xl border border-dashed border-gray-200 dark:border-gray-800 bg-gray-50/80 dark:bg-gray-900/50 p-6">
          No rules yet. Add one to get notified about proposals, votes, and delegation changes.
        </p>
      ) : (
        <ul className="space-y-2">
          {rules.map((rule) => (
            <li
              key={rule.id}
              className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-medium text-gray-900 dark:text-white">{rule.name}</p>
                  <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
                    {rule.trigger_type.replace(/_/g, " ")} · {channelSummary(rule)}
                  </p>
                  <p className="text-xs text-gray-400 mt-1">
                    Triggered {rule.trigger_count} time{rule.trigger_count === 1 ? "" : "s"}
                    {rule.last_triggered_at ? ` · last ${new Date(rule.last_triggered_at).toLocaleString()}` : ""}
                  </p>
                </div>
                <label className="flex items-center gap-2 shrink-0">
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    disabled={busyId === rule.id}
                    onChange={() => void handleToggle(rule)}
                    className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                  />
                  <span className="text-xs text-gray-500">Enabled</span>
                </label>
              </div>
              <div className="flex items-center gap-3 mt-3">
                <button
                  onClick={() => void handleTest(rule)}
                  disabled={busyId === rule.id}
                  className="text-xs font-medium text-indigo-600 hover:text-indigo-800 disabled:opacity-50"
                >
                  Test
                </button>
                <button
                  onClick={() => void handleDelete(rule)}
                  disabled={busyId === rule.id}
                  className="text-xs font-medium text-rose-600 hover:text-rose-800 disabled:opacity-50"
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {showBuilder && <NotificationRuleBuilder onClose={() => setShowBuilder(false)} />}
    </div>
  );
}
