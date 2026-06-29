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
};

export interface IndexerConfig {
  rpcUrl: string;
  governorAddress: string;
  wrapperAddress?: string;
  treasuryAddress?: string;
  liquidityAddress?: string;
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
  topics: unknown[],
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
  topics: unknown[],
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
