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
import { GovernorConfig, Network } from "./types";
import {
  TimelockError,
  TimelockErrorCode,
  parseTimelockError,
} from "./errors";
import { withRetry, isNetworkError } from "./utils";

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

/**
 * TimelockClient — interact with a deployed NebGov timelock contract.
 *
 * The timelock enforces a mandatory delay between a proposal passing and its
 * on-chain execution, giving token holders time to exit before governance
 * actions take effect.
 *
 * @example
 * const client = new TimelockClient({
 *   governorAddress: "CABC...",
 *   timelockAddress: "CDEF...",
 *   votesAddress:    "CGHI...",
 *   network: "testnet",
 * });
 *
 * const opId = await client.schedule(signer, targetAddress, calldata, "execute", 86400n);
 * const ready = await client.isReady(opId);
 * if (ready) await client.execute(signer, opId);
 */
export class TimelockClient {
  private readonly config: GovernorConfig;
  private readonly server: SorobanRpc.Server;
  private readonly contract: Contract;
  private readonly networkPassphrase: string;

  constructor(config: GovernorConfig) {
    this.config = config;
    const rpcUrl = config.rpcUrl ?? RPC_URLS[config.network];
    this.server = new SorobanRpc.Server(rpcUrl, { allowHttp: false });
    this.contract = new Contract(config.timelockAddress);
    this.networkPassphrase = NETWORK_PASSPHRASES[config.network];
  }

  private async retry<T>(
    fn: () => Promise<T>,
    filter?: (e: unknown) => boolean,
  ): Promise<T> {
    return withRetry(fn, {
      maxAttempts: this.config.maxAttempts,
      baseDelayMs: this.config.baseDelayMs,
      retryOn: filter ?? isNetworkError,
    });
  }

  /**
   * Schedule a timelock operation.
   *
   * Only the governor may call this. The operation becomes executable once
   * `delay` seconds have elapsed since scheduling.
   *
   * @param signer      - Keypair authorising the call (must be the governor signer)
   * @param target      - Strkey address of the contract to invoke on execution
   * @param data        - Encoded calldata for the target invocation
   * @param fnNameOrDelay - Function name string, or delay in seconds (bigint)
   * @param delayArg    - Delay in seconds (required when fnNameOrDelay is a function name); must be >= minDelay
   * @returns Hex-encoded operation ID (SHA-256 of `data`)
   */
  async schedule(
    signer: Keypair,
    target: string,
    data: Buffer,
    fnNameOrDelay: string | bigint,
    delayArg?: bigint,
  ): Promise<string> {
    const fnName =
      typeof fnNameOrDelay === "string" ? fnNameOrDelay : "execute";
    const delay =
      typeof fnNameOrDelay === "bigint" ? fnNameOrDelay : delayArg;
    if (delay === undefined) {
      throw new TimelockError(
        TimelockErrorCode.MissingReturnValue,
        "schedule requires a delay",
      );
    }

    return this.retry(async () => {
      const account = await this.server.getAccount(signer.publicKey());

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            "schedule",
            nativeToScVal(signer.publicKey(), { type: "address" }),
            nativeToScVal(target, { type: "address" }),
            nativeToScVal(data, { type: "bytes" }),
            nativeToScVal(fnName, { type: "symbol" }),
            nativeToScVal(delay, { type: "u64" }),
          ),
        )
        .setTimeout(30)
        .build();

      const prepared = await this.server.prepareTransaction(tx);
      prepared.sign(signer);

      const result = await this.server.sendTransaction(prepared);
      if (result.status === "ERROR") {
        throw parseTimelockError(result);
      }

      const confirmed = await this.pollForConfirmation(result.hash);
      const returnVal = confirmed.returnValue;
      if (!returnVal) {
        throw new TimelockError(
          TimelockErrorCode.MissingReturnValue,
          "No return value from schedule",
        );
      }

      const bytes = scValToNative(returnVal) as Uint8Array;
      return Buffer.from(bytes).toString("hex");
    }, (e) => this.isRetryableSubmissionError(e));
  }

  /**
   * Schedule multiple operations as a single atomic batch.
   *
   * All sub-operations share one `predecessor` and `salt`.  The contract
   * returns a **single** hex-encoded `batch_op_id` covering the entire batch.
   * Use {@link executeBatch} to run all sub-operations atomically.
   *
   * @param signer      - Keypair authorising the call (must be the governor signer)
   * @param targets     - Contract addresses to invoke (one per sub-operation)
   * @param data        - Encoded calldata for each target
   * @param fnNames     - Function names for each target
   * @param delay       - Delay in seconds; must be >= the contract's `minDelay`
   * @param predecessor - Op-id of a previously completed operation that must
   *                      execute before this batch (pass empty Buffer for none)
   * @param salt        - Unique salt to disambiguate batches with identical inputs
   * @returns Hex-encoded single batch op_id (SHA-256 of all tuples + predecessor + salt)
   */
  async scheduleBatch(
    signer: Keypair,
    targets: string[],
    data: Array<Buffer | Uint8Array>,
    fnNames: string[],
    delay: bigint,
    predecessor: Buffer | Uint8Array,
    salt: Buffer | Uint8Array,
  ): Promise<string> {
    return this.retry(async () => {
      const len = targets.length;
      if (len === 0)
        throw new Error("scheduleBatch requires at least one operation");
      if (data.length !== len || fnNames.length !== len) {
        throw new Error("scheduleBatch: targets, data, and fnNames must have equal length");
      }

      const account = await this.server.getAccount(signer.publicKey());
      const targetsScVal = xdr.ScVal.scvVec(
        targets.map((item) => nativeToScVal(item, { type: "address" })),
      );
      const dataScVal = xdr.ScVal.scvVec(
        data.map((item) => nativeToScVal(item, { type: "bytes" })),
      );
      const fnNamesScVal = xdr.ScVal.scvVec(
        fnNames.map((item) => nativeToScVal(item, { type: "symbol" })),
      );

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            "schedule_batch",
            nativeToScVal(signer.publicKey(), { type: "address" }),
            targetsScVal,
            dataScVal,
            fnNamesScVal,
            nativeToScVal(delay, { type: "u64" }),
            nativeToScVal(predecessor, { type: "bytes" }),
            nativeToScVal(salt, { type: "bytes" }),
          ),
        )
        .setTimeout(30)
        .build();

      const prepared = await this.server.prepareTransaction(tx);
      prepared.sign(signer);

      const result = await this.server.sendTransaction(prepared);
      if (result.status === "ERROR") {
        throw new Error(`scheduleBatch failed: ${JSON.stringify(result)}`);
      }

      const confirmed = await this.pollForConfirmation(result.hash);
      const returnVal = confirmed.returnValue;
      if (!returnVal) throw new Error("scheduleBatch: missing return value");

      const bytes = scValToNative(returnVal) as Uint8Array;
      return Buffer.from(bytes).toString("hex");
    }, (e) => this.isRetryableSubmissionError(e));
  }

  /**
   * Execute a batch of operations atomically.
   *
   * All sub-operations run in sequence.  If any sub-call fails the entire
   * transaction reverts and none of the sub-calls take effect.
   *
   * @param signer      - Keypair authorising the call (must be the governor signer)
   * @param batchOpId   - Hex-encoded batch op_id returned by {@link scheduleBatch}
   */
  async executeBatch(signer: Keypair, batchOpId: string): Promise<void> {
    return this.retry(async () => {
      const account = await this.server.getAccount(signer.publicKey());

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            "execute_batch",
            nativeToScVal(signer.publicKey(), { type: "address" }),
            nativeToScVal(Buffer.from(batchOpId, "hex"), { type: "bytes" }),
          ),
        )
        .setTimeout(30)
        .build();

      const prepared = await this.server.prepareTransaction(tx);
      prepared.sign(signer);

      const result = await this.server.sendTransaction(prepared);
      if (result.status === "ERROR") {
        throw parseTimelockError(result);
      }
      await this.pollForConfirmation(result.hash);
    }, (e) => this.isRetryableSubmissionError(e));
  }

  /**
   * Execute a ready timelock operation.
   *
   * Only callable once the operation's delay has elapsed. The caller must be
   * the governor.
   *
   * @param signer - Keypair authorising the call (must be the governor signer)
   * @param opId   - Hex-encoded operation ID returned by {@link schedule}
   */
  async execute(signer: Keypair, opId: string): Promise<void> {
    return this.retry(async () => {
      const account = await this.server.getAccount(signer.publicKey());

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            "execute",
            nativeToScVal(signer.publicKey(), { type: "address" }),
            nativeToScVal(Buffer.from(opId, "hex"), { type: "bytes" }),
          ),
        )
        .setTimeout(30)
        .build();

      const prepared = await this.server.prepareTransaction(tx);
      prepared.sign(signer);

      const result = await this.server.sendTransaction(prepared);
      if (result.status === "ERROR") {
        throw parseTimelockError(result);
      }
      await this.pollForConfirmation(result.hash);
    }, (e) => this.isRetryableSubmissionError(e));
  }

  /**
   * Cancel a pending timelock operation.
   *
   * Only the admin or governor may cancel. The operation must not have been
   * executed or already cancelled.
   *
   * @param signer - Keypair authorising the call (admin or governor signer)
   * @param opId   - Hex-encoded operation ID returned by {@link schedule}
   */
  async cancel(signer: Keypair, opId: string): Promise<void> {
    return this.retry(async () => {
      const account = await this.server.getAccount(signer.publicKey());

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            "cancel",
            nativeToScVal(signer.publicKey(), { type: "address" }),
            nativeToScVal(Buffer.from(opId, "hex"), { type: "bytes" }),
          ),
        )
        .setTimeout(30)
        .build();

      const prepared = await this.server.prepareTransaction(tx);
      prepared.sign(signer);

      const result = await this.server.sendTransaction(prepared);
      if (result.status === "ERROR") {
        throw parseTimelockError(result);
      }
      await this.pollForConfirmation(result.hash);
    }, (e) => this.isRetryableSubmissionError(e));
  }

  /**
   * Check whether an operation is ready for execution.
   *
   * An operation is ready when it has been scheduled, its delay has elapsed,
   * and it has not yet been executed or cancelled.
   *
   * @param opId - Hex-encoded operation ID
   */
  async isReady(opId: string): Promise<boolean> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(this.readAccount()),
          { fee: BASE_FEE, networkPassphrase: this.networkPassphrase },
        )
          .addOperation(
            this.contract.call(
              "is_ready",
              nativeToScVal(Buffer.from(opId, "hex"), { type: "bytes" }),
            ),
          )
          .setTimeout(30)
          .build(),
      );

      if (SorobanRpc.Api.isSimulationError(result)) return false;
      const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result?.retval;
      return raw ? (scValToNative(raw) as boolean) : false;
    });
  }

  /**
   * Check whether an operation is pending.
   *
   * An operation is pending when it has been scheduled but its delay has not
   * yet elapsed, and it has not been executed or cancelled.
   *
   * @param opId - Hex-encoded operation ID
   */
  async isPending(opId: string): Promise<boolean> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(this.readAccount()),
          { fee: BASE_FEE, networkPassphrase: this.networkPassphrase },
        )
          .addOperation(
            this.contract.call(
              "is_pending",
              nativeToScVal(Buffer.from(opId, "hex"), { type: "bytes" }),
            ),
          )
          .setTimeout(30)
          .build(),
      );

      if (SorobanRpc.Api.isSimulationError(result)) return false;
      const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result?.retval;
      return raw ? (scValToNative(raw) as boolean) : false;
    });
  }

  /**
   * Get the minimum enforced delay for new operations (in seconds).
   */
  async minDelay(): Promise<bigint> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(this.readAccount()),
          { fee: BASE_FEE, networkPassphrase: this.networkPassphrase },
        )
          .addOperation(this.contract.call("min_delay"))
          .setTimeout(30)
          .build(),
      );

      if (SorobanRpc.Api.isSimulationError(result)) return 0n;
      const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result?.retval;
      return raw ? BigInt(scValToNative(raw)) : 0n;
    });
  }

  private isRetryableSubmissionError(e: unknown): boolean {
    if (isNetworkError(e)) return true;
    if (e instanceof TimelockError) {
      // Don't retry on contract logic errors (codes < 100)
      return (
        e.code >= 100 &&
        e.code !== TimelockErrorCode.TransactionFailed &&
        e.code !== TimelockErrorCode.MissingReturnValue
      );
    }
    const msg = String(e);
    if (msg.includes("TransactionAlreadyInMempool")) return false;
    return false;
  }

  /**
   * Get the configured execution window duration in seconds.
   *
   * Defines the maximum time after the delay period during which an operation
   * can still be executed before it expires.
   *
   * @returns The execution window in seconds, or 0n on error
   */
  async executionWindow(): Promise<bigint> {
    const result = await this.server.simulateTransaction(
      new TransactionBuilder(
        await this.server.getAccount(this.readAccount()),
        { fee: BASE_FEE, networkPassphrase: this.networkPassphrase }
      )
        .addOperation(this.contract.call("execution_window"))
        .setTimeout(30)
        .build()
    );

    if (SorobanRpc.Api.isSimulationError(result)) return 0n;
    const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
      .result?.retval;
    return raw ? BigInt(scValToNative(raw)) : 0n;
  }

  // --- Internal ---

  private readAccount(): string {
    return this.config.simulationAccount ?? this.config.timelockAddress;
  }

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
        throw new TimelockError(
          TimelockErrorCode.TransactionFailed,
          `Transaction failed: ${hash}`
        );
      }
    }
    throw new TimelockError(
      TimelockErrorCode.TransactionTimeout,
      `Transaction not confirmed after ${retries} retries`
    );
  }
}
