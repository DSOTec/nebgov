import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  Keypair,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import {
  GovernorConfig,
  Network,
  ProposerReputation,
  ReputationScoreEntry,
  ReputationScoreHistoryPage,
  ProposerLeaderboardEntry,
  ReputationLeaderboardPage,
  ReputationSummary,
  ThresholdHistoryEntry,
  ThresholdHistoryPage,
} from "./types";
import { GovernorError, GovernorErrorCode, parseGovernorError } from "./errors";
import { withRetry, isNetworkError } from "./utils";

interface SubmitResult {
  hash: string;
  confirmed: SorobanRpc.Api.GetSuccessfulTransactionResponse;
}

const RPC_URLS: Record<Network, string> = {
  mainnet: "https://soroban-rpc.mainnet.stellar.gateway.fm",
  testnet: "https://soroban-testnet.stellar.org",
  futurenet: "https://rpc-futurenet.stellar.org",
};

const NETWORK_PASSPHRASES: Record<Network, string> = {
  mainnet: Networks.PUBLIC,
  testnet: Networks.TESTNET,
  futurenet: Networks.FUTURENET,
};

function mapProposerReputation(raw: any): ProposerReputation {
  return {
    proposer: raw.proposer,
    totalProposals: Number(raw.total_proposals),
    totalParticipationBpsSum: BigInt(raw.total_participation_bps_sum ?? 0),
    lastProposalLedger: Number(raw.last_proposal_ledger),
    reputationScore: Number(raw.reputation_score),
    thresholdMultiplierBps: Number(raw.threshold_multiplier_bps),
    firstProposalLedger: Number(raw.first_proposal_ledger),
    consecutiveSuccessful: Number(raw.consecutive_successful),
    consecutiveFailed: Number(raw.consecutive_failed),
  };
}

function mapScoreEntry(r: any): ReputationScoreEntry {
  return {
    ledger: Number(r.ledger),
    score: Number(r.score),
    change: Number(r.change),
    reason: String(r.reason),
  };
}

function mapLeaderboardEntry(r: any, fallbackRank: number): ProposerLeaderboardEntry {
  return {
    rank: r.rank != null ? Number(r.rank) : fallbackRank,
    proposer: r.proposer ?? r.address,
    reputationScore: Number(r.reputation_score),
    lastUpdatedLedger: r.last_updated_ledger != null ? Number(r.last_updated_ledger) : null,
  };
}

function mapThresholdEntry(r: any): ThresholdHistoryEntry {
  return {
    ledger: Number(r.ledger),
    oldThreshold: BigInt(r.old_threshold ?? 0),
    newThreshold: BigInt(r.new_threshold ?? 0),
  };
}

/**
 * ReputationClient — interact with the Proposer Reputation System (Issue
 * #771) exposed on a deployed NebGov governor contract.
 *
 * The reputation functions live directly on the governor contract (not a
 * separate deployment), so this client targets `config.governorAddress`
 * just like {@link GovernorClient}.
 *
 * ## On-chain methods
 * These simulate or submit transactions against the governor contract:
 * - {@link getProposerReputation} — full on-chain reputation record
 * - {@link getEffectiveThreshold} — reputation-adjusted proposal threshold
 * - {@link applyDecay} — permissionless decay step (Keypair signing)
 * - {@link applyDecayWithSign} — same, for wallet-extension signing flows
 *
 * ## Indexer-backed methods
 * These require `config.indexerUrl` and hit the indexer's REST API, which
 * mirrors `ReputationUpdated` / `EffectiveThresholdChanged` events off-chain
 * (scoring parameters are fixed compile-time constants kept off the contract
 * to stay under Soroban's WASM size budget):
 * - {@link getScore} — fast cached summary for a single proposer
 * - {@link getScoreHistory} — paginated score-change timeline
 * - {@link getScoreHistoryPage} — single page with pagination metadata
 * - {@link getLeaderboard} — top-N proposers by score
 * - {@link getLeaderboardPage} — single page with offset + pagination metadata
 * - {@link getThresholdHistory} — paginated effective-threshold change log
 * - {@link getThresholdHistoryPage} — single page with pagination metadata
 *
 * All indexer methods follow the exact `AnalyticsClient` / `TreasuryClient`
 * pattern: throw {@link GovernorError} with `SimulationFailed` if
 * `config.indexerUrl` is unset, and on non-2xx responses.
 *
 * @example
 * ```ts
 * const client = new ReputationClient({
 *   governorAddress: "CABC...",
 *   timelockAddress: "CDEF...",
 *   votesAddress: "CGHI...",
 *   network: "testnet",
 *   indexerUrl: "https://indexer.example.com",
 * });
 *
 * // On-chain reads
 * const rep       = await client.getProposerReputation(address);
 * const threshold = await client.getEffectiveThreshold(address);
 *
 * // Indexer reads
 * const summary   = await client.getScore(address);
 * const history   = await client.getScoreHistory(address);
 * const board     = await client.getLeaderboard(50);
 * const thHistory = await client.getThresholdHistory(address);
 * ```
 */
export class ReputationClient {
  private readonly config: GovernorConfig;
  private readonly server: SorobanRpc.Server;
  private readonly contract: Contract;
  private readonly networkPassphrase: string;

  constructor(config: GovernorConfig) {
    this.config = config;
    const rpcUrl = config.rpcUrl ?? RPC_URLS[config.network];
    this.server = new SorobanRpc.Server(rpcUrl, { allowHttp: false });
    this.contract = new Contract(config.governorAddress);
    this.networkPassphrase = NETWORK_PASSPHRASES[config.network];
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async retry<T>(fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, {
      maxAttempts: this.config.maxAttempts,
      baseDelayMs: this.config.baseDelayMs,
      retryOn: isNetworkError,
    });
  }

  private readAccount(): string {
    return this.config.simulationAccount ?? this.config.governorAddress;
  }

  /**
   * Execute a read-only simulation against the governor contract and return
   * the native-decoded return value. Throws {@link GovernorError} on
   * simulation failure or missing return value.
   */
  private async simulate(fnName: string, ...args: xdr.ScVal[]): Promise<unknown> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(await this.server.getAccount(this.readAccount()), {
          fee: BASE_FEE,
          networkPassphrase: this.networkPassphrase,
        })
          .addOperation(this.contract.call(fnName, ...args))
          .setTimeout(30)
          .build(),
      );

      if (SorobanRpc.Api.isSimulationError(result)) {
        throw parseGovernorError({ status: "ERROR", error: result.error });
      }

      const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result
        ?.retval;
      if (!raw) {
        throw new GovernorError(
          GovernorErrorCode.SimulationFailed,
          `No return value from ${fnName}`,
        );
      }
      return scValToNative(raw);
    });
  }

  /**
   * Build, sign, and submit a transaction using a {@link Keypair}. Polls
   * until confirmed or timed out.
   */
  private async submit(
    signer: Keypair,
    fnName: string,
    ...args: xdr.ScVal[]
  ): Promise<SubmitResult> {
    return this.retry(async () => {
      const account = await this.server.getAccount(signer.publicKey());
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(this.contract.call(fnName, ...args))
        .setTimeout(30)
        .build();

      const prepared = await this.server.prepareTransaction(tx);
      prepared.sign(signer);

      const result = await this.server.sendTransaction(prepared);
      if (result.status === "ERROR") {
        throw parseGovernorError(result);
      }
      const confirmed = await this.pollForConfirmation(result.hash);
      return { hash: result.hash, confirmed };
    });
  }

  /**
   * Same as {@link submit}, but accepts a wallet-extension signing callback
   * instead of a raw {@link Keypair}. Used by browser-based dApps where the
   * private key is never exposed to the SDK.
   */
  private async submitWithSign(
    signerPublicKey: string,
    signUnsignedXdr: (xdr: string) => Promise<string>,
    fnName: string,
    ...args: xdr.ScVal[]
  ): Promise<SubmitResult> {
    return this.retry(async () => {
      const account = await this.server.getAccount(signerPublicKey);
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(this.contract.call(fnName, ...args))
        .setTimeout(30)
        .build();

      const prepared = await this.server.prepareTransaction(tx);
      const signedXdr = await signUnsignedXdr(prepared.toXDR());
      const signed = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);

      const result = await this.server.sendTransaction(signed);
      if (result.status === "ERROR") {
        throw parseGovernorError(result);
      }
      const confirmed = await this.pollForConfirmation(result.hash);
      return { hash: result.hash, confirmed };
    });
  }

  /**
   * Shared indexer fetch helper — mirrors `AnalyticsClient.indexerRequest`.
   *
   * Throws {@link GovernorError} with `SimulationFailed` when:
   * - `config.indexerUrl` is not set
   * - the indexer responds with a non-2xx status
   *
   * Retries on transient network errors using the same `withRetry` policy
   * as the on-chain methods.
   */
  private async indexerRequest<T>(path: string): Promise<T> {
    if (!this.config.indexerUrl) {
      throw new GovernorError(
        GovernorErrorCode.SimulationFailed,
        `ReputationClient requires config.indexerUrl to be set for indexer-backed methods`,
      );
    }
    return this.retry(async () => {
      const resp = await fetch(`${this.config.indexerUrl}${path}`);
      if (!resp.ok) {
        throw new GovernorError(
          GovernorErrorCode.SimulationFailed,
          `Indexer request failed: ${resp.status}`,
        );
      }
      return resp.json() as Promise<T>;
    });
  }

  // ── On-chain read methods ──────────────────────────────────────────────────

  /**
   * Get a proposer's full on-chain reputation record.
   *
   * Returns zero-valued defaults for every field when the address has no
   * proposal history yet (the contract never throws for unknown addresses).
   *
   * @param proposer - Stellar strkey address of the proposer
   */
  async getProposerReputation(proposer: string): Promise<ProposerReputation> {
    const raw = await this.simulate(
      "get_proposer_reputation",
      nativeToScVal(proposer, { type: "address" }),
    );
    return mapProposerReputation(raw);
  }

  /**
   * Reputation-adjusted effective proposal threshold for `proposer`.
   *
   * This is the value `propose()` actually checks — it equals
   * `proposal_threshold × threshold_multiplier_bps / 10000`. Falls back to
   * the flat `proposal_threshold` when reputation is disabled or the address
   * has no history yet.
   *
   * @param proposer - Stellar strkey address of the proposer
   */
  async getEffectiveThreshold(proposer: string): Promise<bigint> {
    const raw = await this.simulate(
      "get_effective_threshold",
      nativeToScVal(proposer, { type: "address" }),
    );
    return BigInt(raw as string | number | bigint);
  }

  // ── On-chain write methods ─────────────────────────────────────────────────

  /**
   * Permissionless: decay `proposer`'s reputation score one step back toward
   * zero based on ledgers elapsed since it was last touched.
   *
   * `signer` only pays the transaction fee — the contract does not check
   * their identity. Anyone can call this on behalf of any address.
   *
   * @param signer   - Keypair that will sign and pay for the transaction
   * @param proposer - Stellar strkey address whose score should be decayed
   * @returns Transaction hash of the confirmed decay transaction
   */
  async applyDecay(signer: Keypair, proposer: string): Promise<string> {
    const { hash } = await this.submit(
      signer,
      "apply_reputation_decay",
      nativeToScVal(proposer, { type: "address" }),
    );
    return hash;
  }

  /**
   * Wallet-extension signing variant of {@link applyDecay}.
   *
   * Use this in browser-based dApps where the private key is managed by a
   * wallet extension (e.g. Freighter) and never exposed to the SDK.
   *
   * @param signerPublicKey  - Stellar strkey public key of the signing account
   * @param proposer         - Stellar strkey address whose score should be decayed
   * @param signUnsignedXdr  - Callback that signs the prepared XDR and returns the signed XDR
   * @returns Transaction hash of the confirmed decay transaction
   */
  async applyDecayWithSign(
    signerPublicKey: string,
    proposer: string,
    signUnsignedXdr: (xdr: string) => Promise<string>,
  ): Promise<string> {
    const { hash } = await this.submitWithSign(
      signerPublicKey,
      signUnsignedXdr,
      "apply_reputation_decay",
      nativeToScVal(proposer, { type: "address" }),
    );
    return hash;
  }

  // ── Indexer-backed read methods ────────────────────────────────────────────

  /**
   * Fetch the indexer's cached reputation summary for a single proposer.
   *
   * Hits `GET /reputation/:address`. Faster than an on-chain simulation for
   * display-only use cases (e.g. profile pages, proposal cards). The
   * authoritative source for threshold calculations is always the on-chain
   * contract via {@link getProposerReputation} / {@link getEffectiveThreshold}.
   *
   * Requires `config.indexerUrl`.
   *
   * @param proposer - Stellar strkey address of the proposer
   */
  async getScore(proposer: string): Promise<ReputationSummary> {
    const raw = await this.indexerRequest<any>(`/reputation/${proposer}`);
    return {
      address: raw.address ?? proposer,
      reputationScore: Number(raw.reputation_score ?? 0),
      lastUpdatedLedger: raw.last_updated_ledger != null
        ? Number(raw.last_updated_ledger)
        : null,
    };
  }

  /**
   * Fetch the full score-change history for a proposer as a flat array.
   *
   * Hits `GET /reputation/:address/history` and auto-collects all entries
   * up to `limit` (default 50, max 200 per the indexer). For cursor-based
   * pagination with `offset` control, use {@link getScoreHistoryPage} instead.
   *
   * Requires `config.indexerUrl`.
   *
   * @param proposer - Stellar strkey address of the proposer
   * @param limit    - Maximum number of entries to return (default 50, max 200)
   * @param offset   - Number of entries to skip for pagination (default 0)
   */
  async getScoreHistory(
    proposer: string,
    limit = 50,
    offset = 0,
  ): Promise<ReputationScoreEntry[]> {
    const clampedLimit = Math.min(Math.max(limit, 1), 200);
    const params = new URLSearchParams({
      limit: String(clampedLimit),
      offset: String(Math.max(offset, 0)),
    });
    const { history } = await this.indexerRequest<{ history: any[] }>(
      `/reputation/${proposer}/history?${params}`,
    );
    return (history ?? []).map(mapScoreEntry);
  }

  /**
   * Fetch a single page of score history with full pagination metadata.
   *
   * Use this when you need to implement paginated UI (e.g. "load more"
   * buttons) and need to know whether more pages exist. For simple
   * all-at-once fetches, use {@link getScoreHistory} instead.
   *
   * Requires `config.indexerUrl`.
   *
   * @param proposer - Stellar strkey address of the proposer
   * @param limit    - Page size (default 50, max 200)
   * @param offset   - Page offset (default 0)
   */
  async getScoreHistoryPage(
    proposer: string,
    limit = 50,
    offset = 0,
  ): Promise<ReputationScoreHistoryPage> {
    const clampedLimit = Math.min(Math.max(limit, 1), 200);
    const safeOffset = Math.max(offset, 0);
    const params = new URLSearchParams({
      limit: String(clampedLimit),
      offset: String(safeOffset),
    });
    const raw = await this.indexerRequest<{
      history: any[];
      pagination: { limit: number; offset: number; hasMore: boolean };
    }>(`/reputation/${proposer}/history?${params}`);

    return {
      history: (raw.history ?? []).map(mapScoreEntry),
      pagination: {
        limit: raw.pagination?.limit ?? clampedLimit,
        offset: raw.pagination?.offset ?? safeOffset,
        hasMore: raw.pagination?.hasMore ?? false,
      },
    };
  }

  /**
   * Fetch the top-N proposers by reputation score as a flat array.
   *
   * Hits `GET /reputation/leaderboard?limit=N&offset=O`. The leaderboard is
   * computed off-chain by the indexer from `ReputationUpdated` events — it
   * is not an on-chain read function (kept off the contract to stay under
   * Soroban's WASM size budget).
   *
   * For paginated access with offset control and pagination metadata, use
   * {@link getLeaderboardPage} instead.
   *
   * Requires `config.indexerUrl`.
   *
   * @param limit  - Number of entries to return (default 50, max 200)
   * @param offset - Number of entries to skip (default 0)
   */
  async getLeaderboard(limit = 50, offset = 0): Promise<ProposerLeaderboardEntry[]> {
    const clampedLimit = Math.min(Math.max(limit, 1), 200);
    const params = new URLSearchParams({
      limit: String(clampedLimit),
      offset: String(Math.max(offset, 0)),
    });
    const { leaderboard } = await this.indexerRequest<{ leaderboard: any[] }>(
      `/reputation/leaderboard?${params}`,
    );
    return (leaderboard ?? []).map((r, i) => mapLeaderboardEntry(r, offset + i + 1));
  }

  /**
   * Fetch a single page of the leaderboard with pagination metadata.
   *
   * Use this when building paginated leaderboard UIs. The `pagination.offset`
   * in the response can be incremented by `pagination.limit` to fetch the
   * next page.
   *
   * Requires `config.indexerUrl`.
   *
   * @param limit  - Page size (default 50, max 200)
   * @param offset - Page offset (default 0)
   */
  async getLeaderboardPage(limit = 50, offset = 0): Promise<ReputationLeaderboardPage> {
    const clampedLimit = Math.min(Math.max(limit, 1), 200);
    const safeOffset = Math.max(offset, 0);
    const params = new URLSearchParams({
      limit: String(clampedLimit),
      offset: String(safeOffset),
    });
    const raw = await this.indexerRequest<{ leaderboard: any[] }>(
      `/reputation/leaderboard?${params}`,
    );
    return {
      leaderboard: (raw.leaderboard ?? []).map((r, i) =>
        mapLeaderboardEntry(r, safeOffset + i + 1),
      ),
      pagination: {
        limit: clampedLimit,
        offset: safeOffset,
      },
    };
  }

  /**
   * Fetch the effective-threshold change history for a proposer as a flat array.
   *
   * Hits `GET /reputation/:address/threshold-history`. Built from
   * `EffectiveThresholdChanged` events indexed off-chain. Returned in
   * descending ledger order (most recent first).
   *
   * For paginated access with metadata, use {@link getThresholdHistoryPage}.
   *
   * Requires `config.indexerUrl`.
   *
   * @param proposer - Stellar strkey address of the proposer
   * @param limit    - Maximum number of entries to return (default 50, max 200)
   * @param offset   - Number of entries to skip (default 0)
   */
  async getThresholdHistory(
    proposer: string,
    limit = 50,
    offset = 0,
  ): Promise<ThresholdHistoryEntry[]> {
    const clampedLimit = Math.min(Math.max(limit, 1), 200);
    const params = new URLSearchParams({
      limit: String(clampedLimit),
      offset: String(Math.max(offset, 0)),
    });
    const { history } = await this.indexerRequest<{ history: any[] }>(
      `/reputation/${proposer}/threshold-history?${params}`,
    );
    return (history ?? []).map(mapThresholdEntry);
  }

  /**
   * Fetch a single page of threshold history with pagination metadata.
   *
   * Requires `config.indexerUrl`.
   *
   * @param proposer - Stellar strkey address of the proposer
   * @param limit    - Page size (default 50, max 200)
   * @param offset   - Page offset (default 0)
   */
  async getThresholdHistoryPage(
    proposer: string,
    limit = 50,
    offset = 0,
  ): Promise<ThresholdHistoryPage> {
    const clampedLimit = Math.min(Math.max(limit, 1), 200);
    const safeOffset = Math.max(offset, 0);
    const params = new URLSearchParams({
      limit: String(clampedLimit),
      offset: String(safeOffset),
    });
    const raw = await this.indexerRequest<{
      history: any[];
      pagination: { limit: number; offset: number; hasMore: boolean };
    }>(`/reputation/${proposer}/threshold-history?${params}`);

    return {
      history: (raw.history ?? []).map(mapThresholdEntry),
      pagination: {
        limit: raw.pagination?.limit ?? clampedLimit,
        offset: raw.pagination?.offset ?? safeOffset,
        hasMore: raw.pagination?.hasMore ?? false,
      },
    };
  }

  // ── Private: transaction polling ──────────────────────────────────────────

  private async pollForConfirmation(
    hash: string,
    retries = 10,
    delayMs = 2000,
  ): Promise<SorobanRpc.Api.GetSuccessfulTransactionResponse> {
    for (let i = 0; i < retries; i++) {
      await new Promise((r) => setTimeout(r, delayMs));
      const status = await this.retry(() => this.server.getTransaction(hash));
      if (status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        return status as SorobanRpc.Api.GetSuccessfulTransactionResponse;
      }
      if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        throw new GovernorError(
          GovernorErrorCode.TransactionFailed,
          `Transaction failed: ${hash}`,
        );
      }
    }
    throw new GovernorError(
      GovernorErrorCode.TransactionTimeout,
      `Transaction not confirmed after ${retries} retries`,
    );
  }
}
