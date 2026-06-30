import {
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
  xdr,
  SorobanRpc,
} from "@stellar/stellar-sdk";
import {
  GovernorSettings,
  ProposalState,
  UnknownProposalStateError,
  VoteType,
} from "../types";
import { GovernorClient, toBigInt } from "./governor-client";
import type { ProposalVotes } from "../types";

/** Minimum voting power required to create a proposal (`proposal_threshold`). */
export async function proposalThreshold(
  client: GovernorClient,
): Promise<bigint> {
  return client.retry(async () => {
    const result = await client.server.simulateTransaction(
      new TransactionBuilder(
        await client.server.getAccount(client.readAccount()),
        { fee: BASE_FEE, networkPassphrase: client.networkPassphrase },
      )
        .addOperation(client.contract.call("proposal_threshold"))
        .setTimeout(30)
        .build(),
    );

    if (SorobanRpc.Api.isSimulationError(result)) return 0n;
    const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
      .result?.retval;
    return raw ? BigInt(scValToNative(raw) as number | bigint | string) : 0n;
  });
}

/** Read the full governor settings struct via `get_settings()`. */
export async function getSettings(
  client: GovernorClient,
  sourceAccount?: string,
): Promise<GovernorSettings> {
  return client.retry(async () => {
    const readAccount = client.readAccount(sourceAccount);
    const result = await client.server.simulateTransaction(
      new TransactionBuilder(await client.server.getAccount(readAccount), {
        fee: BASE_FEE,
        networkPassphrase: client.networkPassphrase,
      })
        .addOperation(client.contract.call("get_settings"))
        .setTimeout(30)
        .build(),
    );

    if (SorobanRpc.Api.isSimulationError(result)) {
      throw new Error(`Simulation error: ${result.error}`);
    }

    const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
      .result?.retval;
    if (!raw) throw new Error("No settings return value");

    const native = scValToNative(raw) as Record<string, unknown>;
    const voteTypeRaw = native.vote_type;
    const voteTypeValue = Array.isArray(voteTypeRaw)
      ? String(voteTypeRaw[0] ?? "")
      : String(voteTypeRaw ?? "");
    const voteType =
      voteTypeValue === VoteType.Simple ||
      voteTypeValue === VoteType.Quadratic
        ? (voteTypeValue as VoteType)
        : VoteType.Extended;

    return {
      votingDelay: Number(native.voting_delay ?? 0),
      votingPeriod: Number(native.voting_period ?? 0),
      quorumNumerator: Number(native.quorum_numerator ?? 0),
      proposalThreshold: toBigInt(native.proposal_threshold),
      guardian: String(native.guardian ?? ""),
      voteType,
      proposalGracePeriod: Number(native.proposal_grace_period ?? 0),
      useDynamicQuorum: Boolean(native.use_dynamic_quorum ?? false),
      reflectorOracle: native.reflector_oracle
        ? String(native.reflector_oracle)
        : null,
      minQuorumUsd: toBigInt(native.min_quorum_usd),
      maxCalldataSize: Number(native.max_calldata_size ?? 10_000),
      proposalCooldown: Number(native.proposal_cooldown ?? 100),
      maxProposalsPerPeriod: Number(native.max_proposals_per_period ?? 5),
      proposalPeriodDuration: Number(native.proposal_period_duration ?? 10_000),
    };
  });
}

/**
 * Get the current state of a proposal.
 * TODO issue #17: decode all 7 ProposalState variants.
 */
export async function getProposalState(
  client: GovernorClient,
  proposalId: bigint,
): Promise<ProposalState> {
  return client.retry(async () => {
    const result = await client.server.simulateTransaction(
      new TransactionBuilder(
        await client.server.getAccount(client.readAccount()),
        { fee: BASE_FEE, networkPassphrase: client.networkPassphrase },
      )
        .addOperation(
          client.contract.call(
            "state",
            nativeToScVal(proposalId, { type: "u64" }),
          ),
        )
        .setTimeout(30)
        .build(),
    );

    if (SorobanRpc.Api.isSimulationError(result)) {
      throw new Error(`Simulation error: ${result.error}`);
    }

    const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
      .result?.retval;
    if (!raw) throw new Error("No return value");

    return decodeProposalState(raw);
  });
}

/**
 * Decode the Soroban enum ScVal (vector-wrapped symbol) to ProposalState.
 */
export function decodeProposalState(raw: xdr.ScVal): ProposalState {
  const native = scValToNative(raw);
  if (!Array.isArray(native) || native.length === 0) {
    throw new Error("Invalid ScVal format for ProposalState enum");
  }

  const variant = native[0];
  const states: Record<string, ProposalState> = {
    Pending: ProposalState.Pending,
    Active: ProposalState.Active,
    Defeated: ProposalState.Defeated,
    Succeeded: ProposalState.Succeeded,
    Queued: ProposalState.Queued,
    Executed: ProposalState.Executed,
    Cancelled: ProposalState.Cancelled,
    Expired: ProposalState.Expired,
  };

  if (variant in states) {
    return states[variant];
  }

  throw new UnknownProposalStateError(variant);
}

/**
 * Get the quorum required for a specific proposal.
 * The quorum is calculated based on the total supply at the proposal's start ledger.
 */
export async function getQuorum(
  client: GovernorClient,
  proposalId: bigint,
): Promise<bigint> {
  const result = await client.server.simulateTransaction(
    new TransactionBuilder(
      await client.server.getAccount(client.config.governorAddress),
      { fee: BASE_FEE, networkPassphrase: client.networkPassphrase },
    )
      .addOperation(
        client.contract.call(
          "get_quorum",
          nativeToScVal(proposalId, { type: "u64" }),
        ),
      )
      .setTimeout(30)
      .build(),
  );

  if (SorobanRpc.Api.isSimulationError(result)) {
    throw new Error(`Simulation error: ${result.error}`);
  }

  const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
    .result?.retval;
  if (!raw) throw new Error("No return value");

  const quorum = BigInt(scValToNative(raw));
  return quorum;
}

/**
 * Check if a proposal has reached quorum.
 * Returns true if the sum of for and abstain votes meets or exceeds the required quorum.
 */
export async function isQuorumReached(
  client: GovernorClient,
  proposalId: bigint,
): Promise<boolean> {
  const result = await client.server.simulateTransaction(
    new TransactionBuilder(
      await client.server.getAccount(client.config.governorAddress),
      { fee: BASE_FEE, networkPassphrase: client.networkPassphrase },
    )
      .addOperation(
        client.contract.call(
          "is_quorum_reached",
          nativeToScVal(proposalId, { type: "u64" }),
        ),
      )
      .setTimeout(30)
      .build(),
  );

  if (SorobanRpc.Api.isSimulationError(result)) {
    throw new Error(`Simulation error: ${result.error}`);
  }

  const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
    .result?.retval;
  if (!raw) throw new Error("No return value");

  const isReached = scValToNative(raw) as boolean;
  return isReached;
}

/** Current Soroban ledger sequence from the RPC backing this client. */
export async function getLatestLedger(
  client: GovernorClient,
): Promise<number> {
  return client.retry(async () => {
    const info = await client.server.getLatestLedger();
    return info.sequence;
  });
}

/**
 * Poll `getProposalState` until the state changes (compared to the prior poll).
 *
 * The first successful poll establishes a baseline and does **not** invoke `onChange`.
 * Unsubscribe with the returned function to stop polling.
 */
export function onProposalStateChange(
  client: GovernorClient,
  proposalId: bigint,
  onChange: (newState: ProposalState) => void,
  pollIntervalMs: number = 10_000,
): () => void {
  let stopped = false;
  let previous: ProposalState | undefined;

  const tick = async () => {
    if (stopped) return;
    try {
      const state = await getProposalState(client, proposalId);
      if (previous !== undefined && state !== previous) {
        onChange(state);
      }
      previous = state;
    } catch {
      // Transient RPC errors — retry on next tick
    }
  };

  void tick();
  const handle = setInterval(() => void tick(), pollIntervalMs);
  return () => {
    stopped = true;
    clearInterval(handle);
  };
}

/**
 * Get total number of proposals.
 */
export async function proposalCount(
  client: GovernorClient,
): Promise<bigint> {
  return client.retry(async () => {
    const result = await client.server.simulateTransaction(
      new TransactionBuilder(
        await client.server.getAccount(client.readAccount()),
        { fee: BASE_FEE, networkPassphrase: client.networkPassphrase },
      )
        .addOperation(client.contract.call("proposal_count"))
        .setTimeout(30)
        .build(),
    );

    if (SorobanRpc.Api.isSimulationError(result)) return 0n;

    const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
      .result?.retval;
    return raw ? BigInt(scValToNative(raw)) : 0n;
  });
}

/**
 * Get a single proposal from the indexer API (fast path).
 * Falls back to on-chain queries if indexer is unavailable.
 * 
 * @param proposalId The proposal ID to fetch
 * @param indexerUrl Optional indexer API URL (defaults to environment variable)
 * @returns The proposal data or null if not found
 */
export async function getProposalFromIndexer(
  client: GovernorClient,
  proposalId: bigint, 
  indexerUrl?: string
): Promise<any | null> {
  const url = indexerUrl || process.env.INDEXER_API_URL;
  
  if (!url) {
    // No indexer configured, fall back to on-chain query
    console.warn("No indexer URL configured, falling back to on-chain queries");
    return null;
  }

  try {
    const response = await fetch(`${url}/proposals/${proposalId}`);
    
    if (response.status === 404) {
      return null;
    }
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    return await response.json();
  } catch (error) {
    console.warn(`Indexer query failed for proposal ${proposalId}:`, error);
    return null;
  }
}

/**
 * Get the last proposal ledger for an address.
 */
export async function getLastProposalLedger(
  client: GovernorClient,
  address: string,
): Promise<number> {
  return client.retry(async () => {
    const result = await client.server.simulateTransaction(
      new TransactionBuilder(
        await client.server.getAccount(client.config.governorAddress),
        { fee: BASE_FEE, networkPassphrase: client.networkPassphrase },
      )
        .addOperation(
          client.contract.call(
            "last_proposal_ledger",
            nativeToScVal(address, { type: "address" }),
          ),
        )
        .setTimeout(30)
        .build(),
    );
    if (SorobanRpc.Api.isSimulationError(result)) return 0;
    const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
      .result?.retval;
    return raw ? Number(scValToNative(raw)) : 0;
  });
}

/**
 * Get the number of proposals in the current period for an address.
 */
export async function getProposalsInPeriod(
  client: GovernorClient,
  address: string,
): Promise<number> {
  return client.retry(async () => {
    const result = await client.server.simulateTransaction(
      new TransactionBuilder(
        await client.server.getAccount(client.config.governorAddress),
        { fee: BASE_FEE, networkPassphrase: client.networkPassphrase },
      )
        .addOperation(
          client.contract.call(
            "proposals_in_period",
            nativeToScVal(address, { type: "address" }),
          ),
        )
        .setTimeout(30)
        .build(),
    );
    if (SorobanRpc.Api.isSimulationError(result)) return 0;
    const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
      .result?.retval;
    return raw ? Number(scValToNative(raw)) : 0;
  });
}

/**
 * Fetch state + votes for multiple proposals in parallel.
 *
 * Useful for the proposals list page — replaces sequential fetching with a
 * single batched round-trip per chunk of proposals.
 *
 * @param proposalIds Array of proposal IDs to query
 * @param concurrency Max simultaneous RPC calls (default 10)
 */
export async function getProposalsSummaryBatch(
  client: GovernorClient,
  proposalIds: bigint[],
  concurrency = 10,
): Promise<Array<{ id: bigint; state?: ProposalState; votes?: ProposalVotes; error?: Error }>> {
  // Import dynamically to avoid circular dependency
  const { getProposalVotes } = await import("./voting");
  
  const results: Array<{ id: bigint; state?: ProposalState; votes?: ProposalVotes; error?: Error }> = [];

  for (let i = 0; i < proposalIds.length; i += concurrency) {
    const chunk = proposalIds.slice(i, i + concurrency);
    const settled = await Promise.allSettled(
      chunk.map((id) =>
        Promise.all([
          getProposalState(client, id),
          getProposalVotes(client, id),
        ]),
      ),
    );
    for (let j = 0; j < chunk.length; j++) {
      const outcome = settled[j];
      if (outcome.status === "fulfilled") {
        const [state, votes] = outcome.value;
        results.push({ id: chunk[j], state, votes });
      } else {
        results.push({ id: chunk[j], error: outcome.reason as Error });
      }
    }
  }

  return results;
}