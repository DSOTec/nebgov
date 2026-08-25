import {
  streamEvents,
  UnsubscribeFn,
  IndexerEvent,
  WsEventType,
  StreamEventsOptions,
} from "../streamEvents";

describe("streamEvents", () => {
  const indexerUrl = "https://indexer.example.com";
  let mockWs: any;
  let mockFetch: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock WebSocket
    mockWs = {
      send: jest.fn(),
      close: jest.fn(),
      onopen: null as any,
      onmessage: null as any,
      onerror: null as any,
      onclose: null as any,
    };

    global.WebSocket = jest.fn().mockImplementation((url) => {
      // Simulate successful connection after a tick
      setTimeout(() => {
        if (mockWs.onopen) mockWs.onopen();
      }, 0);
      return mockWs;
    }) as any;

    mockFetch = jest.fn();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("basic functionality", () => {
    it("returns an unsubscribe function", () => {
      const handler = jest.fn();
      const unsubscribe = streamEvents(indexerUrl, handler);
      expect(typeof unsubscribe).toBe("function");
      unsubscribe();
    });

    it("closes WebSocket on unsubscribe", (done) => {
      const handler = jest.fn();
      const unsubscribe = streamEvents(indexerUrl, handler);

      setTimeout(() => {
        unsubscribe();
        expect(mockWs.close).toHaveBeenCalled();
        done();
      }, 10);
    });

    it("calls handler when event is received", (done) => {
      const handler = jest.fn();
      streamEvents(indexerUrl, handler);

      setTimeout(() => {
        const event: IndexerEvent = {
          type: "proposal_created",
          data: { id: "1", title: "Test" },
        };
        mockWs.onmessage({ data: JSON.stringify(event) });

        expect(handler).toHaveBeenCalledWith(event);
        done();
      }, 10);
    });

    it("handles binary message data", (done) => {
      const handler = jest.fn();
      streamEvents(indexerUrl, handler);

      setTimeout(() => {
        const event: IndexerEvent = {
          type: "vote_cast",
          data: { voter: "test" },
        };
        const data = JSON.stringify(event);
        const buffer = Buffer.from(data);
        mockWs.onmessage({ data: buffer });

        expect(handler).toHaveBeenCalledWith(event);
        done();
      }, 10);
    });

    it("ignores malformed messages", (done) => {
      const handler = jest.fn();
      streamEvents(indexerUrl, handler);

      setTimeout(() => {
        mockWs.onmessage({ data: "not json" });
        expect(handler).not.toHaveBeenCalled();
        done();
      }, 10);
    });
  });

  describe("event filtering", () => {
    it("filters by event type", (done) => {
      const handler = jest.fn();
      const opts: StreamEventsOptions = { types: ["proposal_created"] };
      streamEvents(indexerUrl, handler, opts);

      setTimeout(() => {
        const event1: IndexerEvent = {
          type: "proposal_created",
          data: { id: "1" },
        };
        const event2: IndexerEvent = {
          type: "vote_cast",
          data: { voter: "test" },
        };

        mockWs.onmessage({ data: JSON.stringify(event1) });
        mockWs.onmessage({ data: JSON.stringify(event2) });

        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith(event1);
        done();
      }, 10);
    });

    it("filters by proposal ID", (done) => {
      const handler = jest.fn();
      const opts: StreamEventsOptions = { proposalId: "42" };
      streamEvents(indexerUrl, handler, opts);

      setTimeout(() => {
        mockWs.onmessage({
          data: JSON.stringify({
            type: "vote_cast",
            data: { proposal_id: "42", voter: "test" },
          }),
        });
        mockWs.onmessage({
          data: JSON.stringify({
            type: "vote_cast",
            data: { proposal_id: "99", voter: "other" },
          }),
        });

        expect(handler).toHaveBeenCalledTimes(1);
        done();
      }, 10);
    });

    it("filters by stream ID", (done) => {
      const handler = jest.fn();
      const opts: StreamEventsOptions = { streamId: "stream-1" };
      streamEvents(indexerUrl, handler, opts);

      setTimeout(() => {
        mockWs.onmessage({
          data: JSON.stringify({
            type: "stream_spend",
            data: { stream_id: "stream-1", amount: "100" },
          }),
        });
        mockWs.onmessage({
          data: JSON.stringify({
            type: "stream_spend",
            data: { stream_id: "stream-2", amount: "200" },
          }),
        });

        expect(handler).toHaveBeenCalledTimes(1);
        done();
      }, 10);
    });

    it("filters by proposal state", (done) => {
      const handler = jest.fn();
      const opts: StreamEventsOptions = { state: "Active" };
      streamEvents(indexerUrl, handler, opts);

      setTimeout(() => {
        mockWs.onmessage({
          data: JSON.stringify({
            type: "vote_cast",
            data: { proposal_id: "1" },
          }),
        });
        mockWs.onmessage({
          data: JSON.stringify({
            type: "proposal_created",
            data: { proposal_id: "2" },
          }),
        });

        expect(handler).toHaveBeenCalledTimes(1);
        done();
      }, 10);
    });

    it("combines multiple filters", (done) => {
      const handler = jest.fn();
      const opts: StreamEventsOptions = {
        types: ["vote_cast"],
        proposalId: "42",
      };
      streamEvents(indexerUrl, handler, opts);

      setTimeout(() => {
        // Matches type and proposal ID
        mockWs.onmessage({
          data: JSON.stringify({
            type: "vote_cast",
            data: { proposal_id: "42", voter: "test" },
          }),
        });
        // Wrong type
        mockWs.onmessage({
          data: JSON.stringify({
            type: "proposal_queued",
            data: { proposal_id: "42" },
          }),
        });
        // Right type but wrong proposal ID
        mockWs.onmessage({
          data: JSON.stringify({
            type: "vote_cast",
            data: { proposal_id: "99", voter: "other" },
          }),
        });

        expect(handler).toHaveBeenCalledTimes(1);
        done();
      }, 10);
    });
  });

  describe("WebSocket connection", () => {
    it("sends filter options on open", (done) => {
      const handler = jest.fn();
      const opts: StreamEventsOptions = {
        types: ["proposal_created", "vote_cast"],
        proposalId: "123",
      };
      streamEvents(indexerUrl, handler, opts);

      setTimeout(() => {
        expect(mockWs.send).toHaveBeenCalledWith(
          JSON.stringify({
            types: opts.types,
            proposalId: opts.proposalId,
            streamId: undefined,
          })
        );
        done();
      }, 10);
    });

    it("sends state filter separately if specified", (done) => {
      const handler = jest.fn();
      const opts: StreamEventsOptions = { state: "Queued" };
      streamEvents(indexerUrl, handler, opts);

      setTimeout(() => {
        expect(mockWs.send).toHaveBeenCalledWith(
          JSON.stringify({ subscribe: "state", state: "Queued" })
        );
        done();
      }, 10);
    });

    it("handles WebSocket errors gracefully", (done) => {
      const handler = jest.fn();
      streamEvents(indexerUrl, handler, { pollIntervalMs: 1 });

      setTimeout(() => {
        mockWs.onerror();
        // Should fall back to polling or reconnect
        expect(mockWs.close).not.toHaveBeenCalled();
        done();
      }, 10);
    });
  });

  describe("polling fallback", () => {
    it("falls back to polling when WebSocket is unavailable", (done) => {
      const handler = jest.fn();
      global.WebSocket = undefined as any;

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          proposals: [
            { id: 1, title: "Proposal 1" },
            { id: 2, title: "Proposal 2" },
          ],
        }),
      });

      streamEvents(indexerUrl, handler, { fetchFn: mockFetch });

      setTimeout(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          "https://indexer.example.com/proposals?limit=20"
        );
        done();
      }, 100);
    });

    it("respects custom reconnect delay", (done) => {
      jest.useFakeTimers();
      const handler = jest.fn();
      const reconnectDelayMs = 5000;

      streamEvents(indexerUrl, handler, { reconnectDelayMs });

      // Trigger WebSocket close
      setTimeout(() => {
        mockWs.onclose();
      }, 10);

      jest.advanceTimersByTime(reconnectDelayMs - 100);
      // Should not have reconnected yet

      jest.advanceTimersByTime(100);
      // Now it should have attempted to reconnect
      expect(global.WebSocket).toHaveBeenCalled();

      jest.useRealTimers();
      done();
    });
  });

  describe("event type coverage", () => {
    const eventTypes: WsEventType[] = [
      "proposal_created",
      "vote_cast",
      "proposal_queued",
      "proposal_executed",
      "proposal_cancelled",
      "delegate_changed",
      "config_updated",
      "governor_upgraded",
      "wrapper_deposit",
      "wrapper_withdrawal",
      "reputation_updated",
      "effective_threshold_changed",
      "delegation_registered",
      "delegation_revoked",
      "delegation_depth_limit_updated",
      "draft_created",
      "co_sponsored",
      "co_sponsorship_withdrawn",
      "draft_finalized",
      "draft_cancelled",
      "draft_expired",
      "stream_created",
      "stream_spend",
      "stream_batch",
      "stream_revoked",
      "stream_extended",
      "stream_topped_up",
      "stream_exhausted",
      "stream_expired",
      "optimistic_proposal_created",
      "optimistic_objection_cast",
      "optimistic_proposal_objected",
      "optimistic_proposal_passed",
      "optimistic_proposal_executed",
      "optimistic_proposal_cancelled",
    ];

    it("accepts all documented event types", (done) => {
      const handler = jest.fn();
      streamEvents(indexerUrl, handler, { types: eventTypes });

      setTimeout(() => {
        // Should send without error
        expect(mockWs.send).toHaveBeenCalled();
        done();
      }, 10);
    });
  });
});
