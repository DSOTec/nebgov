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
  Strategy,
  Allocation,
  StrategyPerformancePoint,
  IndexedStrategy,
} from "./types";
import {
  TreasuryStrategiesError,
  TreasuryStrategiesErrorCode,
  parseTreasuryStrategiesError,
} from "./errors";
import { withRetry, isNetworkError } from "./utils";

export type TreasuryStrategiesConfig = GovernorConfig;

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

function mapStrategy(raw: any): Strategy {
  return {
    adapter: raw.adapter,
    token: raw.token,
    maxAllocationBps: Number(raw.max_allocation_bps),
    withdrawalCooldownLedgers: Number(raw.withdrawal_cooldown_ledgers),
    active: Boolean(raw.active),
  };
}

function mapAllocation(raw: any): Allocation {
  return {
    strategyId: Number(raw.strategy_id),
    amount: BigInt(raw.amount ?? 0),
    depositedLedger: Number(raw.deposited_ledger),
  };
}

function mapPerformancePoint(raw: any): StrategyPerformancePoint {
  return {
    amount: BigInt(raw.amount ?? 0),
    ledger: Number(raw.ledger),
    createdAt: String(raw.created_at),
  };
}

function mapIndexedStrategy(raw: any): IndexedStrategy {
  return {
    strategyId: Number(raw.strategy_id),
    adapter: raw.adapter,
    token: raw.token,
    active: Boolean(raw.active),
    currentAllocation: BigInt(raw.current_allocation ?? 0),
    registeredLedger: Number(raw.registered_ledger),
  };
}

/**
 * TreasuryStrategiesClient — governance-controlled yield strategy allocation
 * for idle treasury funds (Issue #997), exposed on a standalone
 * `contracts/treasury-strategies` deployment.
 *
 * `register_strategy` / `deactivate_strategy` (admin-gated) and `deposit`
 * (treasury-gated) are not exposed here: on-chain, their `caller` must
 * equal the configured admin/treasury *address*, which in production is
 * itself a contract (the treasury multisig) rather than a signable
 * `Keypair` — those calls are made by governance's own submit/approve
 * flow against `contracts/treasury`, not by an SDK consumer directly. This
 * client covers the methods a treasury-strategies deployment's data
 * consumers and the permissionless withdrawal-claim path actually need.
 *
 * ## On-chain methods
 * - {@link getStrategy} — a strategy's stored configuration
 * - {@link getAllocation} — a strategy's current allocation
 * - {@link getTotalValue} — live sum of adapter-reported value for a token
 * - {@link requestWithdrawal} / {@link requestWithdrawalWithSign} — start a
 *   withdrawal's cooldown (caller must be the on-chain treasury address)
 * - {@link claimWithdrawal} / {@link claimWithdrawalWithSign} — permissionless
 *   once the cooldown has elapsed
 *
 * ## Indexer-backed methods
 * Require `config.indexerUrl`:
 * - {@link listStrategies} — filterable list of indexed strategies
 * - {@link getPerformanceHistory} — indexed principal-deposited time series
 * - {@link getPerformanceHistoryPage} — same, with pagination metadata
 *
 * @example
 * ```ts
 * const client = new TreasuryStrategiesClient({
 *   governorAddress: "CABC...",
 *   timelockAddress: "CDEF...",
 *   votesAddress: "CGHI...",
 *   treasuryStrategiesAddress: "CJKL...",
 *   network: "testnet",
 *   indexerUrl: "https://indexer.example.com",
 * });
 *
 * const strategy = await client.getStrategy(1);
 * const totalValue = await client.getTotalValue(tokenAddress);
 * ```
 */
export class TreasuryStrategiesClient {
  private readonly config: TreasuryStrategiesConfig;
  private readonly server: SorobanRpc.Server;
  private readonly contract: Contract;
  private readonly networkPassphrase: string;

  constructor(config: TreasuryStrategiesConfig) {
    if (!config.treasuryStrategiesAddress) {
      throw new TreasuryStrategiesError(
        TreasuryStrategiesErrorCode.SimulationFailed,
        "TreasuryStrategiesClient requires config.treasuryStrategiesAddress",
      );
    }
    this.config = config;
    const rpcUrl = config.rpcUrl ?? RPC_URLS[config.network];
    this.server = new SorobanRpc.Server(rpcUrl, { allowHttp: false });
    this.contract = new Contract(config.treasuryStrategiesAddress);
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
    return this.config.simulationAccount ?? this.config.treasuryStrategiesAddress!;
  }

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
        throw parseTreasuryStrategiesError({ status: "ERROR", error: result.error });
      }

      const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result
        ?.retval;
      if (!raw) {
        throw new TreasuryStrategiesError(
          TreasuryStrategiesErrorCode.MissingReturnValue,
          `No return value from ${fnName}`,
        );
      }
      return scValToNative(raw);
    });
  }

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
        throw parseTreasuryStrategiesError(result);
      }
      const confirmed = await this.pollForConfirmation(result.hash);
      return { hash: result.hash, confirmed };
    });
  }

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
        throw parseTreasuryStrategiesError(result);
      }
      const confirmed = await this.pollForConfirmation(result.hash);
      return { hash: result.hash, confirmed };
    });
  }

  private async indexerRequest<T>(path: string): Promise<T> {
    if (!this.config.indexerUrl) {
      throw new TreasuryStrategiesError(
        TreasuryStrategiesErrorCode.SimulationFailed,
        "TreasuryStrategiesClient requires config.indexerUrl to be set for indexer-backed methods",
      );
    }
    return this.retry(async () => {
      const resp = await fetch(`${this.config.indexerUrl}${path}`);
      if (!resp.ok) {
        throw new TreasuryStrategiesError(
          TreasuryStrategiesErrorCode.SimulationFailed,
          `Indexer request failed: ${resp.status}`,
        );
      }
      return resp.json() as Promise<T>;
    });
  }

  // ── On-chain read methods ──────────────────────────────────────────────────

  /** Get a registered strategy's stored configuration. */
  async getStrategy(strategyId: number): Promise<Strategy> {
    const raw = await this.simulate(
      "get_strategy",
      nativeToScVal(strategyId, { type: "u64" }),
    );
    return mapStrategy(raw);
  }

  /** Get a strategy's current on-chain allocation. */
  async getAllocation(strategyId: number): Promise<Allocation> {
    const raw = await this.simulate(
      "get_allocation",
      nativeToScVal(strategyId, { type: "u64" }),
    );
    return mapAllocation(raw);
  }

  /**
   * Live sum of `adapter_balance()` across every active strategy for
   * `token` — includes accrued yield or loss, unlike the indexer's
   * principal-only {@link getPerformanceHistory}.
   */
  async getTotalValue(token: string): Promise<bigint> {
    const raw = await this.simulate(
      "get_total_value",
      nativeToScVal(token, { type: "address" }),
    );
    return BigInt(raw as string | number | bigint);
  }

  // ── On-chain write methods ─────────────────────────────────────────────────

  /**
   * Start a withdrawal's cooldown. On-chain, `caller` must equal the
   * configured treasury address — `signer` here pays for and authorizes the
   * transaction, so it only succeeds when `signer`'s address is itself the
   * treasury (in practice, invoked via the treasury contract's own
   * submit/approve flow rather than a plain Keypair in production).
   *
   * @returns The new withdrawal's id
   */
  async requestWithdrawal(
    signer: Keypair,
    strategyId: number,
    amount: bigint,
  ): Promise<number> {
    const withdrawalId = await this.retry(async () => {
      const account = await this.server.getAccount(signer.publicKey());
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            "request_withdrawal",
            nativeToScVal(signer.publicKey(), { type: "address" }),
            nativeToScVal(strategyId, { type: "u64" }),
            nativeToScVal(amount, { type: "i128" }),
          ),
        )
        .setTimeout(30)
        .build();

      const prepared = await this.server.prepareTransaction(tx);
      prepared.sign(signer);
      const result = await this.server.sendTransaction(prepared);
      if (result.status === "ERROR") {
        throw parseTreasuryStrategiesError(result);
      }
      const confirmed = await this.pollForConfirmation(result.hash);
      const retval = confirmed.returnValue;
      if (!retval) {
        throw new TreasuryStrategiesError(
          TreasuryStrategiesErrorCode.MissingReturnValue,
          "No return value from request_withdrawal",
        );
      }
      return scValToNative(retval) as bigint | number;
    });
    return Number(withdrawalId);
  }

  /** Wallet-extension signing variant of {@link requestWithdrawal}. */
  async requestWithdrawalWithSign(
    signerPublicKey: string,
    strategyId: number,
    amount: bigint,
    signUnsignedXdr: (xdr: string) => Promise<string>,
  ): Promise<number> {
    const withdrawalId = await this.retry(async () => {
      const account = await this.server.getAccount(signerPublicKey);
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            "request_withdrawal",
            nativeToScVal(signerPublicKey, { type: "address" }),
            nativeToScVal(strategyId, { type: "u64" }),
            nativeToScVal(amount, { type: "i128" }),
          ),
        )
        .setTimeout(30)
        .build();

      const prepared = await this.server.prepareTransaction(tx);
      const signedXdr = await signUnsignedXdr(prepared.toXDR());
      const signed = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);

      const result = await this.server.sendTransaction(signed);
      if (result.status === "ERROR") {
        throw parseTreasuryStrategiesError(result);
      }
      const confirmed = await this.pollForConfirmation(result.hash);
      const retval = confirmed.returnValue;
      if (!retval) {
        throw new TreasuryStrategiesError(
          TreasuryStrategiesErrorCode.MissingReturnValue,
          "No return value from request_withdrawal",
        );
      }
      return scValToNative(retval) as bigint | number;
    });
    return Number(withdrawalId);
  }

  /**
   * Claim a withdrawal once its cooldown has elapsed. Permissionless —
   * `signer` only pays for the transaction, the contract does not check
   * their identity.
   *
   * @returns Transaction hash of the confirmed claim transaction
   */
  async claimWithdrawal(signer: Keypair, withdrawalId: number): Promise<string> {
    const { hash } = await this.submit(
      signer,
      "claim_withdrawal",
      nativeToScVal(withdrawalId, { type: "u64" }),
    );
    return hash;
  }

  /** Wallet-extension signing variant of {@link claimWithdrawal}. */
  async claimWithdrawalWithSign(
    signerPublicKey: string,
    withdrawalId: number,
    signUnsignedXdr: (xdr: string) => Promise<string>,
  ): Promise<string> {
    const { hash } = await this.submitWithSign(
      signerPublicKey,
      signUnsignedXdr,
      "claim_withdrawal",
      nativeToScVal(withdrawalId, { type: "u64" }),
    );
    return hash;
  }

  // ── Indexer-backed read methods ────────────────────────────────────────────

  /**
   * List indexed strategies, optionally filtered by token and/or active
   * status. Hits `GET /treasury-strategies`. Not part of the issue's
   * illustrative SDK snippet, but needed to render a strategies table
   * without querying every `strategyId` individually — added following the
   * same pattern as `ProposalBondsClient.listBonds`. Requires
   * `config.indexerUrl`.
   */
  async listStrategies(
    options: { token?: string; active?: boolean; limit?: number; offset?: number } = {},
  ): Promise<IndexedStrategy[]> {
    const clampedLimit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const params = new URLSearchParams({
      limit: String(clampedLimit),
      offset: String(Math.max(options.offset ?? 0, 0)),
    });
    if (options.token) params.set("token", options.token);
    if (options.active !== undefined) params.set("active", String(options.active));
    const { strategies } = await this.indexerRequest<{ strategies: any[] }>(
      `/treasury-strategies?${params}`,
    );
    return (strategies ?? []).map(mapIndexedStrategy);
  }

  /**
   * Fetch a strategy's indexed principal-deposited history as a flat array.
   *
   * Hits `GET /treasury-strategies/:id/performance`. This is *principal
   * only* — it does not include accrued yield or loss, since that requires
   * a live on-chain read; pair it with {@link getTotalValue} for a full
   * yield/loss chart. Requires `config.indexerUrl`.
   *
   * @param strategyId - Strategy id
   * @param limit      - Maximum number of entries to return (default 50, max 200)
   * @param offset     - Number of entries to skip for pagination (default 0)
   */
  async getPerformanceHistory(
    strategyId: number,
    limit = 50,
    offset = 0,
  ): Promise<StrategyPerformancePoint[]> {
    const clampedLimit = Math.min(Math.max(limit, 1), 200);
    const params = new URLSearchParams({
      limit: String(clampedLimit),
      offset: String(Math.max(offset, 0)),
    });
    const { principal_history } = await this.indexerRequest<{ principal_history: any[] }>(
      `/treasury-strategies/${strategyId}/performance?${params}`,
    );
    return (principal_history ?? []).map(mapPerformancePoint);
  }

  /** Same as {@link getPerformanceHistory}, with pagination metadata. */
  async getPerformanceHistoryPage(
    strategyId: number,
    limit = 50,
    offset = 0,
  ): Promise<{
    history: StrategyPerformancePoint[];
    pagination: { limit: number; offset: number; hasMore: boolean };
  }> {
    const clampedLimit = Math.min(Math.max(limit, 1), 200);
    const safeOffset = Math.max(offset, 0);
    const params = new URLSearchParams({
      limit: String(clampedLimit),
      offset: String(safeOffset),
    });
    const raw = await this.indexerRequest<{
      principal_history: any[];
      pagination: { limit: number; offset: number; hasMore: boolean };
    }>(`/treasury-strategies/${strategyId}/performance?${params}`);

    return {
      history: (raw.principal_history ?? []).map(mapPerformancePoint),
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
        throw new TreasuryStrategiesError(
          TreasuryStrategiesErrorCode.TransactionFailed,
          `Transaction failed: ${hash}`,
        );
      }
    }
    throw new TreasuryStrategiesError(
      TreasuryStrategiesErrorCode.TransactionTimeout,
      `Transaction not confirmed after ${retries} retries`,
    );
  }
}
