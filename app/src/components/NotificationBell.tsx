"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { Bell } from "lucide-react";
import { useNotifications } from "../hooks/useNotifications";
import { useWallet } from "../lib/wallet-context";

function timeAgo(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function NotificationBell() {
  const { isConnected } = useWallet();
  const { unreadCount, notifications, markRead } = useNotifications();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  if (!isConnected) return null;

  const unread = notifications.filter((n) => !n.read).slice(0, 5);

  return (
    <div className="relative" ref={containerRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={unreadCount > 0 ? `${unreadCount} unread notifications` : "Notifications"}
        aria-expanded={open}
        aria-haspopup="menu"
        className="relative p-2 rounded-xl text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
      >
        <Bell className="w-5 h-5" aria-hidden />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-indigo-600 text-white text-[10px] leading-4 text-center">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <>
          <div
            className="fixed inset-0 z-[199]"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div
            role="menu"
            className="absolute right-0 mt-2 w-80 bg-white dark:bg-gray-900 rounded-2xl shadow-xl border border-gray-100 dark:border-gray-800 py-2 z-[200] overflow-hidden"
          >
            <div className="px-4 py-2 border-b border-gray-50 dark:border-gray-800">
              <p className="text-xs text-gray-400 font-medium uppercase tracking-wider">
                Notifications
              </p>
            </div>

            {unread.length === 0 ? (
              <p className="px-4 py-6 text-sm text-gray-500 dark:text-gray-400 text-center">
                You&apos;re all caught up.
              </p>
            ) : (
              <ul>
                {unread.map((n) => (
                  <li key={n.id}>
                    <button
                      onClick={() => void markRead(n.id)}
                      className="w-full text-left px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                    >
                      <p className="text-sm font-medium text-gray-900 dark:text-white">{n.title}</p>
                      <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5 line-clamp-2">
                        {n.body}
                      </p>
                      <span className="text-xs text-gray-400 mt-1 block">{timeAgo(n.created_at)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="border-t border-gray-50 dark:border-gray-800 mt-1 pt-1">
              <Link
                href="/notifications"
                onClick={() => setOpen(false)}
                className="block px-4 py-2 text-sm font-medium text-indigo-600 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              >
                View all
              </Link>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
