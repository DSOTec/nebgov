"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  DEFAULT_NOTIFICATION_TOGGLES,
  loadNotificationHistory,
  loadNotificationToggles,
  markAllNotificationsRead,
  saveNotificationToggles,
  syncNotificationsFromBackend,
  type NotificationHistoryEntry,
  type NotificationToggleKey,
  type NotificationToggles,
} from "../../lib/governance-notifications";
import { useWallet } from "../../lib/wallet-context";

const TOGGLE_ROWS: {
  key: NotificationToggleKey;
  label: string;
  description: string;
}[] = [
  {
    key: "created_self",
    label: "Your proposals created",
    description:
      "When a proposal is created on-chain with your connected wallet.",
  },
  {
    key: "active",
    label: "Voting opens",
    description: "When a proposal leaves Pending and becomes Active.",
  },
  {
    key: "voting_ends_soon",
    label: "Voting ends within 24 ledgers",
    description: "Reminder while voting is still open but close to end_ledger.",
  },
  {
    key: "outcome",
    label: "Passed or failed",
    description: "When a proposal succeeds or is defeated after voting.",
  },
  {
    key: "queued",
    label: "Queued for execution",
    description: "When a passed proposal is scheduled in the timelock.",
  },
  {
    key: "executed",
    label: "Executed",
    description: "When queued actions have been executed on-chain.",
  },
];

function permissionLabel(): string {
  if (typeof Notification === "undefined") return "Not supported in this browser";
  if (Notification.permission === "granted") return "Allowed";
  if (Notification.permission === "denied") return "Blocked (change in browser site settings)";
  return "Not yet granted (connect a wallet to prompt, or allow in the address bar)";
}

export default function NotificationsPage() {
  const { isConnected } = useWallet();
  const [toggles, setToggles] = useState<NotificationToggles>({
    ...DEFAULT_NOTIFICATION_TOGGLES,
  });
  const [history, setHistory] = useState<NotificationHistoryEntry[]>([]);

  useEffect(() => {
    setToggles(loadNotificationToggles());
    setHistory(loadNotificationHistory());
    if (isConnected) {
      void syncNotificationsFromBackend().catch(() => undefined);
    }
    markAllNotificationsRead();
  }, [isConnected]);

  useEffect(() => {
    const onHistory = () => setHistory(loadNotificationHistory());
    const onToggles = () => setToggles(loadNotificationToggles());
    window.addEventListener("nebgov-notify-history", onHistory);
    window.addEventListener("nebgov-notify-toggles", onToggles);
    return () => {
      window.removeEventListener("nebgov-notify-history", onHistory);
      window.removeEventListener("nebgov-notify-toggles", onToggles);
    };
  }, []);

  function setToggle(key: NotificationToggleKey, value: boolean) {
    const next = { ...toggles, [key]: value };
    setToggles(next);
    saveNotificationToggles(next);
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <h1 className="text-3xl font-bold text-gray-900">Notifications</h1>
      <p className="text-gray-500 mt-1 mb-6">
        Browser alerts for governance lifecycle events. Everything stays in
        your browser—no server. Want email, webhook, or Telegram alerts
        instead?{" "}
        <Link href="/notifications/rules" className="text-indigo-600 hover:text-indigo-800">
          Set up notification rules
        </Link>
        .
      </p>

      <div className="rounded-xl border border-gray-200 bg-white p-4 mb-8">
        <p className="text-sm font-medium text-gray-900">System permission</p>
        <p className="text-sm text-gray-600 mt-1">{permissionLabel()}</p>
      </div>

      <section className="mb-10">
        <h2 className="text-lg font-semibold text-gray-900 mb-3">
          Event types
        </h2>
        <ul className="space-y-3">
          {TOGGLE_ROWS.map((row) => (
            <li
              key={row.key}
              className="flex items-start gap-3 rounded-xl border border-gray-200 bg-white p-4"
            >
              <input
                type="checkbox"
                id={`toggle-${row.key}`}
                checked={toggles[row.key]}
                onChange={(e) => setToggle(row.key, e.target.checked)}
                className="mt-1 h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
              />
              <label htmlFor={`toggle-${row.key}`} className="flex-1 cursor-pointer">
                <span className="font-medium text-gray-900">{row.label}</span>
                <span className="block text-sm text-gray-500 mt-0.5">
                  {row.description}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-gray-900 mb-3">
          Recent activity
        </h2>
        {history.length === 0 ? (
          <p className="text-sm text-gray-500 rounded-xl border border-dashed border-gray-200 bg-gray-50/80 p-6">
            No events recorded yet. Connect your wallet and keep this tab open
            to record proposal lifecycle alerts.
          </p>
        ) : (
          <ul className="space-y-2">
            {history.map((row) => (
              <li
                key={row.id}
                className="rounded-xl border border-gray-200 bg-white p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2"
              >
                <div>
                  <p className="font-medium text-gray-900">{row.title}</p>
                  <p className="text-sm text-gray-600 mt-0.5">{row.body}</p>
                  <span className="inline-block mt-2 text-xs font-mono text-gray-400">
                    {row.kind}
                    {row.ledger != null ? ` · ledger ${row.ledger}` : ""}
                  </span>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <time
                    className="text-xs text-gray-400 whitespace-nowrap"
                    dateTime={new Date(row.at).toISOString()}
                  >
                    {new Date(row.at).toLocaleString()}
                  </time>
                  <Link
                    href={`/proposal/${row.proposalId}`}
                    className="text-sm font-medium text-indigo-600 hover:text-indigo-800"
                  >
                    View
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
