import {
  TransactionBuilder,
  BASE_FEE,
  Keypair,
  nativeToScVal,
  scValToNative,
  xdr,
  SorobanRpc,
} from "@stellar/stellar-sdk";
import {
  VoteSupport,
  VoteType,
  ProposalVotes,
  CanProposeResult,
  VotingHistoryEntry,
} from "../types";
import { GovernorClient, toBigInt } from "./governor-client";
import { getProposalState, getLatestLedger } from "./queries";

/**
 * Simulate `cast_vote` and return the estimated resource cost without submitting.
 */
export async function estimateVoteGas(
  client: GovernorClient,
  voter: string,
  proposalId: bigint,
  support: VoteSupport,
): Promise<{
  ok: boolean;
  error?: string;
  cpuInsns?: string;
  memBytes?: string;
  estimatedFeeStroops?: string;
}> {
  return client.retry(async () => {
    try {
      const account = await client.server.getAccount(voter);
      const supportScVal = xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol(VoteSupport[support]),
      ]);

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: client.networkPassphrase,
      })
        .addOperation(
          client.contract.call(
            "cast_vote",
            nativeToScVal(voter, { type: "address" }),
            nativeToScVal(proposalId, { type: "u64" }),
            supportScVal,
          ),
        )
        .setTimeout(30)
        .build();

      const result = await client.server.simulateTransaction(tx);
      if (SorobanRpc.Api.isSimulationError(result)) {
        const err = result as unknown as { error?: string };
        return { ok: false, error: err.error ?? "Simulation failed" };
      }

      const success = result as SorobanRpc.Api.SimulateTransactionSuccessResponse & {
        cost?: { cpuInsns?: string; memBytes?: string; cpuInstructions?: number; memoryBytes?: number };
        minResourceFee?: unknown;
        min_resource_fee?: unknown;
      };

      return {
        ok: true,
        cpuInsns:
          success.cost?.cpuInsns ??
          success.cost?.cpuInstructions?.toString(),
        memBytes:
          success.cost?.memBytes ??
          success.cost?.memoryBytes?.toString(),
        estimatedFeeStroops: toBigInt(
          success.minResourceFee ?? success.min_resource_fee ?? BASE_FEE,
        ).toString(),
      };
    } catch (e: unknown) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : "estimate failed",
      };
    }
  });
}

/**
 * Cast a vote on an active proposal.
 *
 * @returns The Stellar transaction hash, suitable for linking to a block explorer.
 */
export async function castVote(
  client: GovernorClient,
  signer: Keypair,
  proposalId: bigint,
  support: VoteSupport,
): Promise<string> {
  return client.retry(async () => {
    const account = await client.server.getAccount(signer.publicKey());

    const supportScVal = xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol(VoteSupport[support]),
    ]);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: client.networkPassphrase,
    })
      .addOperation(
        client.contract.call(
          "cast_vote",
          nativeToScVal(signer.publicKey(), { type: "address" }),
          nativeToScVal(proposalId, { type: "u64" }),
          supportScVal,
        ),
      )
      .setTimeout(30)
      .build();

    const prepared = await client.server.prepareTransaction(tx);
    prepared.sign(signer);
    const result = await client.server.sendTransaction(prepared);
    if (result.status === "ERROR") {
      throw new Error(`castVote failed: ${JSON.stringify(result)}`);
    }
    await client.pollForConfirmation(result.hash);
    return result.hash;
  }, (e) => client.isRetryableSubmissionError(e));
}

/**
 * Same as {@link castVote} but signs with a wallet callback.
 */
export async function castVoteWithSign(
  client: GovernorClient,
  signerPublicKey: string,
  proposalId: bigint,
  support: VoteSupport,
  signUnsignedXdr: (xdr: string) => Promise<string>
): Promise<void> {
  const account = await client.server.getAccount(signerPublicKey);

  const supportScVal = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol(VoteSupport[support]),
  ]);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: client.networkPassphrase,
  })
    .addOperation(
      client.contract.call(
        "cast_vote",
        nativeToScVal(signerPublicKey, { type: "address" }),
        nativeToScVal(proposalId, { type: "u64" }),
        supportScVal
      )
    )
    .setTimeout(30)
    .build();

  const prepared = await client.server.prepareTransaction(tx);
  const signedXdr = await signUnsignedXdr(prepared.toXDR());
  const signed = TransactionBuilder.fromXDR(signedXdr, client.networkPassphrase);
  const result = await client.server.sendTransaction(signed);
  if (result.status === "ERROR") {
    throw new Error(`castVoteWithSign failed: ${JSON.stringify(result)}`);
  }
  await client.pollForConfirmation(result.hash);
}

/**
 * Cast a vote with an on-chain reason string.
 */
export async function castVoteWithReason(
  client: GovernorClient,
  signer: Keypair,
  proposalId: bigint,
  support: VoteSupport,
  reason: string,
): Promise<void> {
  const account = await client.server.getAccount(signer.publicKey());

  const supportScVal = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol(VoteSupport[support]),
  ]);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: client.networkPassphrase,
  })
    .addOperation(
      client.contract.call(
        "cast_vote_with_reason",
        nativeToScVal(signer.publicKey(), { type: "address" }),
        nativeToScVal(proposalId, { type: "u64" }),
        supportScVal,
        nativeToScVal(reason, { type: "string" }),
      ),
    )
    .setTimeout(30)
    .build();

  const prepared = await client.server.prepareTransaction(tx);
  prepared.sign(signer);
  const result = await client.server.sendTransaction(prepared);
  if (result.status === "ERROR") {
    throw new Error(`castVoteWithReason failed: ${JSON.stringify(result)}`);
  }
  await client.pollForConfirmation(result.hash);
}

/**
 * Same as {@link castVoteWithReason} but signs with a wallet callback.
 */
export async function castVoteWithReasonAndSign(
  client: GovernorClient,
  signerPublicKey: string,
  proposalId: bigint,
  support: VoteSupport,
  reason: string,
  signUnsignedXdr: (xdr: string) => Promise<string>,
): Promise<void> {
  const account = await client.server.getAccount(signerPublicKey);

  const supportScVal = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol(VoteSupport[support]),
  ]);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: client.networkPassphrase,
  })
    .addOperation(
      client.contract.call(
        "cast_vote_with_reason",
        nativeToScVal(signerPublicKey, { type: "address" }),
        nativeToScVal(proposalId, { type: "u64" }),
        supportScVal,
        nativeToScVal(reason, { type: "string" }),
      ),
    )
    .setTimeout(30)
    .build();

  const prepared = await client.server.prepareTransaction(tx);
  const signedXdr = await signUnsignedXdr(prepared.toXDR());
  const signed = TransactionBuilder.fromXDR(signedXdr, client.networkPassphrase);
  const result = await client.server.sendTransaction(signed);
  if (result.status === "ERROR") {
    throw new Error(`castVoteWithReasonAndSign failed: ${JSON.stringify(result)}`);
  }
  await client.pollForConfirmation(result.hash);
}

/**
 * Get vote breakdown for a proposal.
 */
export async function getProposalVotes(
  client: GovernorClient,
  proposalId: bigint,
): Promise<ProposalVotes> {
  return client.retry(async () => {
    const result = await client.server.simulateTransaction(
      new TransactionBuilder(
        await client.server.getAccount(client.readAccount()),
        { fee: BASE_FEE, networkPassphrase: client.networkPassphrase },
      )
        .addOperation(
          client.contract.call(
            "proposal_votes",
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

    const [votesFor, votesAgainst, votesAbstain] = scValToNative(raw) as [
      bigint,
      bigint,
      bigint,
    ];
    return { votesFor, votesAgainst, votesAbstain };
  });
}

/**
 * Check if an address has voted on a proposal.
 * Returns true if the address has cast a vote.
 */
export async function hasVoted(
  client: GovernorClient,
  proposalId: bigint,
  voter: string,
): Promise<boolean> {
  return client.retry(async () => {
    try {
      const result = await client.server.simulateTransaction(
        new TransactionBuilder(
          await client.server.getAccount(client.readAccount()),
          { fee: BASE_FEE, networkPassphrase: client.networkPassphrase }
        )
          .addOperation(
            client.contract.call(
              "has_voted",
              nativeToScVal(proposalId, { type: "u64" }),
              nativeToScVal(voter, { type: "address" })
            )
          )
          .setTimeout(30)
          .build()
      );

      if (SorobanRpc.Api.isSimulationError(result)) {
        return false;
      }

      const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result?.retval;
      return raw ? Boolean(scValToNative(raw)) : false;
    } catch {
      return false;
    }
  });
}

/**
 * Check whether an address can currently submit a proposal.
 *
 * This combines all proposal eligibility checks into a single RPC call:
 * paused state, proposal threshold, cooldown period, and rate limit per period.
 *
 * @param proposer The address to check
 * @returns A structured result indicating if the address is allowed to propose
 */
export async function canPropose(
  client: GovernorClient,
  proposer: string,
): Promise<CanProposeResult> {
  return client.retry(async () => {
    const result = await client.server.simulateTransaction(
      new TransactionBuilder(
        await client.server.getAccount(client.config.governorAddress),
        { fee: BASE_FEE, networkPassphrase: client.networkPassphrase },
      )
        .addOperation(
          client.contract.call(
            "can_propose",
            nativeToScVal(proposer, { type: "address" }),
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

    const native = scValToNative(raw) as Record<string, unknown>;
    return {
      allowed: Boolean(native.allowed),
      reason: String(native.reason ?? "unknown"),
      cooldownEndsAt: native.cooldown_ends_at 
        ? Number(native.cooldown_ends_at) 
        : undefined,
      proposalsThisPeriod: Number(native.proposals_this_period ?? 0),
      maxPerPeriod: Number(native.max_per_period ?? 0),
      votingPower: toBigInt(native.voting_power ?? 0),
      threshold: toBigInt(native.threshold ?? 0),
    };
  });
}

/**
 * Get voting history for a specific address across all proposals.
 *
 * Scans VoteCast/vote events filtering by voter address. If an indexer is configured
 * via the indexerUrl in GovernorConfig, it will use the indexer API for faster results.
 *
 * @param voter The address to get voting history for
 * @param opts Optional parameters for pagination
 * @returns Array of voting history entries sorted by ledger descending (most recent first)
 */
export async function getVotingHistory(
  client: GovernorClient,
  voter: string,
  opts?: { fromLedger?: number; limit?: number }
): Promise<VotingHistoryEntry[]> {
  const limit = opts?.limit ?? 50;
  
  // Try indexer first if configured
  if (client.config.indexerUrl) {
    try {
      const response = await fetch(`${client.config.indexerUrl}/profile/${voter}`);
      if (response.ok) {
        const data = await response.json() as { votes?: any[] };
        const votes = data.votes || [];
        return votes
          .map((v: any) => ({
            proposalId: toBigInt(v.proposal_id),
            support: v.support,
            weight: toBigInt(v.weight),
            reason: v.reason,
            ledger: Number(v.ledger),
          }))
          .sort((a: VotingHistoryEntry, b: VotingHistoryEntry) => b.ledger - a.ledger)
          .slice(0, limit);
      }
    } catch (e) {
      console.warn("Indexer query failed, falling back to event scan:", e);
    }
  }

  // Fallback to event scanning
  return client.retry(async () => {
    const events = await client.server.getEvents({
      filters: [
        {
          type: "contract",
          contractIds: [client.config.governorAddress],
          topics: [["VoteCast", "vote"], [voter]],
        },
      ],
      limit: limit * 2, // Fetch extra to filter for relevant events
    });

    const history: VotingHistoryEntry[] = [];
    for (const event of events.events) {
      if (!event.topic || event.topic.length < 2) continue;
      
      // Check if voter matches (second topic)
      const voterTopic = scValToNative(event.topic[1]);
      if (String(voterTopic) !== voter) continue;

      // Parse event data
      const data = event.value;
      if (!data) continue;

      const native = scValToNative(data) as Record<string, unknown>;
      const proposalId = toBigInt(native.proposal_id ?? native.proposalId);
      const supportRaw = native.support ?? native.support;
      const support = typeof supportRaw === "number" 
        ? supportRaw 
        : Number(supportRaw);
      const weight = toBigInt(native.weight ?? 0);
      const reason = native.reason as string | undefined;
      const ledger = Number(event.ledger);

      history.push({
        proposalId,
        support: support as VoteSupport,
        weight,
        reason,
        ledger,
      });
    }

    // Sort by ledger descending and apply limit
    return history
      .sort((a, b) => b.ledger - a.ledger)
      .slice(0, limit);
  });
}

/**
 * Return recent on-chain votes cast by a voter by scanning `VoteCast` events.
 * Useful for profile pages without requiring an indexer endpoint.
 */
export async function getVotesCastByAddress(
  client: GovernorClient,
  voter: string,
  opts?: { fromLedger?: number; limit?: number },
): Promise<
  Array<{
    proposalId: bigint;
    support: VoteSupport;
    weight: bigint;
    ledger: number;
  }>
> {
  const limit = Math.max(1, Math.min(opts?.limit ?? 50, 200));
  const contractId = client.contract.contractId();
  const topic = [
    xdr.ScVal.scvSymbol("VoteCast").toXDR("base64"),
    nativeToScVal(voter, { type: "address" }).toXDR("base64"),
  ];

  const latest = await getLatestLedger(client);
  let cursor = opts?.fromLedger ?? 1;
  if (cursor < 1) cursor = 1;

  const results: Array<{
    proposalId: bigint;
    support: VoteSupport;
    weight: bigint;
    ledger: number;
  }> = [];

  while (cursor <= latest) {
    const response = await client.retry(async () => {
      return await client.server.getEvents({
        startLedger: cursor,
        filters: [
          {
            type: "contract",
            contractIds: [contractId],
            topics: [topic],
          },
        ],
        limit: 100,
      });
    }, client.isNetworkError.bind(client));

    const events = response.events ?? [];
    if (events.length === 0) break;

    let maxLedger = cursor;
    for (const event of events) {
      try {
        const value = scValToNative(event.value) as any;
        const proposalId = BigInt(value?.proposal_id);
        const supportRaw = Number(value?.support);
        const weight = BigInt(value?.weight ?? 0);

        const support =
          supportRaw === 0
            ? VoteSupport.Against
            : supportRaw === 1
              ? VoteSupport.For
              : VoteSupport.Abstain;

        results.push({ proposalId, support, weight, ledger: event.ledger });
      } catch {
        // ignore malformed event
      }
      if (event.ledger > maxLedger) maxLedger = event.ledger;
    }

    if (results.length >= limit) break;
    cursor = maxLedger + 1;
  }

  return results
    .sort((a, b) => b.ledger - a.ledger)
    .slice(0, limit);
}

/**
 * Get the voting receipt for a specific voter on a proposal.
 *
 * Returns whether the voter has voted, their support choice, vote weight, and reason.
 */
export async function getReceipt(
  client: GovernorClient,
  proposalId: bigint,
  voter: string,
): Promise<{
  hasVoted: boolean;
  support: VoteSupport;
  weight: bigint;
  reason: string;
}> {
  return client.retry(async () => {
    const result = await client.server.simulateTransaction(
      new TransactionBuilder(
        await client.server.getAccount(client.readAccount()),
        { fee: BASE_FEE, networkPassphrase: client.networkPassphrase },
      )
        .addOperation(
          client.contract.call(
            "get_receipt",
            nativeToScVal(proposalId, { type: "u64" }),
            nativeToScVal(voter, { type: "address" }),
          ),
        )
        .setTimeout(30)
        .build(),
    );

    if (SorobanRpc.Api.isSimulationError(result)) {
      return {
        hasVoted: false,
        support: VoteSupport.Against,
        weight: 0n,
        reason: "",
      };
    }

    const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
      .result?.retval;
    if (!raw) {
      return {
        hasVoted: false,
        support: VoteSupport.Against,
        weight: 0n,
        reason: "",
      };
    }

    const receipt = scValToNative(raw) as {
      has_voted: boolean;
      support: string[];
      weight: bigint;
      reason: string;
    };

    // Decode support enum (vector-wrapped symbol)
    const supportMap: Record<string, VoteSupport> = {
      Against: VoteSupport.Against,
      For: VoteSupport.For,
      Abstain: VoteSupport.Abstain,
    };
    const supportVariant = receipt.support[0];
    const support = supportMap[supportVariant] ?? VoteSupport.Against;

    return {
      hasVoted: receipt.has_voted,
      support,
      weight: BigInt(receipt.weight),
      reason: receipt.reason,
    };
  });
}

/**
 * Return the on-chain vote reason for a voter on a proposal.
 * Empty string means no reason recorded.
 */
export async function getVoteReason(
  client: GovernorClient,
  proposalId: bigint,
  voter: string,
): Promise<string> {
  const receipt = await getReceipt(client, proposalId, voter);
  return receipt.reason ?? "";
}
