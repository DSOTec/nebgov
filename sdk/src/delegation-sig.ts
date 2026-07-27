/**
 * DelegationSigClient — signed vote delegation (issue #772), equivalent to
 * Ethereum's EIP-712 `delegateBySig`.
 *
 * A token holder signs a {@link DelegationPermit} off-chain with their
 * Keypair (no transaction, no fee). A relayer then submits it on-chain via
 * `delegate_by_sig` / `delegate_batch_by_sig`, paying the fee.
 *
 * ## Why this signs a Soroban authorization entry, not a raw signature
 *
 * The token-votes contract verifies permits through Soroban's native
 * authorization framework (`Address::require_auth_for_args`) rather than a
 * manual `ed25519_verify`, because Soroban `Address`es are opaque and don't
 * expose a raw public key on-chain — see the doc comment on
 * `contracts/token-votes/src/delegation_sig.rs` for the full rationale. In
 * practice this means "the signature" a delegator produces here is a signed
 * `SorobanAuthorizationEntry` (base64 XDR), not a 64-byte blob. It's still a
 * single offline signing step from the delegator's perspective — they call
 * {@link DelegationSigClient.signDelegationPermit} once and hand the result
 * to a relayer.
 *
 * The signed entry is scoped to `(delegate_by_sig | delegate_batch_by_sig,
 * (permit,))` — deliberately *not* bound to a specific relayer address — so
 * any relayer can submit it. It *is* bound to which entrypoint it'll be
 * submitted through, so pass `forBatch: true` when signing for
 * {@link DelegationSigClient.delegateBatchBySig}.
 */
import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  Keypair,
  Operation,
  authorizeInvocation,
  nativeToScVal,
  scValToNative,
  hash,
  xdr,
} from "@stellar/stellar-sdk";
import { DelegationPermit, Network } from "./types";
import { VotesError, VotesErrorCode, parseVotesError } from "./errors";
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

const SINGLE_FN = "delegate_by_sig";
const BATCH_FN = "delegate_batch_by_sig";

export interface DelegationSigConfig {
  /** Contract address of the token-votes contract. */
  votesAddress: string;
  network: Network;
  /** RPC URL override (optional — defaults to public RPC for the network). */
  rpcUrl?: string;
  /** Optional funded classic account used for read-only simulation calls. */
  simulationAccount?: string;
  maxAttempts?: number;
  baseDelayMs?: number;
}

export interface DelegationTxResult {
  hash: string;
}

/**
 * DelegationSigClient — interact with the token-votes contract's signed
 * ("gasless") delegation flow.
 */
export class DelegationSigClient {
  private readonly server: SorobanRpc.Server;
  private readonly contract: Contract;
  private readonly networkPassphrase: string;

  constructor(private readonly config: DelegationSigConfig) {
    const rpcUrl = config.rpcUrl ?? RPC_URLS[config.network];
    this.server = new SorobanRpc.Server(rpcUrl, { allowHttp: false });
    this.contract = new Contract(config.votesAddress);
    this.networkPassphrase = NETWORK_PASSPHRASES[config.network];
  }

  private async retry<T>(fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, {
      maxAttempts: this.config.maxAttempts,
      baseDelayMs: this.config.baseDelayMs,
      retryOn: isNetworkError,
    });
  }

  private readAccount(fallback?: string): string {
    return (
      this.config.simulationAccount ?? fallback ?? this.contract.contractId()
    );
  }

  /**
   * The current network's chain ID: `sha256(networkPassphrase)`. Matches
   * `env.ledger().network_id()` on-chain and is used to populate
   * `DelegationPermit.chainId`.
   */
  chainId(): Buffer {
    return hash(Buffer.from(this.networkPassphrase));
  }

  /** The most recent ledger sequence, for computing an `expiryLedger`. */
  async currentLedger(): Promise<number> {
    return this.retry(async () => (await this.server.getLatestLedger()).sequence);
  }

  /**
   * Build the ScVal representation of a permit.
   *
   * Struct fields are serialized as a map sorted alphabetically by field
   * name — that's soroban-sdk's `#[contracttype]` derive convention for
   * structs — so the key order below (chain_id, contract_id, delegatee,
   * delegator, expiry_ledger, nonce) must match exactly, or the resulting
   * ScVal won't equal what the contract expects.
   */
  private permitToScVal(permit: DelegationPermit): xdr.ScVal {
    return nativeToScVal(
      {
        chain_id: permit.chainId,
        contract_id: permit.contractId,
        delegatee: permit.delegatee,
        delegator: permit.delegator,
        expiry_ledger: permit.expiryLedger,
        nonce: permit.nonce,
      },
      {
        type: {
          chain_id: ["symbol", "bytes"],
          contract_id: ["symbol", "address"],
          delegatee: ["symbol", "address"],
          delegator: ["symbol", "address"],
          expiry_ledger: ["symbol", "u32"],
          nonce: ["symbol", "u64"],
        },
      },
    );
  }

  private async simulateRead<T>(
    fnName: string,
    args: xdr.ScVal[],
    fallback: T,
    decode: (val: xdr.ScVal) => T,
  ): Promise<T> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(this.readAccount()),
          { fee: BASE_FEE, networkPassphrase: this.networkPassphrase },
        )
          .addOperation(this.contract.call(fnName, ...args))
          .setTimeout(30)
          .build(),
      );

      if (SorobanRpc.Api.isSimulationError(result)) return fallback;
      const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result?.retval;
      return raw ? decode(raw) : fallback;
    });
  }

  /** Get the current (next expected) nonce for a delegator. */
  async getNonce(delegator: string): Promise<bigint> {
    return this.simulateRead(
      "nonce",
      [nativeToScVal(delegator, { type: "address" })],
      0n,
      (raw) => BigInt(scValToNative(raw)),
    );
  }

  /** Check whether a nonce has already been used by a delegator. */
  async isNonceUsed(delegator: string, nonce: bigint): Promise<boolean> {
    return this.simulateRead(
      "is_nonce_used",
      [
        nativeToScVal(delegator, { type: "address" }),
        nativeToScVal(nonce, { type: "u64" }),
      ],
      false,
      (raw) => Boolean(scValToNative(raw)),
    );
  }

  /** Compute the domain separator for this contract instance. */
  async getDomainSeparator(): Promise<Buffer> {
    return this.simulateRead(
      "domain_separator",
      [],
      Buffer.alloc(32),
      (raw) => Buffer.from(scValToNative(raw)),
    );
  }

  /**
   * Compute the on-chain signed-message hash for a permit — informational
   * parity with the contract's `compute_permit_hash`, useful for relayer-side
   * permit fingerprinting/deduplication. Not itself used for signature
   * verification (see module docs).
   */
  async computePermitHash(permit: DelegationPermit): Promise<Buffer> {
    return this.simulateRead(
      "compute_permit_hash",
      [this.permitToScVal(permit)],
      Buffer.alloc(32),
      (raw) => Buffer.from(scValToNative(raw)),
    );
  }

  /** Check whether a relayer may submit signed permits right now. */
  async isRelayerAllowed(relayer: string): Promise<boolean> {
    return this.simulateRead(
      "is_relayer_allowed",
      [nativeToScVal(relayer, { type: "address" })],
      true,
      (raw) => Boolean(scValToNative(raw)),
    );
  }

  /** The `expiryLedger` of the most recently applied permit for `delegator`, if any. */
  async getDelegationPermitExpiry(delegator: string): Promise<number | null> {
    return this.simulateRead(
      "delegation_permit_expiry",
      [nativeToScVal(delegator, { type: "address" })],
      null,
      (raw) => {
        const native = scValToNative(raw);
        return native === null || native === undefined ? null : Number(native);
      },
    );
  }

  /**
   * Sign a delegation permit off-chain. No transaction is built or
   * submitted, and the delegator pays nothing — a relayer collects the
   * returned `{ permit, authEntry }` and later calls
   * {@link delegateBySig} or {@link delegateBatchBySig}.
   *
   * `delegator` accepts either a raw `Keypair` (server-side/testing)
   * or a `{ publicKey, sign }` pair, where `sign` delegates to a connected
   * browser wallet's auth-entry signing (e.g. `kit.signAuthEntry` from
   * `@creit.tech/stellar-wallets-kit` / Freighter) — the wallet never needs
   * to expose the raw private key.
   *
   * @param params.forBatch - Pass `true` if this permit will be submitted
   *   via {@link delegateBatchBySig} rather than {@link delegateBySig} — the
   *   signed authorization is scoped to one specific entrypoint and cannot
   *   be reused for the other.
   */
  async signDelegationPermit(params: {
    delegator:
      | Keypair
      | {
          publicKey: string;
          sign: (preimage: xdr.HashIdPreimage) => Promise<Buffer>;
        };
    delegatee: string;
    expiryLedger: number;
    nonce?: bigint;
    forBatch?: boolean;
  }): Promise<{ permit: DelegationPermit; authEntry: string }> {
    const delegatorPublicKey =
      params.delegator instanceof Keypair
        ? params.delegator.publicKey()
        : params.delegator.publicKey;
    const signer =
      params.delegator instanceof Keypair
        ? params.delegator
        : params.delegator.sign;

    const nonce = params.nonce ?? (await this.getNonce(delegatorPublicKey));

    const permit: DelegationPermit = {
      delegator: delegatorPublicKey,
      delegatee: params.delegatee,
      nonce,
      expiryLedger: params.expiryLedger,
      chainId: this.chainId(),
      contractId: this.contract.contractId(),
    };

    const invocation = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: this.contract.address().toScAddress(),
          functionName: params.forBatch ? BATCH_FN : SINGLE_FN,
          args: [this.permitToScVal(permit)],
        }),
      ),
      subInvocations: [],
    });

    const signedEntry = await authorizeInvocation(
      signer,
      params.expiryLedger,
      invocation,
      delegatorPublicKey,
      this.networkPassphrase,
    );

    return { permit, authEntry: signedEntry.toXDR("base64") };
  }

  /**
   * Relayer: submit a signed permit on-chain. `relayer` pays the
   * transaction fee and must sign the transaction; the delegator does not.
   */
  async delegateBySig(
    relayer: Keypair,
    permit: DelegationPermit,
    authEntry: string,
  ): Promise<DelegationTxResult> {
    return this.retry(async () => {
      const account = await this.server.getAccount(relayer.publicKey());
      const entry = xdr.SorobanAuthorizationEntry.fromXDR(authEntry, "base64");

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          Operation.invokeContractFunction({
            contract: this.contract.contractId(),
            function: SINGLE_FN,
            args: [
              nativeToScVal(relayer.publicKey(), { type: "address" }),
              this.permitToScVal(permit),
            ],
            auth: [entry],
          }),
        )
        .setTimeout(30)
        .build();

      const prepared = await this.server.prepareTransaction(tx);
      prepared.sign(relayer);
      const result = await this.server.sendTransaction(prepared);
      if (result.status === "ERROR") {
        throw parseVotesError(result);
      }
      return { hash: result.hash };
    });
  }

  /**
   * Relayer: submit multiple signed permits in a single transaction. Atomic
   * — if any permit fails verification, none of them are applied. Every
   * permit must have been signed with `forBatch: true`.
   */
  async delegateBatchBySig(
    relayer: Keypair,
    permits: DelegationPermit[],
    authEntries: string[],
  ): Promise<DelegationTxResult> {
    if (permits.length === 0) {
      throw new VotesError(
        VotesErrorCode.InvalidDelegationPermit,
        "permits must not be empty",
      );
    }
    if (permits.length !== authEntries.length) {
      throw new VotesError(
        VotesErrorCode.InvalidDelegationPermit,
        "permits and authEntries must have the same length",
      );
    }

    return this.retry(async () => {
      const account = await this.server.getAccount(relayer.publicKey());
      const entries = authEntries.map((e) =>
        xdr.SorobanAuthorizationEntry.fromXDR(e, "base64"),
      );

      const permitsScVal = nativeToScVal(
        permits.map((p) => this.permitToScVal(p)),
      );

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          Operation.invokeContractFunction({
            contract: this.contract.contractId(),
            function: BATCH_FN,
            args: [
              nativeToScVal(relayer.publicKey(), { type: "address" }),
              permitsScVal,
            ],
            auth: entries,
          }),
        )
        .setTimeout(30)
        .build();

      const prepared = await this.server.prepareTransaction(tx);
      prepared.sign(relayer);
      const result = await this.server.sendTransaction(prepared);
      if (result.status === "ERROR") {
        throw parseVotesError(result);
      }
      return { hash: result.hash };
    });
  }

  /**
   * Invalidate all outstanding signed permits for `delegator` by bumping
   * their nonce past anything they may have already signed. Only the
   * delegator themself may call this — it requires their own signature.
   */
  async invalidateAllPermits(delegator: Keypair): Promise<DelegationTxResult> {
    return this.retry(async () => {
      const account = await this.server.getAccount(delegator.publicKey());

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            "invalidate_all_permits",
            nativeToScVal(delegator.publicKey(), { type: "address" }),
          ),
        )
        .setTimeout(30)
        .build();

      const prepared = await this.server.prepareTransaction(tx);
      prepared.sign(delegator);
      const result = await this.server.sendTransaction(prepared);
      if (result.status === "ERROR") {
        throw parseVotesError(result);
      }
      return { hash: result.hash };
    });
  }

  /** Wallet-signing variant of {@link invalidateAllPermits}. */
  async invalidateAllPermitsWithSign(
    signerPublicKey: string,
    signUnsignedXdr: (xdr: string) => Promise<string>,
  ): Promise<DelegationTxResult> {
    return this.retry(async () => {
      const account = await this.server.getAccount(signerPublicKey);

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            "invalidate_all_permits",
            nativeToScVal(signerPublicKey, { type: "address" }),
          ),
        )
        .setTimeout(30)
        .build();

      const prepared = await this.server.prepareTransaction(tx);
      const signedXdr = await signUnsignedXdr(prepared.toXDR());
      const signed = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);

      const result = await this.server.sendTransaction(signed);
      if (result.status === "ERROR") {
        throw parseVotesError(result);
      }
      return { hash: result.hash };
    });
  }
}
