import { SorobanRpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { GovernorSettings, Network, VoteType } from "./types";
import { withRetry } from "./utils";

const RPC_URLS: Record<Network, string> = {
  mainnet: "https://soroban-rpc.mainnet.stellar.gateway.fm",
  testnet: "https://soroban-testnet.stellar.org",
  futurenet: "https://rpc-futurenet.stellar.org",
};

const DEFAULT_POLL_INTERVAL_MS = 10_000;

const TOPICS = {
  proposalCreated: "ProposalCreated",
  voteCast: "VoteCast",
  voteCastWithReason: "VoteCastWithReason",
  proposalQueued: "ProposalQueued",
  proposalExecuted: "ProposalExecuted",
  proposalCancelled: "ProposalCancelled",
  proposalExpired: "ProposalExpired",
  governorUpgraded: "GovernorUpgraded",
  configUpdated: "ConfigUpdated",
  paused: "Paused",
  unpaused: "Unpaused",
  legacyProposalCreated: "prop_crtd",
  legacyVoteCast: "vote",
  legacyProposalExecuted: "execute",
} as const;

export interface SorobanEvent {
  ledger: number;
  contractId: string;
  topic: string[];
  value: unknown;
}

export interface ProposalCreatedEventData {
  proposalId: bigint;
  proposer: string;
  description: string;
  descriptionHash: string;
  metadataUri: string;
  targets: unknown[];
  fnNames: unknown[];
  calldatas: unknown[];
  startLedger: number;
  endLedger: number;
}

export interface VoteCastEventData {
  proposalId: bigint;
  voter: string;
  support: number;
  weight: bigint;
}

export interface VoteCastWithReasonEventData {
  proposalId: bigint;
  voter: string;
  support: number;
  weight: bigint;
  reason: string;
}

export interface ProposalQueuedEventData {
  proposalId: bigint;
  opId: unknown;
  eta: bigint;
}

export interface ProposalExecutedEventData {
  proposalId: bigint;
  caller: string;
}

export interface ProposalCancelledEventData {
  proposalId: bigint;
  caller: string;
}

export interface ProposalExpiredEventData {
  proposalId: bigint;
  expiredAtLedger: number;
}

export interface GovernorUpgradedEventData {
  oldHash: unknown;
  newHash: unknown;
}

export interface ConfigUpdatedEventData {
  oldSettings: GovernorSettings;
  newSettings: GovernorSettings;
}

export interface PauseEventData {
  pauser: string;
  ledger: number;
}

export interface UnpauseEventData {
  ledger: number;
}

export interface SubscriptionOptions {
  network: Network;
  rpcUrl?: string;
  intervalMs?: number;
  /** Maximum polling delay in milliseconds when backoff is active (default: 60000). */
  pollMaxDelayMs?: number;
  /** Maximum number of retry attempts for RPC calls (default: 3) */
  maxAttempts?: number;
  /** Base delay in milliseconds for exponential backoff (default: 1000) */
  baseDelayMs?: number;
}

type EventRecord = Record<string, unknown>;

function isRecord(value: unknown): value is EventRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toBigInt(value: unknown): bigint | null {
  try {
    if (typeof value === "bigint") return value;
    if (typeof value === "number" || typeof value === "string") return BigInt(value);
    return null;
  } catch {
    return null;
  }
}

/**
 * Decoded `veto` (proposal vetoed from queue) event.
 */
export interface ProposalVetoedEventData {
  proposalId: bigint;
  queueTime: bigint;
  currentLedger: bigint;
}

/**
 * Parse a Soroban event into a decoded ProposalVetoedEventData.
 *
 * @param event - Raw Soroban event to parse
 * @returns Decoded event data, or null if the event topic or value format is invalid
 */
export function parseProposalVetoedEvent(
  event: SorobanEvent
): ProposalVetoedEventData | null {
  if (event.topic[0] !== "veto") return null;
  const raw = event.value;
  if (!Array.isArray(raw) || raw.length < 3) return null;
  try {
    return {
      proposalId: BigInt(raw[0] as number | bigint | string),
      queueTime: BigInt(raw[1] as number | bigint | string),
      currentLedger: BigInt(raw[2] as number | bigint | string),
    };
  } catch {
    return null;
  }
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function toGovernorSettings(value: unknown): GovernorSettings | null {
  if (!isRecord(value)) return null;

  const votingDelay = toNumber(value.voting_delay);
  const votingPeriod = toNumber(value.voting_period);
  const quorumNumerator = toNumber(value.quorum_numerator);
  const proposalThreshold = toBigInt(value.proposal_threshold);
  const proposalGracePeriod = toNumber(value.proposal_grace_period);

  if (
    votingDelay === null ||
    votingPeriod === null ||
    quorumNumerator === null ||
    proposalThreshold === null
  ) {
    return null;
  }

  return {
    votingDelay,
    votingPeriod,
    quorumNumerator,
    proposalThreshold,
    guardian: String(value.guardian ?? ""),
    voteType: VoteType.Extended,
    proposalGracePeriod: toNumber(value.proposal_grace_period) ?? 0,
    useDynamicQuorum: Boolean(value.use_dynamic_quorum),
    reflectorOracle:
      value.reflector_oracle === undefined || value.reflector_oracle === null
        ? null
        : String(value.reflector_oracle),
    minQuorumUsd: toBigInt(value.min_quorum_usd) ?? 0n,
    maxCalldataSize: toNumber(value.max_calldata_size) ?? 10_000,
    proposalCooldown: toNumber(value.proposal_cooldown) ?? 100,
    maxProposalsPerPeriod: toNumber(value.max_proposals_per_period) ?? 5,
    proposalPeriodDuration: toNumber(value.proposal_period_duration) ?? 10_000,
  };
}

function decodeEvent(raw: SorobanRpc.Api.EventResponse): SorobanEvent {
  const topic = raw.topic.map((segment) => String(scValToNative(segment)));
  const value = scValToNative(raw.value);

  return {
    ledger: raw.ledger,
    contractId: raw.contractId?.contractId() ?? "",
    topic,
    value,
  };
}

function buildServer(opts: SubscriptionOptions): SorobanRpc.Server {
  return new SorobanRpc.Server(opts.rpcUrl ?? RPC_URLS[opts.network], {
    allowHttp: false,
  });
}

function createTopicSubscription(
  governorAddress: string,
  topicName: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions,
  filter?: (event: SorobanEvent) => boolean
): () => void {
  const server = buildServer(opts);
  const topicFilter = [xdr.ScVal.scvSymbol(topicName)];
  const intervalMs = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  let cursor = 0;
  let initialized = false;
  let stopped = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let pollDelayMs = intervalMs;
  const maxPollDelayMs = opts.pollMaxDelayMs ?? 60_000;

  function stopScheduledPoll() {
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  function scheduleNextPoll(delayMs: number) {
    if (stopped) return;
    stopScheduledPoll();
    pollTimer = setTimeout(() => void poll(), delayMs);
  }

  async function poll(): Promise<void> {
    if (stopped) return;

    try {
      if (!initialized) {
        const latest = await withRetry(async () => await server.getLatestLedger(), {
          maxAttempts: opts.maxAttempts ?? 3,
          baseDelayMs: opts.baseDelayMs ?? 1000,
        });
        cursor = latest.sequence;
        initialized = true;
      }

      const { events, latestLedger } = await fetchEvents(
        server,
        governorAddress,
        topicFilter,
        cursor,
        { maxAttempts: opts.maxAttempts, baseDelayMs: opts.baseDelayMs }
      );

      for (const event of events) {
        if (!stopped && (!filter || filter(event))) callback(event);
      }

      cursor = latestLedger + 1;
      pollDelayMs = intervalMs;
    } catch {
      pollDelayMs = Math.min(pollDelayMs * 2, maxPollDelayMs);
    }

    const jitter = 0.2;
    const factor = (1 - jitter) + Math.random() * jitter * 2;
    scheduleNextPoll(Math.max(0, Math.round(pollDelayMs * factor)));
  }

  void poll();

  return () => {
    stopped = true;
    stopScheduledPoll();
  };
}

/**
 * Fetch Soroban contract events matching a topic filter, with retry support.
 *
 * @param server - Soroban RPC server instance
 * @param contractId - Contract address to filter events for
 * @param topicFilter - XDR ScVal topic segments to match
 * @param startLedger - Ledger sequence to start scanning from
 * @param opts - Optional retry configuration
 * @returns Batch of decoded events and the latest scanned ledger
 */
export async function fetchEvents(
  server: SorobanRpc.Server,
  contractId: string,
  topicFilter: xdr.ScVal[],
  startLedger: number,
  opts: { maxAttempts?: number; baseDelayMs?: number } = {}
): Promise<{ events: SorobanEvent[]; latestLedger: number }> {
  return withRetry(async () => {
    const response = await server.getEvents({
      startLedger,
      filters: [
        {
          type: "contract",
          contractIds: [contractId],
          topics: [topicFilter.map((segment) => segment.toXDR("base64"))],
        },
      ],
      limit: 100,
    });

    return {
      events: (response.events ?? []).map(decodeEvent),
      latestLedger: response.latestLedger ? Number(response.latestLedger) : startLedger,
    };
  }, {
    maxAttempts: opts.maxAttempts ?? 3,
    baseDelayMs: opts.baseDelayMs ?? 1000,
    onRetry: (attempt, error) => {
      console.debug(`[fetchEvents] Retry attempt ${attempt} due to error:`, error);
    }
  });
}

/**
 * Parse a Soroban event into a decoded ProposalCreatedEventData.
 *
 * Supports both the modern `ProposalCreated` topic and the legacy `prop_crtd` topic.
 *
 * @param event - Raw Soroban event to parse
 * @returns Decoded event data, or null if parsing fails
 */
export function parseProposalCreatedEvent(
  event: SorobanEvent
): ProposalCreatedEventData | null {
  if (event.topic[0] === TOPICS.legacyProposalCreated) {
    if (!Array.isArray(event.value) || event.value.length < 7 || event.topic.length < 2) {
      return null;
    }

    const proposalId = toBigInt(event.value[0]);
    const startLedger = toNumber(event.value[5]);
    const endLedger = toNumber(event.value[6]);

    if (proposalId === null || startLedger === null || endLedger === null) return null;

    return {
      proposalId,
      proposer: String(event.topic[1]),
      description: String(event.value[1] ?? ""),
      descriptionHash: "",
      metadataUri: "",
      targets: Array.isArray(event.value[2]) ? event.value[2] : [],
      fnNames: Array.isArray(event.value[3]) ? event.value[3] : [],
      calldatas: Array.isArray(event.value[4]) ? event.value[4] : [],
      startLedger,
      endLedger,
    };
  }

  if (event.topic[0] !== TOPICS.proposalCreated || !isRecord(event.value)) return null;

  const proposalId = toBigInt(event.value.proposal_id);
  const startLedger = toNumber(event.value.start_ledger);
  const endLedger = toNumber(event.value.end_ledger);

  if (proposalId === null || startLedger === null || endLedger === null) return null;

  return {
    proposalId,
    proposer: String(event.value.proposer ?? ""),
    description: String(event.value.description ?? ""),
    descriptionHash: String(event.value.description_hash ?? ""),
    metadataUri: String(event.value.metadata_uri ?? ""),
    targets: Array.isArray(event.value.targets) ? event.value.targets : [],
    fnNames: Array.isArray(event.value.fn_names) ? event.value.fn_names : [],
    calldatas: Array.isArray(event.value.calldatas) ? event.value.calldatas : [],
    startLedger,
    endLedger,
  };
}

/**
 * Parse a Soroban event into a decoded VoteCastEventData.
 *
 * Supports both the modern `VoteCast` topic and the legacy `vote` topic.
 *
 * @param event - Raw Soroban event to parse
 * @returns Decoded event data, or null if parsing fails
 */
export function parseVoteCastEvent(event: SorobanEvent): VoteCastEventData | null {
  if (event.topic[0] === TOPICS.legacyVoteCast) {
    if (!Array.isArray(event.value) || event.value.length < 3 || event.topic.length < 2) {
      return null;
    }

    const proposalId = toBigInt(event.value[0]);
    const weight = toBigInt(event.value[2]);

    if (proposalId === null || weight === null) return null;

    return {
      proposalId,
      voter: String(event.topic[1]),
      support: toNumber(event.value[1]) ?? -1,
      weight,
    };
  }

  if (event.topic[0] !== TOPICS.voteCast || !isRecord(event.value)) return null;

  const proposalId = toBigInt(event.value.proposal_id);
  const support = toNumber(event.value.support);
  const weight = toBigInt(event.value.weight);

  if (proposalId === null || support === null || weight === null) return null;

  return {
    proposalId,
    voter: String(event.value.voter ?? ""),
    support,
    weight,
  };
}

/**
 * Parse a Soroban event into a decoded VoteCastWithReasonEventData.
 *
 * @param event - Raw Soroban event to parse
 * @returns Decoded event data including reason string, or null if parsing fails
 */
export function parseVoteCastWithReasonEvent(
  event: SorobanEvent
): VoteCastWithReasonEventData | null {
  if (event.topic[0] !== TOPICS.voteCastWithReason || !isRecord(event.value)) return null;

  const proposalId = toBigInt(event.value.proposal_id);
  const support = toNumber(event.value.support);
  const weight = toBigInt(event.value.weight);

  if (proposalId === null || support === null || weight === null) return null;

  return {
    proposalId,
    voter: String(event.value.voter ?? ""),
    support,
    weight,
    reason: String(event.value.reason ?? ""),
  };
}

/**
 * Parse a Soroban event into a decoded ProposalQueuedEventData.
 *
 * @param event - Raw Soroban event to parse
 * @returns Decoded event data with proposal ID and ETA, or null if parsing fails
 */
export function parseProposalQueuedEvent(
  event: SorobanEvent
): ProposalQueuedEventData | null {
  if (event.topic[0] !== TOPICS.proposalQueued) return null;

  if (Array.isArray(event.value)) {
    const proposalId = toBigInt(event.value[0]);
    const eta = toBigInt(event.value[1]);
    if (proposalId === null || eta === null) return null;
    return { proposalId, opId: null, eta };
  }

  if (!isRecord(event.value)) return null;
  const proposalId = toBigInt(event.value.proposal_id);
  const eta = toBigInt(event.value.eta);

  if (proposalId === null || eta === null) return null;

  return {
    proposalId,
    opId: event.value.op_id ?? null,
    eta,
  };
}

/**
 * Parse a Soroban event into a decoded ProposalExecutedEventData.
 *
 * Supports both the modern `ProposalExecuted` topic and the legacy `execute` topic.
 *
 * @param event - Raw Soroban event to parse
 * @returns Decoded event data with proposal ID and caller, or null if parsing fails
 */
export function parseProposalExecutedEvent(
  event: SorobanEvent
): ProposalExecutedEventData | null {
  if (event.topic[0] === TOPICS.legacyProposalExecuted) {
    const proposalId = toBigInt(event.value);
    if (proposalId === null) return null;
    return {
      proposalId,
      caller: "",
    };
  }

  if (event.topic[0] !== TOPICS.proposalExecuted || !isRecord(event.value)) return null;
  const proposalId = toBigInt(event.value.proposal_id);
  if (proposalId === null) return null;

  return {
    proposalId,
    caller: String(event.value.caller ?? ""),
  };
}

/**
 * Parse a Soroban event into a decoded ProposalCancelledEventData.
 *
 * @param event - Raw Soroban event to parse
 * @returns Decoded event data with proposal ID and caller, or null if parsing fails
 */
export function parseProposalCancelledEvent(
  event: SorobanEvent
): ProposalCancelledEventData | null {
  if (event.topic[0] !== TOPICS.proposalCancelled || !isRecord(event.value)) return null;
  const proposalId = toBigInt(event.value.proposal_id);
  if (proposalId === null) return null;

  return {
    proposalId,
    caller: String(event.value.caller ?? ""),
  };
}

/**
 * Parse a Soroban event into a decoded ProposalExpiredEventData.
 *
 * @param event - Raw Soroban event to parse
 * @returns Decoded event data with proposal ID and expiry ledger, or null if parsing fails
 */
export function parseProposalExpiredEvent(
  event: SorobanEvent
): ProposalExpiredEventData | null {
  if (event.topic[0] !== TOPICS.proposalExpired || !isRecord(event.value)) return null;
  const proposalId = toBigInt(event.value.proposal_id);
  const expiredAtLedger = toNumber(event.value.expired_at_ledger);

  if (proposalId === null || expiredAtLedger === null) return null;

  return {
    proposalId,
    expiredAtLedger,
  };
}

/**
 * Parse a Soroban event into a decoded GovernorUpgradedEventData.
 *
 * @param event - Raw Soroban event to parse
 * @returns Decoded event data with old and new contract hashes, or null if parsing fails
 */
export function parseGovernorUpgradedEvent(
  event: SorobanEvent
): GovernorUpgradedEventData | null {
  if (event.topic[0] !== TOPICS.governorUpgraded || !isRecord(event.value)) return null;

  return {
    oldHash: event.value.old_hash ?? null,
    newHash: event.value.new_hash ?? null,
  };
}

/**
 * Parse a Soroban event into a decoded ConfigUpdatedEventData.
 *
 * @param event - Raw Soroban event to parse
 * @returns Decoded event data with old and new governor settings, or null if parsing fails
 */
export function parseConfigUpdatedEvent(
  event: SorobanEvent
): ConfigUpdatedEventData | null {
  if (event.topic[0] !== TOPICS.configUpdated || !isRecord(event.value)) return null;

  const oldSettings = toGovernorSettings(event.value.old_settings);
  const newSettings = toGovernorSettings(event.value.new_settings);

  if (!oldSettings || !newSettings) return null;

  return {
    oldSettings,
    newSettings,
  };
}

/**
 * Subscribe to real-time ProposalCreated events via polling.
 *
 * @param governorAddress - Governor contract address to monitor
 * @param callback - Fired on each new ProposalCreated event
 * @param opts - Subscription configuration (network, interval, retry)
 * @returns Unsubscribe function to stop polling
 */
export function subscribeToProposals(
  governorAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(governorAddress, TOPICS.proposalCreated, callback, opts);
}

/**
 * Subscribe to real-time VoteCast events for a specific proposal via polling.
 *
 * @param governorAddress - Governor contract address to monitor
 * @param proposalId - Only fire callback for votes on this proposal ID
 * @param callback - Fired on each new matching VoteCast event
 * @param opts - Subscription configuration (network, interval, retry)
 * @returns Unsubscribe function to stop polling
 */
export function subscribeToVotes(
  governorAddress: string,
  proposalId: bigint,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(
    governorAddress,
    TOPICS.voteCast,
    callback,
    opts,
    (event) => parseVoteCastEvent(event)?.proposalId === proposalId
  );
}

/**
 * Subscribe to real-time VoteCastWithReason events for a specific proposal via polling.
 *
 * @param governorAddress - Governor contract address to monitor
 * @param proposalId - Only fire callback for votes with reason on this proposal ID
 * @param callback - Fired on each new matching VoteCastWithReason event
 * @param opts - Subscription configuration (network, interval, retry)
 * @returns Unsubscribe function to stop polling
 */
export function subscribeToVoteCastWithReason(
  governorAddress: string,
  proposalId: bigint,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(
    governorAddress,
    TOPICS.voteCastWithReason,
    callback,
    opts,
    (event) => parseVoteCastWithReasonEvent(event)?.proposalId === proposalId
  );
}

/**
 * Fetch all ProposalCreated events from a given ledger onward.
 *
 * Paginates through all available events up to the latest ledger.
 *
 * @param governorAddress - Governor contract address to query
 * @param fromLedger - Earliest ledger to start scanning from
 * @param opts - Subscription configuration (network, retry)
 * @returns Array of decoded Soroban events
 */
export async function getProposalEvents(
  governorAddress: string,
  fromLedger: number,
  opts: SubscriptionOptions
): Promise<SorobanEvent[]> {
  const server = buildServer(opts);
  const latest = (await withRetry(async () => await server.getLatestLedger(), {
    maxAttempts: opts.maxAttempts ?? 3,
    baseDelayMs: opts.baseDelayMs ?? 1000,
  })).sequence;
  const topicFilter = [xdr.ScVal.scvSymbol(TOPICS.proposalCreated)];
  const events: SorobanEvent[] = [];
  let startLedger = Math.max(1, fromLedger);

  while (startLedger <= latest) {
    const { events: page, latestLedger } = await fetchEvents(
      server,
      governorAddress,
      topicFilter,
      startLedger,
      { maxAttempts: opts.maxAttempts, baseDelayMs: opts.baseDelayMs }
    );

    if (page.length === 0) {
      startLedger = latestLedger + 1;
      continue;
    }

    events.push(...page);
    startLedger = Math.max(...page.map((event) => event.ledger)) + 1;
  }

  return events;
}

/**
 * Subscribe to real-time ProposalQueued events via polling.
 *
 * @param governorAddress - Governor contract address to monitor
 * @param callback - Fired on each new ProposalQueued event
 * @param opts - Subscription configuration (network, interval, retry)
 * @returns Unsubscribe function to stop polling
 */
export function subscribeToProposalQueued(
  governorAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(governorAddress, TOPICS.proposalQueued, callback, opts);
}

/**
 * Subscribe to real-time ProposalExecuted events via polling.
 *
 * @param governorAddress - Governor contract address to monitor
 * @param callback - Fired on each new ProposalExecuted event
 * @param opts - Subscription configuration (network, interval, retry)
 * @returns Unsubscribe function to stop polling
 */
export function subscribeToProposalExecuted(
  governorAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(governorAddress, TOPICS.proposalExecuted, callback, opts);
}

/**
 * Subscribe to real-time ProposalCancelled events via polling.
 *
 * @param governorAddress - Governor contract address to monitor
 * @param callback - Fired on each new ProposalCancelled event
 * @param opts - Subscription configuration (network, interval, retry)
 * @returns Unsubscribe function to stop polling
 */
export function subscribeToProposalCancelled(
  governorAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(governorAddress, TOPICS.proposalCancelled, callback, opts);
}

/**
 * Subscribe to real-time ProposalExpired events via polling.
 *
 * @param governorAddress - Governor contract address to monitor
 * @param callback - Fired on each new ProposalExpired event
 * @param opts - Subscription configuration (network, interval, retry)
 * @returns Unsubscribe function to stop polling
 */
export function subscribeToProposalExpired(
  governorAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(governorAddress, TOPICS.proposalExpired, callback, opts);
}

/**
 * Subscribe to real-time GovernorUpgraded events via polling.
 *
 * @param governorAddress - Governor contract address to monitor
 * @param callback - Fired on each new GovernorUpgraded event
 * @param opts - Subscription configuration (network, interval, retry)
 * @returns Unsubscribe function to stop polling
 */
export function subscribeToGovernorUpgraded(
  governorAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(governorAddress, TOPICS.governorUpgraded, callback, opts);
}

/**
 * Subscribe to real-time ConfigUpdated events via polling.
 *
 * @param governorAddress - Governor contract address to monitor
 * @param callback - Fired on each new ConfigUpdated event
 * @param opts - Subscription configuration (network, interval, retry)
 * @returns Unsubscribe function to stop polling
 */
export function subscribeToConfigUpdated(
  governorAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(governorAddress, TOPICS.configUpdated, callback, opts);
}

/**
 * Parse a Soroban event into a decoded PauseEventData.
 *
 * @param event - Raw Soroban event to parse
 * @returns Decoded event data with pauser address and ledger, or null if parsing fails
 */
export function parsePauseEvent(event: SorobanEvent): PauseEventData | null {
  if (event.topic[0] !== TOPICS.paused) return null;
  if (!isRecord(event.value)) return null;

  const ledger = toNumber(event.value.ledger);
  if (ledger === null) return null;

  // The pauser address is the second topic segment when present; fall back to
  // the value field for completeness.
  const pauser =
    typeof event.topic[1] === "string"
      ? event.topic[1]
      : event.value.pauser === undefined || event.value.pauser === null
      ? ""
      : String(event.value.pauser);

  return { pauser, ledger };
}

/**
 * Parse a Soroban event into a decoded UnpauseEventData.
 *
 * @param event - Raw Soroban event to parse
 * @returns Decoded event data with ledger, or null if parsing fails
 */
export function parseUnpauseEvent(event: SorobanEvent): UnpauseEventData | null {
  if (event.topic[0] !== TOPICS.unpaused) return null;
  if (!isRecord(event.value)) return null;

  const ledger = toNumber(event.value.ledger);
  if (ledger === null) return null;

  return { ledger };
}

export function subscribeToPauseEvents(
  governorAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(governorAddress, TOPICS.paused, callback, opts);
}

/**
 * Subscribe to real-time Unpaused events via polling.
 *
 * @param governorAddress - Governor contract address to monitor
 * @param callback - Fired on each new Unpaused event
 * @param opts - Subscription configuration (network, interval, retry)
 * @returns Unsubscribe function to stop polling
 */
export function subscribeToUnpauseEvents(
  governorAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  return createTopicSubscription(governorAddress, TOPICS.unpaused, callback, opts);
}
