import { SorobanRpc, scValToNative } from "@stellar/stellar-sdk";
import { pool } from "./db";
import { invalidate, invalidatePattern } from "./cache";
import { broadcast } from "./ws";

/**
 * Normalises both legacy short-symbol topics (e.g. "prop_crtd") and the newer
 * PascalCase topics (e.g. "ProposalCreated") to a single canonical name so the
 * switch-case below can handle both contract versions without duplication.
 */
const TOPIC_MAP: Record<string, string> = {
  // Legacy → canonical
  prop_crtd: "ProposalCreated",
  vote: "VoteCast",
  vote_rsn: "VoteCastWithReason",
  queued: "ProposalQueued",
  executed: "ProposalExecuted",
  cancelled: "ProposalCancelled",
  delegate: "DelegateChanged",
  del_chsh: "DelegateChanged",
  config_updated: "ConfigUpdated",
  upgraded: "GovernorUpgraded",
  // New-form (already canonical — identity mappings keep the map exhaustive)
  ProposalCreated: "ProposalCreated",
  VoteCast: "VoteCast",
  VoteCastWithReason: "VoteCastWithReason",
  ProposalQueued: "ProposalQueued",
  ProposalExecuted: "ProposalExecuted",
  ProposalCancelled: "ProposalCancelled",
  DelegateChanged: "DelegateChanged",
  ConfigUpdated: "ConfigUpdated",
  GovernorUpgraded: "GovernorUpgraded",
  // Liquidity contract events (#602)
  LiquidityAdded: "LiquidityAdded",
  LiquidityRemoved: "LiquidityRemoved",
  Swap: "Swap",
  PoolFeeUpdated: "PoolFeeUpdated",
  // Co-sponsorship contract events (#767)
  DraftCreated: "DraftCreated",
  CoSponsored: "CoSponsored",
  CoSponsorshipWithdrawn: "CoSponsorshipWithdrawn",
  DraftFinalized: "DraftFinalized",
  DraftCancelled: "DraftCancelled",
  DraftExpired: "DraftExpired",
  // Delegation registry events (#769)
  DelegationRegistered: "DelegationRegistered",
  DelegationRevoked: "DelegationRevoked",
  DelegationDepthLimitUpdated: "DelegationDepthLimitUpdated",
  // Proposer reputation events (#771)
  ReputationUpdated: "ReputationUpdated",
  EffectiveThresholdChanged: "EffectiveThresholdChanged",
  // Timelock contract events (#906)
  OperationScheduled: "OperationScheduled",
  OperationExecuted: "OperationExecuted",
  OperationCancelled: "OperationCancelled",
  BatchOperationScheduled: "BatchOperationScheduled",
  BatchOperationExecuted: "BatchOperationExecuted",
  BatchOperationCancelled: "BatchOperationCancelled",
  MinDelayUpdated: "MinDelayUpdated",
  DependencyDagValidated: "DependencyDagValidated",
  CycleDetected: "CycleDetected",
  PartialBatchStarted: "PartialBatchStarted",
  PartialOpSucceeded: "PartialOpSucceeded",
  PartialOpFailed: "PartialOpFailed",
  BatchRecoveryEntered: "BatchRecoveryEntered",
  FailedOpRetried: "FailedOpRetried",
  FailedOpSkipped: "FailedOpSkipped",
  BatchFullyComplete: "BatchFullyComplete",
};

export interface IndexerConfig {
  rpcUrl: string;
  governorAddress: string;
  wrapperAddress?: string;
  treasuryAddress?: string;
  liquidityAddress?: string;
  coSponsorshipAddress?: string;
  tokenVotesAddress?: string;
  timelockAddress?: string;
  pollIntervalMs: number;
}

export async function getLastIndexedLedger(): Promise<number> {
  const res = await pool.query(
    "SELECT last_ledger FROM indexer_state WHERE id = 1",
  );
  return res.rows[0]?.last_ledger ?? 0;
}

export async function updateLastIndexedLedger(ledger: number): Promise<void> {
  await pool.query("UPDATE indexer_state SET last_ledger = $1 WHERE id = 1", [
    ledger,
  ]);
}

export async function processEvents(
  server: SorobanRpc.Server,
  config: IndexerConfig,
  startLedger: number,
): Promise<number> {
  let latestLedger = startLedger;

  try {
    const contractIds = [config.governorAddress].filter(Boolean);
    if (config.wrapperAddress) contractIds.push(config.wrapperAddress);
    if (config.treasuryAddress) contractIds.push(config.treasuryAddress);
    if (config.liquidityAddress) contractIds.push(config.liquidityAddress);
    if (config.coSponsorshipAddress) contractIds.push(config.coSponsorshipAddress);
    if (config.tokenVotesAddress) contractIds.push(config.tokenVotesAddress);
    if (config.timelockAddress) contractIds.push(config.timelockAddress);

    const response = await server.getEvents({
      startLedger,
      filters: [
        {
          type: "contract",
          contractIds,
        },
      ],
      limit: 200,
    });

    for (const event of response.events) {
      const ledger = event.ledger;
      if (ledger > latestLedger) latestLedger = ledger;

      const topics = event.topic.map((t) => scValToNative(t));
      const rawEventType = topics[0] as string;
      const eventType = TOPIC_MAP[rawEventType] ?? rawEventType;
      // Soroban EventResponse includes contractId for contract events.
      const contractId = (event as any).contractId as string | undefined;
      const isWrapper = !!(
        contractId &&
        config.wrapperAddress &&
        contractId === config.wrapperAddress
      );
      const isTreasury = !!(
        contractId &&
        config.treasuryAddress &&
        contractId === config.treasuryAddress
      );
      const isLiquidity = !!(
        contractId &&
        config.liquidityAddress &&
        contractId === config.liquidityAddress
      );
      const isCoSponsorship = !!(
        contractId &&
        config.coSponsorshipAddress &&
        contractId === config.coSponsorshipAddress
      );
      const isTokenVotes = !!(
        contractId &&
        config.tokenVotesAddress &&
        contractId === config.tokenVotesAddress
      );
      const isTimelock = !!(
        contractId &&
        config.timelockAddress &&
        contractId === config.timelockAddress
      );

      try {
        await logToEventLog(eventType, ledger, contractId, event, topics);
      } catch (err) {
        console.error(`Failed to write event_log entry for ${eventType}:`, err);
      }

      try {
        if (isTreasury) {
          switch (eventType) {
            case "bat_xfer":
              await handleTreasuryBatchTransfer(event, topics);
              break;
            default:
              break;
          }
        } else if (isWrapper) {
          switch (eventType) {
            case "deposit":
            case "Deposit":
              await handleWrapperDeposit(event, topics);
              break;
            case "withdraw":
            case "Withdraw":
              await handleWrapperWithdraw(event, topics);
              break;
            case "DelegateChanged":
              await handleDelegateChanged(event, topics);
              break;
            default:
              break;
          }
        } else if (isLiquidity) {
          switch (eventType) {
            case "LiquidityAdded":
              await handleLiquidityAdded(event, topics);
              break;
            case "LiquidityRemoved":
              await handleLiquidityRemoved(event, topics);
              break;
            case "Swap":
              await handleSwap(event, topics);
              break;
            case "PoolFeeUpdated":
              await handlePoolFeeUpdated(event, topics);
              break;
            default:
              break;
          }
        } else if (isCoSponsorship) {
          switch (eventType) {
            case "DraftCreated":
              await handleDraftCreated(event, topics);
              break;
            case "CoSponsored":
              await handleCoSponsored(event, topics);
              break;
            case "CoSponsorshipWithdrawn":
              await handleCoSponsorshipWithdrawn(event, topics);
              break;
            case "DraftFinalized":
              await handleDraftFinalized(event);
              break;
            case "DraftCancelled":
              await handleDraftCancelled(event);
              break;
            case "DraftExpired":
              await handleDraftExpired(event);
              break;
            default:
              break;
          }
        } else if (isTokenVotes) {
          switch (eventType) {
            case "DelegateChanged":
              await handleDelegateChanged(event, topics);
              break;
            case "DelegationRegistered":
              await handleDelegationRegistered(event, topics);
              break;
            case "DelegationRevoked":
              await handleDelegationRevoked(event, topics);
              break;
            case "DelegationDepthLimitUpdated":
              await handleDelegationDepthLimitUpdated(event, topics);
              break;
            default:
              break;
          }
        } else if (isTimelock) {
          switch (eventType) {
            case "OperationScheduled":
              await handleTimelockOperationScheduled(event, topics);
              break;
            case "OperationExecuted":
              await handleTimelockOperationExecuted(event, topics);
              break;
            case "OperationCancelled":
              await handleTimelockOperationCancelled(event, topics);
              break;
            case "BatchOperationScheduled":
              await handleTimelockBatchOperationScheduled(event, topics);
              break;
            case "BatchOperationExecuted":
              await handleTimelockBatchOperationExecuted(event, topics);
              break;
            case "BatchOperationCancelled":
              await handleTimelockBatchOperationCancelled(event, topics);
              break;
            case "MinDelayUpdated":
              await handleTimelockMinDelayUpdated(event, topics);
              break;
            case "DependencyDagValidated":
              await handleTimelockDependencyDagValidated(event, topics);
              break;
            case "CycleDetected":
              await handleTimelockCycleDetected(event, topics);
              break;
            case "PartialBatchStarted":
              await handleTimelockPartialBatchStarted(event, topics);
              break;
            case "PartialOpSucceeded":
              await handleTimelockPartialOpSucceeded(event, topics);
              break;
            case "PartialOpFailed":
              await handleTimelockPartialOpFailed(event, topics);
              break;
            case "BatchRecoveryEntered":
              await handleTimelockBatchRecoveryEntered(event, topics);
              break;
            case "FailedOpRetried":
              await handleTimelockFailedOpRetried(event, topics);
              break;
            case "FailedOpSkipped":
              await handleTimelockFailedOpSkipped(event, topics);
              break;
            case "BatchFullyComplete":
              await handleTimelockBatchFullyComplete(event, topics);
              break;
            default:
              break;
          }
        } else {
          switch (eventType) {
            case "ProposalCreated":
              await handleProposalCreated(event, topics);
              break;
            case "VoteCast":
              await handleVoteCast(event, topics, false);
              break;
            case "VoteCastWithReason":
              await handleVoteCast(event, topics, true);
              break;
            case "ProposalQueued":
              await handleProposalQueued(topics);
              break;
            case "ProposalExecuted":
              await handleProposalExecuted(topics);
              break;
            case "DelegateChanged":
              await handleDelegateChanged(event, topics);
              break;
            case "ConfigUpdated":
              await handleConfigUpdated(event, topics);
              break;
            case "GovernorUpgraded":
              await handleGovernorUpgraded(event, topics);
              break;
            case "ProposalCancelled":
              await handleProposalCancelled(event, topics);
              break;
            case "ReputationUpdated":
              await handleReputationUpdated(event, topics);
              break;
            case "EffectiveThresholdChanged":
              await handleEffectiveThresholdChanged(event, topics);
              break;
            default:
              break;
          }
        }
      } catch (err) {
        console.error(`Failed to process event ${eventType}:`, err);
      }
    }
  } catch (err) {
    console.error("Error fetching events:", err);
  }

  return latestLedger;
}

/**
 * Persists every parsed governance event to `event_log`, independent of
 * whether a dedicated handler exists for its type. This is the durable feed
 * the backend's notification engine polls to evaluate user-defined rules
 * (issue #774) without needing its own RPC subscription.
 */
async function logToEventLog(
  eventType: string,
  ledger: number,
  contractAddress: string | undefined,
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const payload = {
    topics,
    value: scValToNative(event.value),
    tx_hash: event.txHash,
  };

  await pool.query(
    `INSERT INTO event_log (event_type, ledger, transaction_hash, contract_address, payload)
     VALUES ($1, $2, $3, $4, $5)`,
    [eventType, ledger, event.txHash ?? null, contractAddress ?? "", stringifyJson(payload)],
  );
}

async function handleProposalCreated(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const raw = scValToNative(event.value);
  let id: bigint;
  let proposer: string;
  let description: string;
  let startLedger: number;
  let endLedger: number;

  if (Array.isArray(raw)) {
    // Legacy tuple format from raw env.events().publish()
    id = raw[0] as bigint;
    proposer = topics[1] as string;
    description = String(raw[1] ?? "");
    startLedger = raw[5] as number;
    endLedger = raw[6] as number;
  } else {
    // Struct format from emit_proposal_created()
    const data = raw as Record<string, unknown>;
    id = data.proposal_id as bigint;
    proposer = String(data.proposer ?? "");
    description = String(data.description ?? "");
    startLedger = Number(data.start_ledger);
    endLedger = Number(data.end_ledger);
  }

  invalidatePattern("proposals:");
  await pool.query(
    `INSERT INTO proposals (id, proposer, description, start_ledger, end_ledger)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO NOTHING`,
    [String(id), proposer, description, startLedger, endLedger],
  );
  invalidate(`profile:${proposer}`);
  broadcast({
    type: "proposal_created",
    data: { id: String(id), proposer, description, start_ledger: startLedger, end_ledger: endLedger },
  });
}

async function handleVoteCast(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
  withReason: boolean,
): Promise<void> {
  const voter = topics[1] as string;
  const data = scValToNative(event.value) as unknown[];
  const proposalId = String(data[0] as bigint);
  const support = Number(data[1]);
  const weight = String(withReason ? data[3] : data[2]);
  const reason = withReason ? String(data[2]) : null;

  // Upsert vote
  await pool.query(
    `INSERT INTO votes (proposal_id, voter, support, weight, reason, ledger)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (proposal_id, voter) DO UPDATE SET
       support = EXCLUDED.support,
       weight = EXCLUDED.weight,
       reason = COALESCE(EXCLUDED.reason, votes.reason)`,
    [proposalId, voter, support, weight, reason, event.ledger],
  );

  // Update proposal vote tallies
  const col =
    support === 1
      ? "votes_for"
      : support === 0
        ? "votes_against"
        : "votes_abstain";
  await pool.query(`UPDATE proposals SET ${col} = ${col} + $1 WHERE id = $2`, [
    weight,
    proposalId,
  ]);
  invalidate(`proposal_votes:${proposalId}`, `profile:${voter}`);
  invalidatePattern("proposals:");
  broadcast({
    type: "vote_cast",
    data: { proposal_id: proposalId, voter, support, weight, reason: reason ?? undefined },
  });
}

async function handleProposalQueued(topics: unknown[]): Promise<void> {
  const proposalId = String(topics[1] as bigint);
  await pool.query("UPDATE proposals SET queued = true WHERE id = $1", [
    proposalId,
  ]);
  invalidate(`proposal_votes:${proposalId}`);
  invalidatePattern("proposals:");
  broadcast({ type: "proposal_queued", data: { proposal_id: proposalId } });
}

async function handleProposalExecuted(topics: unknown[]): Promise<void> {
  const proposalId = String(topics[1] as bigint);
  await pool.query("UPDATE proposals SET executed = true WHERE id = $1", [
    proposalId,
  ]);
  invalidate(`proposal_votes:${proposalId}`);
  invalidatePattern("proposals:");
  broadcast({ type: "proposal_executed", data: { proposal_id: proposalId } });
}

async function handleDelegateChanged(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const delegator = topics[1] as string;
  const data = scValToNative(event.value) as [string, string];
  const [oldDelegatee, newDelegatee] = data;

  await pool.query(
    `INSERT INTO delegates (delegator, old_delegatee, new_delegatee, ledger)
     VALUES ($1, $2, $3, $4)`,
    [delegator, oldDelegatee, newDelegatee, event.ledger],
  );
  invalidatePattern("delegates:");
  invalidate(`profile:${delegator}`);
  broadcast({
    type: "delegate_changed",
    data: { delegator, old_delegatee: oldDelegatee, new_delegatee: newDelegatee, ledger: event.ledger },
  });
}

async function handleDelegationRegistered(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const delegator = topics[1] as string;
  const data = scValToNative(event.value) as [string, bigint, number];
  const [delegatee, power, chainDepth] = data;

  await pool.query(
    `INSERT INTO delegation_entries
       (delegator_address, delegatee_address, delegated_at_ledger, power_at_delegation, chain_depth, active)
     VALUES ($1, $2, $3, $4, $5, TRUE)`,
    [delegator, delegatee, event.ledger, String(power), chainDepth],
  );
  invalidatePattern("delegates:");
  invalidate(`profile:${delegator}`, `profile:${delegatee}`);
  broadcast({
    type: "delegation_registered",
    data: { delegator, delegatee, power: String(power), chain_depth: chainDepth, ledger: event.ledger },
  });
}

async function handleDelegationRevoked(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const delegator = topics[1] as string;
  const data = scValToNative(event.value) as [string, number];
  const [previousDelegatee, atLedger] = data;

  await pool.query(
    `UPDATE delegation_entries
     SET active = FALSE, revoked_at_ledger = $3
     WHERE delegator_address = $1 AND delegatee_address = $2 AND active = TRUE`,
    [delegator, previousDelegatee, atLedger],
  );
  invalidatePattern("delegates:");
  invalidate(`profile:${delegator}`, `profile:${previousDelegatee}`);
  broadcast({
    type: "delegation_revoked",
    data: { delegator, previous_delegatee: previousDelegatee, ledger: atLedger },
  });
}

async function handleDelegationDepthLimitUpdated(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const data = scValToNative(event.value) as [number, number];
  const [oldLimit, newLimit] = data;

  broadcast({
    type: "delegation_depth_limit_updated",
    data: { old_limit: oldLimit, new_limit: newLimit, ledger: event.ledger },
  });
}

// --- Proposer reputation events (#771) ---
//
// Backed by the `proposer_reputation` / `reputation_score_history` tables.
// `proposer_reputation` is a running snapshot upserted on every
// ReputationUpdated event, tracking just the score/ledger fields the event
// itself carries. Per-outcome breakdown counts (succeeded/executed/
// defeated/...) aren't tracked on-chain or here either — they're cheap to
// derive client-side from `reputation_score_history`'s `reason` column
// (see the profile page's outcome tally).

async function handleReputationUpdated(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const proposer = topics[1] as string;
  const data = scValToNative(event.value) as [string, number, number, string];
  const [, oldScore, newScore, reason] = data;

  await pool.query(
    `INSERT INTO proposer_reputation (proposer_address, reputation_score, last_updated_ledger)
     VALUES ($1, $2, $3)
     ON CONFLICT (proposer_address) DO UPDATE
       SET reputation_score = $2, last_updated_ledger = $3, updated_at = NOW()`,
    [proposer, newScore, event.ledger],
  );
  await pool.query(
    `INSERT INTO reputation_score_history (proposer_address, ledger, score, change, reason)
     VALUES ($1, $2, $3, $4, $5)`,
    [proposer, event.ledger, newScore, newScore - oldScore, reason],
  );
  invalidate(`reputation:${proposer}`);
  invalidatePattern("reputation:leaderboard");
  broadcast({
    type: "reputation_updated",
    data: { proposer, old_score: oldScore, new_score: newScore, reason, ledger: event.ledger },
  });
}

async function handleEffectiveThresholdChanged(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const proposer = topics[1] as string;
  const data = scValToNative(event.value) as [string, bigint, bigint];
  const [, oldThreshold, newThreshold] = data;

  broadcast({
    type: "effective_threshold_changed",
    data: {
      proposer,
      old_threshold: String(oldThreshold),
      new_threshold: String(newThreshold),
      ledger: event.ledger,
    },
  });
}


async function handleWrapperDeposit(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const account = topics[1] as string;
  const data = scValToNative(event.value) as unknown[];
  const amount = String(data[1] as bigint);

  await pool.query(
    `INSERT INTO wrapper_deposits (account, amount, ledger)
     VALUES ($1, $2, $3)`,
    [account, amount, event.ledger],
  );
  invalidate(`profile:${account}`);
  broadcast({ type: "wrapper_deposit", data: { account, amount, ledger: event.ledger } });
}

async function handleWrapperWithdraw(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const account = topics[1] as string;
  const data = scValToNative(event.value) as unknown[];
  const amount = String(data[1] as bigint);

  await pool.query(
    `INSERT INTO wrapper_withdrawals (account, amount, ledger)
     VALUES ($1, $2, $3)`,
    [account, amount, event.ledger],
  );
  invalidate(`profile:${account}`);
  broadcast({ type: "wrapper_withdrawal", data: { account, amount, ledger: event.ledger } });
}

async function handleTreasuryBatchTransfer(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  // Event: topics = ("bat_xfer", token_address)
  //        value  = (op_hash: Bytes, recipient_count: u32, total_amount: i128)
  const token = topics[1] as string;
  const data = scValToNative(event.value) as unknown[];
  const opHashBytes = data[0] as Uint8Array;
  const opHash = Buffer.from(opHashBytes).toString("hex");
  const recipientCount = Number(data[1]);
  const totalAmount = String(data[2] as bigint);

  await pool.query(
    `INSERT INTO treasury_transfers (op_hash, token, recipient_count, total_amount, ledger)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    [opHash, token, recipientCount, totalAmount, event.ledger],
  );
}

interface GovernorSettings {
  voting_delay: number;
  voting_period: number;
  quorum_numerator: number;
  proposal_threshold: bigint;
  guardian: string;
  voteType: number;
  proposal_grace_period: number;
  use_dynamic_quorum?: boolean;
  reflector_oracle?: string | null;
  min_quorum_usd?: bigint;
  max_calldata_size?: number;
  proposal_cooldown?: number;
  max_proposals_per_period?: number;
  proposal_period_duration?: number;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value, (_key, current) =>
    typeof current === "bigint" ? current.toString() : current,
  );
}

function parseLedgerClosedAt(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
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
  if (!value || typeof value !== "object") return null;

  const obj = value as Record<string, unknown>;
  const votingDelay = toNumber(obj.voting_delay);
  const votingPeriod = toNumber(obj.voting_period);
  const quorumNumerator = toNumber(obj.quorum_numerator);
  const proposalThreshold =
    typeof obj.proposal_threshold === "bigint"
      ? Number(obj.proposal_threshold)
      : obj.proposal_threshold
      ? Number(obj.proposal_threshold)
      : null;
  const proposalGracePeriod = toNumber(obj.proposal_grace_period);

  if (
    votingDelay === null ||
    votingPeriod === null ||
    quorumNumerator === null ||
    proposalThreshold === null ||
    proposalGracePeriod === null
  ) {
    return null;
  }

  return {
    voting_delay: votingDelay,
    voting_period: votingPeriod,
    quorum_numerator: quorumNumerator,
    proposal_threshold: BigInt(proposalThreshold),
    guardian: String(obj.guardian ?? ""),
    voteType: 0,
    proposal_grace_period: proposalGracePeriod,
    use_dynamic_quorum: Boolean(obj.use_dynamic_quorum),
    reflector_oracle:
      obj.reflector_oracle === undefined || obj.reflector_oracle === null
        ? null
        : String(obj.reflector_oracle),
    min_quorum_usd: obj.min_quorum_usd
      ? BigInt(Number(obj.min_quorum_usd))
      : 0n,
    max_calldata_size: toNumber(obj.max_calldata_size) ?? 10000,
    proposal_cooldown: toNumber(obj.proposal_cooldown) ?? 100,
    max_proposals_per_period: toNumber(obj.max_proposals_per_period) ?? 5,
    proposal_period_duration:
      toNumber(obj.proposal_period_duration) ?? 10000,
  };
}

async function handleConfigUpdated(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const data = scValToNative(event.value) as Record<string, unknown>;
  const oldSettings =
    data.old_settings === undefined || data.old_settings === null
      ? null
      : toGovernorSettings(data.old_settings);
  const newSettings = toGovernorSettings(data.new_settings);

  if ((data.old_settings !== undefined && data.old_settings !== null) && !oldSettings) {
    console.error("Failed to parse old_settings from ConfigUpdated event");
    return;
  }

  if (!newSettings) {
    console.error("Failed to parse new_settings from ConfigUpdated event");
    return;
  }

  const ledgerClosedAt = parseLedgerClosedAt((event as any).ledgerClosedAt);

  await pool.query(
    `INSERT INTO config_updates (ledger, old_settings, new_settings, ledger_closed_at)
     VALUES ($1, $2, $3, $4)`,
    [
      event.ledger,
      oldSettings ? stringifyJson(oldSettings) : null,
      stringifyJson(newSettings),
      ledgerClosedAt,
    ],
  );
}

async function handleGovernorUpgraded(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const data = scValToNative(event.value) as Record<string, unknown>;
  const newHash = data.new_hash;

  const hashStr =
    newHash instanceof Uint8Array
      ? Buffer.from(newHash).toString("hex")
      : String(newHash ?? "");

  await pool.query(
    `INSERT INTO governor_upgrades (ledger, new_wasm_hash)
     VALUES ($1, $2)`,
    [event.ledger, hashStr],
  );
}

async function handleProposalCancelled(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const value = scValToNative(event.value);

  let proposalId: string;
  let cancelledAtLedger: number;
  let caller: string;

  if (Array.isArray(value)) {
    // cancel_queued format: (proposal_id: u64, queue_time: u32, current_ledger: u32)
    proposalId = String(value[0] as bigint);
    cancelledAtLedger = Number(value[2]);
    caller = topics.length > 1 ? String(topics[1]) : "unknown";
  } else if (value && typeof value === "object") {
    // emit_proposal_cancelled format: ProposalCancelledEvent { proposal_id, caller }
    const obj = value as Record<string, unknown>;
    proposalId = String(obj.proposal_id);
    cancelledAtLedger = event.ledger;
    caller = String(obj.caller ?? "unknown");
  } else {
    return;
  }

  await pool.query("UPDATE proposals SET cancelled = true WHERE id = $1", [
    proposalId,
  ]);

  await pool.query(
    `INSERT INTO proposal_cancellations (proposal_id, cancelled_at_ledger, caller)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [proposalId, cancelledAtLedger, caller],
  );

  invalidatePattern("proposals:");
  broadcast({
    type: "proposal_cancelled",
    data: { proposal_id: proposalId, cancelled_at_ledger: cancelledAtLedger, caller },
  });
}

// --- Governance analytics snapshots (issue #765) ---
//
// Backed by the `governance_snapshots` table: a pure votes-cast-over-time
// series computed entirely from the indexer's own already-indexed `votes`
// table — no on-chain analytics module needed (there isn't WASM-size
// budget for one alongside the proposer reputation module; see the
// removed `contracts/governor/src/analytics.rs` in git history). Called
// periodically from the poll loop in `index.ts`, throttled by
// `SNAPSHOT_INTERVAL_LEDGERS` so continuous polling doesn't produce a row
// per poll cycle.
const SNAPSHOT_INTERVAL_LEDGERS = 100;

export async function maybeTakeGovernanceSnapshot(currentLedger: number): Promise<void> {
  const lastResult = await pool.query(
    `SELECT ledger FROM governance_snapshots ORDER BY ledger DESC LIMIT 1`,
  );
  const lastLedger = lastResult.rows[0]?.ledger ?? 0;
  if (currentLedger - lastLedger < SNAPSHOT_INTERVAL_LEDGERS) return;

  const votesResult = await pool.query(`SELECT COALESCE(SUM(weight), 0) AS total FROM votes`);
  const totalVotesCast = String(votesResult.rows[0]?.total ?? 0);

  await pool.query(
    `INSERT INTO governance_snapshots (ledger, total_votes_cast)
     VALUES ($1, $2)
     ON CONFLICT (ledger) DO NOTHING`,
    [currentLedger, totalVotesCast],
  );

  invalidatePattern("analytics:");
  broadcast({
    type: "analytics_snapshot_taken",
    data: { ledger: currentLedger, total_votes_cast: totalVotesCast },
  });
}

// ---------------------------------------------------------------------------
// Liquidity event handlers (#602)
// ---------------------------------------------------------------------------

async function handleLiquidityAdded(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const provider = topics[1] as string;
  const data = scValToNative(event.value) as Record<string, unknown>;
  const outcomeA = Number(data.outcome_a);
  const outcomeB = Number(data.outcome_b);
  const amountA = String(data.amount_a as bigint);
  const amountB = String(data.amount_b as bigint);
  const lpTokens = String(data.lp_tokens_minted as bigint);

  await pool.query(
    `INSERT INTO liquidity_events
       (event_type, provider, outcome_a, outcome_b, amount_a, amount_b, lp_tokens, ledger)
     VALUES ('add', $1, $2, $3, $4, $5, $6, $7)`,
    [provider, outcomeA, outcomeB, amountA, amountB, lpTokens, event.ledger],
  );
  broadcast({
    type: "liquidity_added",
    data: { provider, outcome_a: outcomeA, outcome_b: outcomeB, amount_a: amountA, amount_b: amountB, lp_tokens: lpTokens, ledger: event.ledger },
  });
}

async function handleLiquidityRemoved(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const provider = topics[1] as string;
  const data = scValToNative(event.value) as Record<string, unknown>;
  const outcomeA = Number(data.outcome_a);
  const outcomeB = Number(data.outcome_b);
  const amountA = String(data.amount_a as bigint);
  const amountB = String(data.amount_b as bigint);
  const lpTokens = String(data.lp_tokens_burned as bigint);

  await pool.query(
    `INSERT INTO liquidity_events
       (event_type, provider, outcome_a, outcome_b, amount_a, amount_b, lp_tokens, ledger)
     VALUES ('remove', $1, $2, $3, $4, $5, $6, $7)`,
    [provider, outcomeA, outcomeB, amountA, amountB, lpTokens, event.ledger],
  );
  broadcast({
    type: "liquidity_removed",
    data: { provider, outcome_a: outcomeA, outcome_b: outcomeB, amount_a: amountA, amount_b: amountB, lp_tokens: lpTokens, ledger: event.ledger },
  });
}

async function handleSwap(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const trader = topics[1] as string;
  const data = scValToNative(event.value) as Record<string, unknown>;
  const outcomeIn = Number(data.outcome_in);
  const outcomeOut = Number(data.outcome_out);
  const amountIn = String(data.amount_in as bigint);
  const amountOut = String(data.amount_out as bigint);
  const fee = String(data.fee as bigint);

  await pool.query(
    `INSERT INTO swap_events
       (trader, outcome_in, outcome_out, amount_in, amount_out, fee, ledger)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [trader, outcomeIn, outcomeOut, amountIn, amountOut, fee, event.ledger],
  );
  broadcast({
    type: "swap",
    data: { trader, outcome_in: outcomeIn, outcome_out: outcomeOut, amount_in: amountIn, amount_out: amountOut, fee, ledger: event.ledger },
  });
}

async function handlePoolFeeUpdated(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const data = scValToNative(event.value) as Record<string, unknown>;
  const outcomeA = Number(data.outcome_a);
  const outcomeB = Number(data.outcome_b);
  const oldFeeBps = Number(data.old_fee_bps);
  const newFeeBps = Number(data.new_fee_bps);

  await pool.query(
    `INSERT INTO pool_fee_updates
       (outcome_a, outcome_b, old_fee_bps, new_fee_bps, ledger)
     VALUES ($1, $2, $3, $4, $5)`,
    [outcomeA, outcomeB, oldFeeBps, newFeeBps, event.ledger],
  );
  broadcast({
    type: "pool_fee_updated",
    data: { outcome_a: outcomeA, outcome_b: outcomeB, old_fee_bps: oldFeeBps, new_fee_bps: newFeeBps, ledger: event.ledger },
  });
}

async function handleDraftCreated(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const creator = topics[1] as string;
  const data = scValToNative(event.value) as Record<string, unknown>;
  const draftId = String(data.draft_id as bigint);
  const descriptionHashRaw = data.description_hash as Uint8Array | undefined;
  const descriptionHash = descriptionHashRaw
    ? Buffer.from(descriptionHashRaw).toString("hex")
    : null;
  const metadataUri = (data.metadata_uri as string) ?? null;
  const createdLedger = Number(data.created_ledger);
  const expiryLedger = Number(data.expiry_ledger);

  await pool.query(
    `INSERT INTO drafts (draft_id, creator_address, description_hash, metadata_uri, created_ledger, expiry_ledger)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (draft_id) DO NOTHING`,
    [draftId, creator, descriptionHash, metadataUri, createdLedger, expiryLedger],
  );
  invalidatePattern("drafts:");
  broadcast({
    type: "draft_created",
    data: { draft_id: draftId, creator, metadata_uri: metadataUri, ledger: event.ledger },
  });
}

async function handleCoSponsored(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const sponsor = topics[1] as string;
  const data = scValToNative(event.value) as unknown[];
  const draftId = String(data[0] as bigint);
  const power = String(data[1] as bigint);
  const totalPower = String(data[2] as bigint);

  await pool.query(
    `INSERT INTO draft_co_sponsors (draft_id, sponsor_address, pledged_power, pledged_at_ledger)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (draft_id, sponsor_address)
     DO UPDATE SET pledged_power = EXCLUDED.pledged_power, withdrawn = FALSE`,
    [draftId, sponsor, power, event.ledger],
  );
  await pool.query(`UPDATE drafts SET total_power = $1 WHERE draft_id = $2`, [
    totalPower,
    draftId,
  ]);
  invalidatePattern("drafts:");
  broadcast({
    type: "co_sponsored",
    data: { draft_id: draftId, sponsor, power, total_power: totalPower, ledger: event.ledger },
  });
}

async function handleCoSponsorshipWithdrawn(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const sponsor = topics[1] as string;
  const data = scValToNative(event.value) as unknown[];
  const draftId = String(data[0] as bigint);
  const totalPower = String(data[2] as bigint);

  await pool.query(
    `UPDATE draft_co_sponsors SET withdrawn = TRUE WHERE draft_id = $1 AND sponsor_address = $2`,
    [draftId, sponsor],
  );
  await pool.query(`UPDATE drafts SET total_power = $1 WHERE draft_id = $2`, [
    totalPower,
    draftId,
  ]);
  invalidatePattern("drafts:");
  broadcast({
    type: "co_sponsorship_withdrawn",
    data: { draft_id: draftId, sponsor, total_power: totalPower, ledger: event.ledger },
  });
}

async function handleDraftFinalized(
  event: SorobanRpc.Api.EventResponse,
): Promise<void> {
  const data = scValToNative(event.value) as unknown[];
  const draftId = String(data[0] as bigint);
  const proposalId = String(data[1] as bigint);

  await pool.query(
    `UPDATE drafts SET finalized = TRUE, resulting_proposal_id = $1 WHERE draft_id = $2`,
    [proposalId, draftId],
  );
  invalidatePattern("drafts:");
  broadcast({
    type: "draft_finalized",
    data: { draft_id: draftId, proposal_id: proposalId, ledger: event.ledger },
  });
}

async function handleDraftCancelled(
  event: SorobanRpc.Api.EventResponse,
): Promise<void> {
  const data = scValToNative(event.value) as unknown[];
  const draftId = String(data[0] as bigint);

  await pool.query(`UPDATE drafts SET cancelled = TRUE WHERE draft_id = $1`, [
    draftId,
  ]);
  invalidatePattern("drafts:");
  broadcast({
    type: "draft_cancelled",
    data: { draft_id: draftId, ledger: event.ledger },
  });
}

async function handleDraftExpired(
  event: SorobanRpc.Api.EventResponse,
): Promise<void> {
  const data = scValToNative(event.value) as unknown[];
  const draftId = String(data[0] as bigint);

  broadcast({
    type: "draft_expired",
    data: { draft_id: draftId, ledger: event.ledger },
  });
}

// --- Timelock contract events (#906) ---

function bytesToHex(val: any): string {
  if (!val) return "";
  if (typeof val === "string") return val;
  if (Buffer.isBuffer(val)) return val.toString("hex");
  if (val instanceof Uint8Array || Array.isArray(val)) return Buffer.from(val as any).toString("hex");
  return String(val);
}

function timelockEventId(
  event: SorobanRpc.Api.EventResponse,
  eventType: string,
): string {
  return event.id || `${event.txHash ?? "ledger"}:${event.ledger}:${eventType}`;
}

async function handleTimelockOperationScheduled(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const raw = scValToNative(event.value);
  let opId: string;
  let target: string;
  let fnName: string;
  let readyAt: number | bigint;
  let expiresAt: number | bigint;

  if (Array.isArray(raw)) {
    opId = bytesToHex(raw[0]);
    target = String(raw[1] ?? "");
    fnName = String(raw[2] ?? "");
    readyAt = raw[3] as number | bigint;
    expiresAt = raw[4] as number | bigint;
  } else {
    const data = raw as Record<string, unknown>;
    opId = bytesToHex(data.op_id);
    target = String(data.target ?? "");
    fnName = String(data.fn_name ?? "");
    readyAt = data.ready_at as number | bigint;
    expiresAt = data.expires_at as number | bigint;
  }

  await pool.query(
    `INSERT INTO timelock_operations (op_id, target, fn_name, ready_at, expires_at, status, ledger)
     VALUES ($1, $2, $3, $4, $5, 'scheduled', $6)
     ON CONFLICT (op_id) DO UPDATE SET
       target = EXCLUDED.target,
       fn_name = EXCLUDED.fn_name,
       ready_at = EXCLUDED.ready_at,
       expires_at = EXCLUDED.expires_at,
       ledger = EXCLUDED.ledger`,
    [opId, target, fnName, String(readyAt), String(expiresAt), event.ledger],
  );
  invalidate(`timelock:op:${opId}`);
  invalidatePattern("timelock:ops:");
  broadcast({
    type: "timelock_operation_scheduled",
    data: { op_id: opId, target, fn_name: fnName, ready_at: String(readyAt), expires_at: String(expiresAt), ledger: event.ledger },
  });
}

async function handleTimelockOperationExecuted(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const raw = scValToNative(event.value);
  let opId: string;
  let caller: string;

  if (Array.isArray(raw)) {
    opId = bytesToHex(raw[0]);
    caller = String(raw[1] ?? "");
  } else {
    const data = raw as Record<string, unknown>;
    opId = bytesToHex(data.op_id);
    caller = String(data.caller ?? "");
  }

  await pool.query(
    `UPDATE timelock_operations
     SET status = 'executed', executed_by = $2, executed_at_ledger = $3
     WHERE op_id = $1`,
    [opId, caller, event.ledger],
  );
  invalidate(`timelock:op:${opId}`);
  invalidatePattern("timelock:ops:");
  broadcast({
    type: "timelock_operation_executed",
    data: { op_id: opId, caller, ledger: event.ledger },
  });
}

async function handleTimelockOperationCancelled(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const raw = scValToNative(event.value);
  let opId: string;
  let caller: string;

  if (Array.isArray(raw)) {
    opId = bytesToHex(raw[0]);
    caller = String(raw[1] ?? "");
  } else {
    const data = raw as Record<string, unknown>;
    opId = bytesToHex(data.op_id);
    caller = String(data.caller ?? "");
  }

  await pool.query(
    `UPDATE timelock_operations
     SET status = 'cancelled', cancelled_by = $2, cancelled_at_ledger = $3
     WHERE op_id = $1`,
    [opId, caller, event.ledger],
  );
  invalidate(`timelock:op:${opId}`);
  invalidatePattern("timelock:ops:");
  broadcast({
    type: "timelock_operation_cancelled",
    data: { op_id: opId, caller, ledger: event.ledger },
  });
}

async function handleTimelockBatchOperationScheduled(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const raw = scValToNative(event.value);
  let batchOpId: string;
  let targets: string[];
  let fnNames: string[];
  let readyAt: number | bigint;
  let expiresAt: number | bigint;

  if (Array.isArray(raw)) {
    batchOpId = bytesToHex(raw[0]);
    targets = (raw[1] as any[] ?? []).map(String);
    fnNames = (raw[2] as any[] ?? []).map(String);
    readyAt = raw[3] as number | bigint;
    expiresAt = raw[4] as number | bigint;
  } else {
    const data = raw as Record<string, unknown>;
    batchOpId = bytesToHex(data.batch_op_id);
    targets = (data.targets as any[] ?? []).map(String);
    fnNames = (data.fn_names as any[] ?? []).map(String);
    readyAt = data.ready_at as number | bigint;
    expiresAt = data.expires_at as number | bigint;
  }

  await pool.query(
    `INSERT INTO timelock_batch_operations (batch_op_id, targets, fn_names, ready_at, expires_at, status, ledger)
     VALUES ($1, $2, $3, $4, $5, 'scheduled', $6)
     ON CONFLICT (batch_op_id) DO UPDATE SET
       targets = EXCLUDED.targets,
       fn_names = EXCLUDED.fn_names,
       ready_at = EXCLUDED.ready_at,
       expires_at = EXCLUDED.expires_at,
       ledger = EXCLUDED.ledger`,
    [batchOpId, JSON.stringify(targets), JSON.stringify(fnNames), String(readyAt), String(expiresAt), event.ledger],
  );
  invalidate(`timelock:batch:${batchOpId}`);
  invalidatePattern("timelock:batches:");
  broadcast({
    type: "timelock_batch_operation_scheduled",
    data: { batch_op_id: batchOpId, targets, fn_names: fnNames, ready_at: String(readyAt), expires_at: String(expiresAt), ledger: event.ledger },
  });
}

async function handleTimelockBatchOperationExecuted(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const raw = scValToNative(event.value);
  let batchOpId: string;
  let caller: string;

  if (Array.isArray(raw)) {
    batchOpId = bytesToHex(raw[0]);
    caller = String(raw[1] ?? "");
  } else {
    const data = raw as Record<string, unknown>;
    batchOpId = bytesToHex(data.batch_op_id);
    caller = String(data.caller ?? "");
  }

  await pool.query(
    `UPDATE timelock_batch_operations
     SET status = 'executed', executed_by = $2, executed_at_ledger = $3
     WHERE batch_op_id = $1`,
    [batchOpId, caller, event.ledger],
  );
  invalidate(`timelock:batch:${batchOpId}`);
  invalidatePattern("timelock:batches:");
  broadcast({
    type: "timelock_batch_operation_executed",
    data: { batch_op_id: batchOpId, caller, ledger: event.ledger },
  });
}

async function handleTimelockBatchOperationCancelled(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const raw = scValToNative(event.value);
  let batchOpId: string;
  let caller: string;

  if (Array.isArray(raw)) {
    batchOpId = bytesToHex(raw[0]);
    caller = String(raw[1] ?? "");
  } else {
    const data = raw as Record<string, unknown>;
    batchOpId = bytesToHex(data.batch_op_id);
    caller = String(data.caller ?? "");
  }

  await pool.query(
    `UPDATE timelock_batch_operations
     SET status = 'cancelled', cancelled_by = $2, cancelled_at_ledger = $3
     WHERE batch_op_id = $1`,
    [batchOpId, caller, event.ledger],
  );
  invalidate(`timelock:batch:${batchOpId}`);
  invalidatePattern("timelock:batches:");
  broadcast({
    type: "timelock_batch_operation_cancelled",
    data: { batch_op_id: batchOpId, caller, ledger: event.ledger },
  });
}

async function handleTimelockMinDelayUpdated(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const raw = scValToNative(event.value);
  let oldDelay: number | bigint;
  let newDelay: number | bigint;

  if (Array.isArray(raw)) {
    oldDelay = raw[0] as number | bigint;
    newDelay = raw[1] as number | bigint;
  } else {
    const data = raw as Record<string, unknown>;
    oldDelay = data.old_delay as number | bigint;
    newDelay = data.new_delay as number | bigint;
  }

  broadcast({
    type: "timelock_min_delay_updated",
    data: { old_delay: String(oldDelay), new_delay: String(newDelay), ledger: event.ledger },
  });
}

async function handleTimelockDependencyDagValidated(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const raw = scValToNative(event.value);
  let batchOpId: string;
  let opCount: number;

  if (Array.isArray(raw)) {
    batchOpId = bytesToHex(raw[0]);
    opCount = Number(raw[1]);
  } else {
    const data = raw as Record<string, unknown>;
    batchOpId = bytesToHex(data.batch_op_id ?? data[0]);
    opCount = Number(data.op_count ?? data[1]);
  }

  await pool.query(
    `INSERT INTO timelock_dependency_graphs
       (validation_id, batch_op_id, op_count, has_cycle, ledger)
     VALUES ($1, $2, $3, FALSE, $4)
     ON CONFLICT (validation_id) DO NOTHING`,
    [
      timelockEventId(event, "DependencyDagValidated"),
      batchOpId || null,
      opCount,
      event.ledger,
    ],
  );
  if (batchOpId) invalidate(`timelock:dag:${batchOpId}`);
  broadcast({
    type: "timelock_dependency_dag_validated",
    data: { batch_op_id: batchOpId, op_count: opCount, ledger: event.ledger },
  });
}

async function handleTimelockCycleDetected(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const raw = scValToNative(event.value);
  const cyclePath: string[] = Array.isArray(raw) ? raw.map(bytesToHex) : [];

  await pool.query(
    `INSERT INTO timelock_dependency_graphs
       (validation_id, batch_op_id, op_count, has_cycle, cycle_path, ledger)
     VALUES ($1, NULL, $2, TRUE, $3, $4)
     ON CONFLICT (validation_id) DO NOTHING`,
    [
      timelockEventId(event, "CycleDetected"),
      cyclePath.length,
      JSON.stringify(cyclePath),
      event.ledger,
    ],
  );
  broadcast({
    type: "timelock_cycle_detected",
    data: { cycle_path: cyclePath, ledger: event.ledger },
  });
}

async function handleTimelockPartialBatchStarted(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const raw = scValToNative(event.value);
  let batchOpId: string;
  let totalOps: number;

  if (Array.isArray(raw)) {
    batchOpId = bytesToHex(raw[0]);
    totalOps = Number(raw[1]);
  } else {
    const data = raw as Record<string, unknown>;
    batchOpId = bytesToHex(data.batch_op_id ?? data[0]);
    totalOps = Number(data.total_ops ?? data[1]);
  }

  await pool.query(
    `INSERT INTO timelock_partial_batch_state
       (batch_op_id, total_ops, completed_ops, status, started_at_ledger, updated_at_ledger)
     VALUES ($1, $2, 0, 'in_progress', $3, $3)
     ON CONFLICT (batch_op_id) DO UPDATE SET
       total_ops = EXCLUDED.total_ops,
       status = 'in_progress',
       updated_at_ledger = EXCLUDED.updated_at_ledger`,
    [batchOpId, totalOps, event.ledger],
  );
  invalidate(`timelock:partial_state:${batchOpId}`);
  broadcast({
    type: "timelock_partial_batch_started",
    data: { batch_op_id: batchOpId, total_ops: totalOps, ledger: event.ledger },
  });
}

async function handleTimelockPartialOpSucceeded(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const raw = scValToNative(event.value);
  let batchOpId: string;
  let opId: string;
  let completed: number;
  let total: number;

  if (Array.isArray(raw)) {
    batchOpId = bytesToHex(raw[0]);
    opId = bytesToHex(raw[1]);
    completed = Number(raw[2]);
    total = Number(raw[3]);
  } else {
    const data = raw as Record<string, unknown>;
    batchOpId = bytesToHex(data.batch_op_id ?? data[0]);
    opId = bytesToHex(data.op_id ?? data[1]);
    completed = Number(data.completed ?? data[2]);
    total = Number(data.total ?? data[3]);
  }

  await pool.query(
    `UPDATE timelock_partial_batch_state
     SET completed_ops = $2, total_ops = $3, last_op_id = $4, last_status = 'succeeded', updated_at_ledger = $5
     WHERE batch_op_id = $1`,
    [batchOpId, completed, total, opId, event.ledger],
  );
  invalidate(`timelock:partial_state:${batchOpId}`);
  broadcast({
    type: "timelock_partial_op_succeeded",
    data: { batch_op_id: batchOpId, op_id: opId, completed, total, ledger: event.ledger },
  });
}

async function handleTimelockPartialOpFailed(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const raw = scValToNative(event.value);
  let batchOpId: string;
  let opId: string;

  if (Array.isArray(raw)) {
    batchOpId = bytesToHex(raw[0]);
    opId = bytesToHex(raw[1]);
  } else {
    const data = raw as Record<string, unknown>;
    batchOpId = bytesToHex(data.batch_op_id ?? data[0]);
    opId = bytesToHex(data.op_id ?? data[1]);
  }

  await pool.query(
    `UPDATE timelock_partial_batch_state
     SET last_op_id = $2, last_status = 'failed', updated_at_ledger = $3
     WHERE batch_op_id = $1`,
    [batchOpId, opId, event.ledger],
  );
  invalidate(`timelock:partial_state:${batchOpId}`);
  broadcast({
    type: "timelock_partial_op_failed",
    data: { batch_op_id: batchOpId, op_id: opId, ledger: event.ledger },
  });
}

async function handleTimelockBatchRecoveryEntered(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const raw = scValToNative(event.value);
  let batchOpId: string;
  let recoveryDeadline: number;

  if (Array.isArray(raw)) {
    batchOpId = bytesToHex(raw[0]);
    recoveryDeadline = Number(raw[1]);
  } else {
    const data = raw as Record<string, unknown>;
    batchOpId = bytesToHex(data.batch_op_id ?? data[0]);
    recoveryDeadline = Number(data.recovery_deadline ?? data[1]);
  }

  await pool.query(
    `UPDATE timelock_partial_batch_state
     SET status = 'recovery', recovery_deadline = $2, updated_at_ledger = $3
     WHERE batch_op_id = $1`,
    [batchOpId, recoveryDeadline, event.ledger],
  );
  invalidate(`timelock:partial_state:${batchOpId}`);
  broadcast({
    type: "timelock_batch_recovery_entered",
    data: { batch_op_id: batchOpId, recovery_deadline: recoveryDeadline, ledger: event.ledger },
  });
}

async function handleTimelockFailedOpRetried(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const raw = scValToNative(event.value);
  let batchOpId: string;
  let opId: string;
  let retryCount: number;
  let succeeded: boolean;

  if (Array.isArray(raw)) {
    batchOpId = bytesToHex(raw[0]);
    opId = bytesToHex(raw[1]);
    retryCount = Number(raw[2]);
    succeeded = Boolean(raw[3]);
  } else {
    const data = raw as Record<string, unknown>;
    batchOpId = bytesToHex(data.batch_op_id ?? data[0]);
    opId = bytesToHex(data.op_id ?? data[1]);
    retryCount = Number(data.retry_count ?? data[2]);
    succeeded = Boolean(data.succeeded ?? data[3]);
  }

  await pool.query(
    `UPDATE timelock_partial_batch_state
     SET last_op_id = $2, retry_count = $3, last_status = $4, updated_at_ledger = $5
     WHERE batch_op_id = $1`,
    [batchOpId, opId, retryCount, succeeded ? 'succeeded' : 'failed', event.ledger],
  );
  invalidate(`timelock:partial_state:${batchOpId}`);
  broadcast({
    type: "timelock_failed_op_retried",
    data: { batch_op_id: batchOpId, op_id: opId, retry_count: retryCount, succeeded, ledger: event.ledger },
  });
}

async function handleTimelockFailedOpSkipped(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const raw = scValToNative(event.value);
  let batchOpId: string;
  let opId: string;

  if (Array.isArray(raw)) {
    batchOpId = bytesToHex(raw[0]);
    opId = bytesToHex(raw[1]);
  } else {
    const data = raw as Record<string, unknown>;
    batchOpId = bytesToHex(data.batch_op_id ?? data[0]);
    opId = bytesToHex(data.op_id ?? data[1]);
  }

  await pool.query(
    `UPDATE timelock_partial_batch_state
     SET last_op_id = $2, last_status = 'skipped', updated_at_ledger = $3
     WHERE batch_op_id = $1`,
    [batchOpId, opId, event.ledger],
  );
  invalidate(`timelock:partial_state:${batchOpId}`);
  broadcast({
    type: "timelock_failed_op_skipped",
    data: { batch_op_id: batchOpId, op_id: opId, ledger: event.ledger },
  });
}

async function handleTimelockBatchFullyComplete(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const raw = scValToNative(event.value);
  let batchOpId: string;

  if (Array.isArray(raw)) {
    batchOpId = bytesToHex(raw[0]);
  } else if (typeof raw === "object" && raw !== null && "batch_op_id" in raw) {
    batchOpId = bytesToHex((raw as any).batch_op_id);
  } else {
    batchOpId = bytesToHex(raw);
  }

  await pool.query(
    `UPDATE timelock_partial_batch_state
     SET status = 'completed', completed_at_ledger = $2, updated_at_ledger = $2
     WHERE batch_op_id = $1`,
    [batchOpId, event.ledger],
  );
  await pool.query(
    `UPDATE timelock_batch_operations
     SET status = 'executed', executed_at_ledger = COALESCE(executed_at_ledger, $2)
     WHERE batch_op_id = $1`,
    [batchOpId, event.ledger],
  );
  invalidate(`timelock:partial_state:${batchOpId}`, `timelock:batch:${batchOpId}`);
  invalidatePattern("timelock:batches:");
  broadcast({
    type: "timelock_batch_fully_complete",
    data: { batch_op_id: batchOpId, ledger: event.ledger },
  });
}
