export type WsEventType =
  | "proposal_created"
  | "vote_cast"
  | "proposal_queued"
  | "proposal_executed"
  | "delegate_changed"
  | "config_updated"
  | "governor_upgraded"
  | "wrapper_deposit"
  | "wrapper_withdrawal";

export interface IndexerEvent {
  type: WsEventType;
  data: Record<string, unknown>;
}

export interface StreamEventsOptions {
  /** Filter to specific event types. If omitted, all types are received. */
  types?: WsEventType[];
  /** Filter to a specific proposal ID. */
  proposalId?: string;
  /** Reconnect delay in ms (default 3000). */
  reconnectDelayMs?: number;
  /** Polling interval in ms used as fallback when WebSocket is unavailable (default 10000). */
  pollIntervalMs?: number;
  /** Maximum polling delay in ms when backoff is active (default 60000). */
  pollMaxDelayMs?: number;
  /** Custom fetch function for polling fallback (default: global fetch). */
  fetchFn?: typeof fetch;
}

export type UnsubscribeFn = () => void;

function buildWsUrl(indexerUrl: string): string {
  return indexerUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/events";
}

function buildPollUrl(indexerUrl: string): string {
  return indexerUrl.replace(/\/$/, "") + "/proposals?limit=20";
}

/**
 * Connects to the indexer WebSocket and calls `handler` on each matching event.
 * Falls back to polling `GET /proposals` if WebSocket is unavailable.
 * Returns an unsubscribe function that stops the stream and closes connections.
 */
export function streamEvents(
  indexerUrl: string,
  handler: (event: IndexerEvent) => void,
  opts: StreamEventsOptions = {}
): UnsubscribeFn {
  const {
    types,
    proposalId,
    reconnectDelayMs = 3000,
    pollIntervalMs = 10_000,
    fetchFn = typeof fetch !== "undefined" ? fetch : undefined,
  } = opts;

  let stopped = false;
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let usingPolling = false;
  let pollingDelayMs = pollIntervalMs;
  let lastSeenId: string | null = null;
  let poll: (() => Promise<void>) | null = null;
  const maxPollDelayMs = opts.pollMaxDelayMs ?? 60_000;

  function stopPolling() {
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  function schedulePolling(delayMs: number) {
    if (stopped || !usingPolling || poll === null) return;
    stopPolling();
    pollTimer = setTimeout(() => void poll?.(), delayMs);
  }

  function nextDelayMs(): number {
    const jitter = 0.2;
    const minFactor = 1 - jitter;
    const maxFactor = 1 + jitter;
    const factor = minFactor + Math.random() * (maxFactor - minFactor);
    return Math.max(0, Math.round(pollingDelayMs * factor));
  }

  function startPolling() {
    if (!fetchFn || usingPolling) return;
    usingPolling = true;
    const url = buildPollUrl(indexerUrl);

    poll = async () => {
      if (stopped) return;
      try {
        const res = await fetchFn!(url);
        if (!res.ok) return;
        const body = (await res.json()) as { proposals?: Array<{ id: string | number; [k: string]: unknown }> };
        const proposals = body.proposals ?? [];
        for (const p of proposals) {
          const id = String(p.id);
          if (lastSeenId !== null && id <= lastSeenId) continue;
          const event: IndexerEvent = { type: "proposal_created", data: p as Record<string, unknown> };
          if (matchesFilter(event)) handler(event);
        }
        if (proposals.length > 0) {
          lastSeenId = String(proposals[0].id);
        }
        pollingDelayMs = pollIntervalMs;
      } catch {
        pollingDelayMs = Math.min(pollingDelayMs * 2, maxPollDelayMs);
      }

      schedulePolling(nextDelayMs());
    };

    void poll();
  }

  function matchesFilter(event: IndexerEvent): boolean {
    if (types && types.length > 0 && !types.includes(event.type)) return false;
    if (proposalId !== undefined) {
      const pid = (event.data as any).proposal_id ?? (event.data as any).id;
      if (String(pid) !== proposalId) return false;
    }
    return true;
  }

  function connect() {
    if (stopped) return;

    const WS = typeof WebSocket !== "undefined"
      ? WebSocket
      : (() => { startPolling(); return null; })();

    if (!WS) return;

    const wsUrl = buildWsUrl(indexerUrl);
    try {
      ws = new WS(wsUrl) as WebSocket;
    } catch {
      startPolling();
      return;
    }

    ws.onopen = () => {
      stopPolling();
      usingPolling = false;
      if (types || proposalId) {
        ws!.send(JSON.stringify({ types, proposalId }));
      }
    };

    ws.onmessage = (ev) => {
      try {
        const event = JSON.parse(
          typeof ev.data === "string" ? ev.data : ev.data.toString()
        ) as IndexerEvent;
        if (matchesFilter(event)) handler(event);
      } catch {
        /* ignore malformed messages */
      }
    };

    ws.onerror = () => {
      /* handled by onclose */
    };

    ws.onclose = () => {
      ws = null;
      if (stopped) return;
      startPolling();
      reconnectTimer = setTimeout(() => {
        if (!stopped) {
          stopPolling();
          usingPolling = false;
          connect();
        }
      }, reconnectDelayMs);
    };
  }

  connect();

  return function unsubscribe() {
    stopped = true;
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    stopPolling();
    if (ws !== null) {
      ws.onclose = null;
      ws.close();
      ws = null;
    }
    poll = null;
  };
}
