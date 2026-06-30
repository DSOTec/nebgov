import { IncomingMessage, Server as HttpServer } from "http";
import { WebSocket, WebSocketServer } from "ws";

export type WsEventType =
  | "proposal_created"
  | "vote_cast"
  | "proposal_queued"
  | "proposal_executed"
  | "proposal_cancelled"
  | "delegate_changed"
  | "config_updated"
  | "governor_upgraded"
  | "wrapper_deposit"
  | "wrapper_withdrawal";

export interface WsEvent {
  type: WsEventType;
  data: Record<string, unknown>;
}

interface SubscriptionFilter {
  types?: WsEventType[];
  proposalId?: string;
  state?: string;
}

interface SubscribedClient {
  socket: WebSocket;
  filter: SubscriptionFilter;
  missedPings: number;
}

const HEARTBEAT_INTERVAL_MS = 25_000;
const MAX_MISSED_PINGS = 3;

const clients = new Set<SubscribedClient>();

/**
 * Proposal lifecycle state implied by each event type. Succeeded/Defeated/Expired
 * are derived purely from ledger time rather than an on-chain event, so they have
 * no entry here and can't be matched by a `state` filter.
 */
const EVENT_STATE: Partial<Record<WsEventType, string>> = {
  proposal_created: "Pending",
  vote_cast: "Active",
  proposal_queued: "Queued",
  proposal_executed: "Executed",
  proposal_cancelled: "Cancelled",
};

function matchesFilter(event: WsEvent, filter: SubscriptionFilter): boolean {
  if (filter.types && filter.types.length > 0) {
    if (!filter.types.includes(event.type)) return false;
  }
  if (filter.proposalId !== undefined) {
    const pid = (event.data as any).proposal_id ?? (event.data as any).id;
    if (String(pid) !== filter.proposalId) return false;
  }
  if (filter.state !== undefined) {
    if (EVENT_STATE[event.type] !== filter.state) return false;
  }
  return true;
}

export function broadcast(event: WsEvent): void {
  const payload = JSON.stringify(event);
  for (const client of clients) {
    if (
      client.socket.readyState === WebSocket.OPEN &&
      matchesFilter(event, client.filter)
    ) {
      client.socket.send(payload);
    }
  }
}

export function createWsServer(httpServer: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: "/events" });

  wss.on("connection", (socket: WebSocket, _req: IncomingMessage) => {
    const entry: SubscribedClient = { socket, filter: {}, missedPings: 0 };
    clients.add(entry);

    socket.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          types?: WsEventType[];
          proposalId?: string;
          subscribe?: "proposal" | "state";
          proposal_id?: string | number;
          state?: string;
        };
        if (Array.isArray(msg.types)) entry.filter.types = msg.types;
        if (typeof msg.proposalId === "string")
          entry.filter.proposalId = msg.proposalId;

        // { subscribe: "proposal", proposal_id: 42 } / { subscribe: "state", state: "Active" }
        if (msg.subscribe === "proposal" && msg.proposal_id !== undefined) {
          entry.filter.proposalId = String(msg.proposal_id);
        } else if (msg.subscribe === "state" && typeof msg.state === "string") {
          entry.filter.state = msg.state;
        }
      } catch {
        /* ignore malformed filter messages */
      }
    });

    socket.on("pong", () => {
      entry.missedPings = 0;
    });

    socket.on("close", () => {
      clients.delete(entry);
    });

    socket.on("error", () => {
      clients.delete(entry);
    });
  });

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (client.missedPings >= MAX_MISSED_PINGS) {
        client.socket.terminate();
        clients.delete(client);
        continue;
      }
      if (client.socket.readyState === WebSocket.OPEN) {
        client.missedPings += 1;
        client.socket.ping();
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  wss.on("close", () => {
    clearInterval(heartbeat);
  });

  return wss;
}

export function getConnectedClientCount(): number {
  return clients.size;
}

export function clearClients(): void {
  clients.clear();
}
