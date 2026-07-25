"use client";

import { useCallback, useEffect, useState } from "react";
import { backendFetch } from "../lib/backend";
import { useWallet } from "../lib/wallet-context";

export type TriggerType =
  | "proposal_created"
  | "proposal_state_changed"
  | "proposal_vote_threshold"
  | "proposal_ending_soon"
  | "vote_cast"
  | "guardian_veto"
  | "treasury_stream_spend"
  | "config_updated"
  | "contract_paused"
  | "contract_upgraded"
  | "delegation_received"
  | "delegation_lost"
  | "quorum_reached";

export type NotificationChannel =
  | { type: "in_app" }
  | { type: "email"; address: string }
  | { type: "webhook"; url: string; secret?: string }
  | { type: "telegram"; chat_id: string };

export interface TriggerConfig {
  proposer?: string;
  from_state?: string;
  to_state?: string;
  threshold_bps?: number;
  ledgers_remaining?: number;
  proposal_id?: number;
  voter?: string;
  stream_id?: number;
  min_amount?: number;
  delegatee?: string;
}

export interface NotificationRule {
  id: number;
  user_id: number;
  name: string;
  trigger_type: TriggerType;
  trigger_config: TriggerConfig;
  channels: NotificationChannel[];
  enabled: boolean;
  cooldown_seconds: number;
  last_triggered_at: string | null;
  trigger_count: number;
  created_at: string;
  updated_at: string;
}

export interface InAppNotification {
  id: number;
  rule_id: number | null;
  title: string;
  body: string;
  action_url: string | null;
  read: boolean;
  created_at: string;
}

export interface CreateRuleParams {
  name: string;
  trigger_type: TriggerType;
  trigger_config?: TriggerConfig;
  channels: NotificationChannel[];
  enabled?: boolean;
  cooldown_seconds?: number;
}

interface InboxResponse {
  data: InAppNotification[];
  meta: { total: number; unread: number; limit: number; offset: number };
}

const POLL_INTERVAL_MS = 30_000;

export function useNotifications() {
  const { isConnected } = useWallet();
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState<InAppNotification[]>([]);
  const [rules, setRules] = useState<NotificationRule[]>([]);
  const [loading, setLoading] = useState(false);

  const refreshInbox = useCallback(async () => {
    if (!isConnected) return;
    try {
      const res = await backendFetch<InboxResponse>("/notifications/inbox?limit=20", { auth: true });
      setNotifications(res.data);
      setUnreadCount(res.meta.unread);
    } catch {
      // Backend unreachable — leave prior state in place.
    }
  }, [isConnected]);

  const refreshRules = useCallback(async () => {
    if (!isConnected) return;
    setLoading(true);
    try {
      const res = await backendFetch<NotificationRule[]>("/notifications/rules", { auth: true });
      setRules(res);
    } catch {
      // Backend unreachable — leave prior state in place.
    } finally {
      setLoading(false);
    }
  }, [isConnected]);

  useEffect(() => {
    if (!isConnected) {
      setNotifications([]);
      setUnreadCount(0);
      setRules([]);
      return;
    }
    void refreshInbox();
    void refreshRules();
    const interval = setInterval(() => void refreshInbox(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [isConnected, refreshInbox, refreshRules]);

  const markRead = useCallback(
    async (id: number) => {
      await backendFetch(`/notifications/inbox/${id}/read`, { method: "PUT", auth: true });
      await refreshInbox();
    },
    [refreshInbox],
  );

  const markAllRead = useCallback(async () => {
    await backendFetch("/notifications/inbox/read-all", { method: "PUT", auth: true });
    await refreshInbox();
  }, [refreshInbox]);

  const createRule = useCallback(
    async (rule: CreateRuleParams) => {
      await backendFetch("/notifications/rules", {
        method: "POST",
        body: JSON.stringify(rule),
        auth: true,
      });
      await refreshRules();
    },
    [refreshRules],
  );

  const updateRule = useCallback(
    async (id: number, updates: Partial<CreateRuleParams>) => {
      await backendFetch(`/notifications/rules/${id}`, {
        method: "PUT",
        body: JSON.stringify(updates),
        auth: true,
      });
      await refreshRules();
    },
    [refreshRules],
  );

  const deleteRule = useCallback(
    async (id: number) => {
      await backendFetch(`/notifications/rules/${id}`, { method: "DELETE", auth: true });
      await refreshRules();
    },
    [refreshRules],
  );

  const testRule = useCallback(async (id: number) => {
    return backendFetch(`/notifications/rules/${id}/test`, { method: "POST", auth: true });
  }, []);

  return {
    unreadCount,
    notifications,
    rules,
    loading,
    markRead,
    markAllRead,
    createRule,
    updateRule,
    deleteRule,
    testRule,
    refreshInbox,
    refreshRules,
  };
}
