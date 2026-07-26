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
  ReputationUpdated: "ReputationUpdated",
  EffectiveThresholdChanged: "EffectiveThresholdChanged",
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
            case "stream_created":
              await handleStreamCreated(event);
              break;
            case "stream_spend":
              await handleStreamSpend(event);
              break;
            case "stream_batch":
              await handleStreamBatchSpend(event);
              break;
            case "stream_revoked":
              await handleStreamRevoked(event);
              break;
            case "stream_extended":
              await handleStreamExtended(event);
              break;
            case "stream_topped_up":
              await handleStreamToppedUp(event);
              break;
            case "stream_exhausted":
              await handleStreamExhausted(event);
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

  await pool.query(
    `INSERT INTO effective_threshold_history (proposer_address, ledger, old_threshold, new_threshold)
     VALUES ($1, $2, $3, $4)`,
    [proposer, event.ledger, oldThreshold.toString(), newThreshold.toString()],
  );

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

async function handleStreamCreated(
  event: SorobanRpc.Api.EventResponse,
): Promise<void> {
  // Event: value = (stream_id, name, owner)
  const data = scValToNative(event.value) as unknown[];
  const streamId = String(data[0] as bigint);
  const name = String(data[1]);
  const owner = String(data[2]);

  await pool.query(
    `INSERT INTO treasury_stream_events (event_type, stream_id, owner, name, ledger)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    ["stream_created", streamId, owner, name, event.ledger],
  );
}

async function handleStreamSpend(
  event: SorobanRpc.Api.EventResponse,
): Promise<void> {
  // Event: value = (stream_id, recipient, amount)
  const data = scValToNative(event.value) as unknown[];
  const streamId = String(data[0] as bigint);
  const recipient = String(data[1]);
  const amount = String(data[2] as bigint);

  await pool.query(
    `INSERT INTO treasury_stream_events (event_type, stream_id, recipient, amount, ledger)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    ["stream_spend", streamId, recipient, amount, event.ledger],
  );
}

async function handleStreamBatchSpend(
  event: SorobanRpc.Api.EventResponse,
): Promise<void> {
  // Event: value = (stream_id, total_amount, recipient_count)
  const data = scValToNative(event.value) as unknown[];
  const streamId = String(data[0] as bigint);
  const totalAmount = String(data[1] as bigint);
  const recipientCount = Number(data[2]);

  await pool.query(
    `INSERT INTO treasury_stream_events (event_type, stream_id, total_amount, recipient_count, ledger)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    ["stream_batch", streamId, totalAmount, recipientCount, event.ledger],
  );
}

async function handleStreamRevoked(
  event: SorobanRpc.Api.EventResponse,
): Promise<void> {
  // Event: value = (stream_id, caller, unspent_returned)
  const data = scValToNative(event.value) as unknown[];
  const streamId = String(data[0] as bigint);
  const caller = String(data[1]);
  const unspentReturned = String(data[2] as bigint);

  await pool.query(
    `INSERT INTO treasury_stream_events (event_type, stream_id, caller, unspent_returned, ledger)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    ["stream_revoked", streamId, caller, unspentReturned, event.ledger],
  );
}

async function handleStreamExtended(
  event: SorobanRpc.Api.EventResponse,
): Promise<void> {
  // Event: value = (stream_id, old_end, new_end)
  const data = scValToNative(event.value) as unknown[];
  const streamId = String(data[0] as bigint);
  const oldEnd = Number(data[1]);
  const newEnd = Number(data[2]);

  await pool.query(
    `INSERT INTO treasury_stream_events (event_type, stream_id, old_end_ledger, new_end_ledger, ledger)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    ["stream_extended", streamId, oldEnd, newEnd, event.ledger],
  );
}

async function handleStreamToppedUp(
  event: SorobanRpc.Api.EventResponse,
): Promise<void> {
  // Event: value = (stream_id, additional, new_total)
  const data = scValToNative(event.value) as unknown[];
  const streamId = String(data[0] as bigint);
  const additional = String(data[1] as bigint);
  const newTotal = String(data[2] as bigint);

  await pool.query(
    `INSERT INTO treasury_stream_events (event_type, stream_id, additional_amount, new_total_amount, ledger)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    ["stream_topped_up", streamId, additional, newTotal, event.ledger],
  );
}

async function handleStreamExhausted(
  event: SorobanRpc.Api.EventResponse,
): Promise<void> {
  // Event: value = stream_id
  const streamId = String(scValToNative(event.value) as bigint);

  await pool.query(
    `INSERT INTO treasury_stream_events (event_type, stream_id, ledger)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    ["stream_exhausted", streamId, event.ledger],
  );
}

// --- Co-sponsorship / draft events (#767) ---

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

  await pool.query(`UPDATE drafts SET expired = TRUE WHERE draft_id = $1`, [
    draftId,
  ]);
  invalidatePattern("drafts:");
  broadcast({
    type: "draft_expired",
    data: { draft_id: draftId, ledger: event.ledger },
  });
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

// --- Liquidity event stubs (pre-existing references) ---

async function handleLiquidityAdded(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const account = topics[1] as string;
  const data = scValToNative(event.value) as unknown[];
  const amount = String(data[0] as bigint);
  broadcast({ type: "liquidity_added", data: { account, amount, ledger: event.ledger } });
}

async function handleLiquidityRemoved(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const account = topics[1] as string;
  const data = scValToNative(event.value) as unknown[];
  const amount = String(data[0] as bigint);
  broadcast({ type: "liquidity_removed", data: { account, amount, ledger: event.ledger } });
}

async function handleSwap(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
): Promise<void> {
  const trader = topics[1] as string;
  broadcast({ type: "swap", data: { trader, ledger: event.ledger } });
}

async function handlePoolFeeUpdated(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  broadcast({ type: "pool_fee_updated", data: { ledger: event.ledger } });
}

export async function maybeTakeGovernanceSnapshot(_ledger: number): Promise<void> {
  // Placeholder — governance snapshot logic not yet implemented.
}

// --- Timelock event handlers (#846) ---

function bufToHex(v: unknown): string {
  if (v instanceof Uint8Array) return Buffer.from(v).toString("hex");
  if (Buffer.isBuffer(v)) return v.toString("hex");
  return String(v ?? "");
}

async function logTimelockEvent(
  _eventType: string,
  _ledger: number,
  _data: Record<string, unknown>,
): Promise<void> {
  // No-op: the generic logToEventLog handler at line 130 already writes
  // every event into the event_log table. Timelock-specific table inserts
  // are handled by each dedicated handler.
}

async function handleTimelockOperationScheduled(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const data = scValToNative(event.value) as Record<string, unknown>;
  const opId = bufToHex(data.op_id);
  const target = String(data.target ?? "");
  const fnName = String(data.fn_name ?? "");
  const readyAt = String(data.ready_at ?? "0");
  const expiresAt = String(data.expires_at ?? "0");

  await pool.query(
    `INSERT INTO timelock_operations (op_id, target, fn_name, ready_at, expires_at, status, ledger)
     VALUES ($1, $2, $3, $4, $5, 'scheduled', $6)
     ON CONFLICT (op_id) DO NOTHING`,
    [opId, target, fnName, readyAt, expiresAt, event.ledger],
  );
  broadcast({
    type: "timelock_operation_scheduled",
    data: { op_id: opId, target, fn_name: fnName, ready_at: readyAt, expires_at: expiresAt, ledger: event.ledger },
  });
}

async function handleTimelockOperationExecuted(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const data = scValToNative(event.value) as Record<string, unknown>;
  const opId = bufToHex(data.op_id);
  const caller = String(data.caller ?? "");

  await pool.query(
    `UPDATE timelock_operations SET status = 'executed' WHERE op_id = $1`,
    [opId],
  );
  await logTimelockEvent("timelock_operation_executed", event.ledger, { op_id: opId, caller });
  broadcast({
    type: "timelock_operation_executed",
    data: { op_id: opId, caller, ledger: event.ledger },
  });
}

async function handleTimelockOperationCancelled(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const data = scValToNative(event.value) as Record<string, unknown>;
  const opId = bufToHex(data.op_id);
  const caller = String(data.caller ?? "");

  await pool.query(
    `UPDATE timelock_operations SET status = 'cancelled' WHERE op_id = $1`,
    [opId],
  );
  await logTimelockEvent("timelock_operation_cancelled", event.ledger, { op_id: opId, caller });
  broadcast({
    type: "timelock_operation_cancelled",
    data: { op_id: opId, caller, ledger: event.ledger },
  });
}

async function handleTimelockBatchOperationScheduled(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const data = scValToNative(event.value) as Record<string, unknown>;
  const batchOpId = bufToHex(data.batch_op_id);
  const targets = (data.targets ?? []) as string[];
  const fnNames = (data.fn_names ?? []) as string[];
  const readyAt = String(data.ready_at ?? "0");
  const expiresAt = String(data.expires_at ?? "0");

  await pool.query(
    `INSERT INTO timelock_batch_operations (batch_op_id, target_count, fn_names, ready_at, expires_at, status, ledger)
     VALUES ($1, $2, $3, $4, $5, 'scheduled', $6)
     ON CONFLICT (batch_op_id) DO NOTHING`,
    [batchOpId, targets.length, JSON.stringify(fnNames), readyAt, expiresAt, event.ledger],
  );
  await logTimelockEvent("timelock_batch_operation_scheduled", event.ledger, {
    batch_op_id: batchOpId, target_count: targets.length, ready_at: readyAt, expires_at: expiresAt,
  });
  broadcast({
    type: "timelock_batch_operation_scheduled",
    data: { batch_op_id: batchOpId, target_count: targets.length, ready_at: readyAt, expires_at: expiresAt, ledger: event.ledger },
  });
}

async function handleTimelockBatchOperationExecuted(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const data = scValToNative(event.value) as Record<string, unknown>;
  const batchOpId = bufToHex(data.batch_op_id);
  const caller = String(data.caller ?? "");

  await pool.query(
    `UPDATE timelock_batch_operations SET status = 'executed' WHERE batch_op_id = $1`,
    [batchOpId],
  );
  await logTimelockEvent("timelock_batch_operation_executed", event.ledger, { batch_op_id: batchOpId, caller });
  broadcast({
    type: "timelock_batch_operation_executed",
    data: { batch_op_id: batchOpId, caller, ledger: event.ledger },
  });
}

async function handleTimelockBatchOperationCancelled(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const data = scValToNative(event.value) as Record<string, unknown>;
  const batchOpId = bufToHex(data.batch_op_id);
  const caller = String(data.caller ?? "");

  await pool.query(
    `UPDATE timelock_batch_operations SET status = 'cancelled' WHERE batch_op_id = $1`,
    [batchOpId],
  );
  await logTimelockEvent("timelock_batch_operation_cancelled", event.ledger, { batch_op_id: batchOpId, caller });
  broadcast({
    type: "timelock_batch_operation_cancelled",
    data: { batch_op_id: batchOpId, caller, ledger: event.ledger },
  });
}

async function handleTimelockMinDelayUpdated(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const data = scValToNative(event.value) as Record<string, unknown>;
  const oldDelay = String(data.old_delay ?? "0");
  const newDelay = String(data.new_delay ?? "0");

  await logTimelockEvent("timelock_min_delay_updated", event.ledger, { old_delay: oldDelay, new_delay: newDelay });
  broadcast({
    type: "timelock_min_delay_updated",
    data: { old_delay: oldDelay, new_delay: newDelay, ledger: event.ledger },
  });
}

async function handleTimelockDependencyDagValidated(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const data = scValToNative(event.value) as unknown[];
  const batchOpId = bufToHex(data[0]);
  const opCount = Number(data[1] ?? 0);

  await pool.query(
    `INSERT INTO timelock_dependency_graphs (batch_op_id, op_count, valid, ledger)
     VALUES ($1, $2, true, $3)
     ON CONFLICT (batch_op_id) DO UPDATE SET op_count = $2, valid = true`,
    [batchOpId, opCount, event.ledger],
  );
  await logTimelockEvent("timelock_dependency_dag_validated", event.ledger, { batch_op_id: batchOpId, op_count: opCount });
  broadcast({
    type: "timelock_dependency_dag_validated",
    data: { batch_op_id: batchOpId, op_count: opCount, ledger: event.ledger },
  });
}

async function handleTimelockCycleDetected(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const cyclePath = scValToNative(event.value) as Uint8Array[];
  const pathHex = cyclePath.map((b) => bufToHex(b));

  await pool.query(
    `INSERT INTO timelock_dependency_graphs (batch_op_id, op_count, valid, cycle_path, ledger)
     VALUES ($1, $2, false, $3, $4)
     ON CONFLICT (batch_op_id) DO UPDATE SET valid = false, cycle_path = $3`,
    ["", pathHex.length, JSON.stringify(pathHex), event.ledger],
  );
  await logTimelockEvent("timelock_cycle_detected", event.ledger, { cycle_path: pathHex });
  broadcast({
    type: "timelock_cycle_detected",
    data: { cycle_path: pathHex, ledger: event.ledger },
  });
}

async function handleTimelockPartialBatchStarted(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const data = scValToNative(event.value) as unknown[];
  const batchOpId = bufToHex(data[0]);
  const totalOps = Number(data[1] ?? 0);

  await pool.query(
    `INSERT INTO timelock_partial_batch_state (batch_op_id, total_ops, completed_count, failed_count, pending_count, recovery_mode, ledger)
     VALUES ($1, $2, 0, 0, $2, false, $3)
     ON CONFLICT (batch_op_id) DO UPDATE SET total_ops = $2, pending_count = $2`,
    [batchOpId, totalOps, event.ledger],
  );
  await logTimelockEvent("timelock_partial_batch_started", event.ledger, { batch_op_id: batchOpId, total_ops: totalOps });
  broadcast({
    type: "timelock_partial_batch_started",
    data: { batch_op_id: batchOpId, total_ops: totalOps, ledger: event.ledger },
  });
}

async function handleTimelockPartialOpSucceeded(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const data = scValToNative(event.value) as unknown[];
  const batchOpId = bufToHex(data[0]);
  const opId = bufToHex(data[1]);
  const completed = Number(data[2] ?? 0);
  const total = Number(data[3] ?? 0);

  await pool.query(
    `UPDATE timelock_partial_batch_state
     SET completed_count = $1, pending_count = $2 - $1
     WHERE batch_op_id = $3`,
    [completed, total, batchOpId],
  );
  await logTimelockEvent("timelock_partial_op_succeeded", event.ledger, {
    batch_op_id: batchOpId, op_id: opId, completed, total,
  });
  broadcast({
    type: "timelock_partial_op_succeeded",
    data: { batch_op_id: batchOpId, op_id: opId, completed, total, ledger: event.ledger },
  });
}

async function handleTimelockPartialOpFailed(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const data = scValToNative(event.value) as unknown[];
  const batchOpId = bufToHex(data[0]);
  const opId = bufToHex(data[1]);

  await pool.query(
    `UPDATE timelock_partial_batch_state
     SET failed_count = failed_count + 1, pending_count = pending_count - 1
     WHERE batch_op_id = $1`,
    [batchOpId],
  );
  await logTimelockEvent("timelock_partial_op_failed", event.ledger, { batch_op_id: batchOpId, op_id: opId });
  broadcast({
    type: "timelock_partial_op_failed",
    data: { batch_op_id: batchOpId, op_id: opId, ledger: event.ledger },
  });
}

async function handleTimelockBatchRecoveryEntered(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const data = scValToNative(event.value) as unknown[];
  const batchOpId = bufToHex(data[0]);
  const recoveryDeadline = Number(data[1] ?? 0);

  await pool.query(
    `UPDATE timelock_partial_batch_state
     SET recovery_mode = true, recovery_deadline = $1
     WHERE batch_op_id = $2`,
    [recoveryDeadline, batchOpId],
  );
  await logTimelockEvent("timelock_batch_recovery_entered", event.ledger, {
    batch_op_id: batchOpId, recovery_deadline: recoveryDeadline,
  });
  broadcast({
    type: "timelock_batch_recovery_entered",
    data: { batch_op_id: batchOpId, recovery_deadline: recoveryDeadline, ledger: event.ledger },
  });
}

async function handleTimelockFailedOpRetried(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const data = scValToNative(event.value) as unknown[];
  const batchOpId = bufToHex(data[0]);
  const opId = bufToHex(data[1]);
  const retryCount = Number(data[2] ?? 0);
  const succeeded = Boolean(data[3]);

  await logTimelockEvent("timelock_failed_op_retried", event.ledger, {
    batch_op_id: batchOpId, op_id: opId, retry_count: retryCount, succeeded,
  });
  broadcast({
    type: "timelock_failed_op_retried",
    data: { batch_op_id: batchOpId, op_id: opId, retry_count: retryCount, succeeded, ledger: event.ledger },
  });
}

async function handleTimelockFailedOpSkipped(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const data = scValToNative(event.value) as unknown[];
  const batchOpId = bufToHex(data[0]);
  const opId = bufToHex(data[1]);

  await logTimelockEvent("timelock_failed_op_skipped", event.ledger, { batch_op_id: batchOpId, op_id: opId });
  broadcast({
    type: "timelock_failed_op_skipped",
    data: { batch_op_id: batchOpId, op_id: opId, ledger: event.ledger },
  });
}

async function handleTimelockBatchFullyComplete(
  event: SorobanRpc.Api.EventResponse,
  _topics: unknown[],
): Promise<void> {
  const batchOpId = bufToHex(scValToNative(event.value));

  await pool.query(
    `UPDATE timelock_batch_operations SET status = 'completed' WHERE batch_op_id = $1`,
    [batchOpId],
  );
  await logTimelockEvent("timelock_batch_fully_complete", event.ledger, { batch_op_id: batchOpId });
  broadcast({
    type: "timelock_batch_fully_complete",
    data: { batch_op_id: batchOpId, ledger: event.ledger },
  });
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

