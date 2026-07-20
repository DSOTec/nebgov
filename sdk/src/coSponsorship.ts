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
import { GovernorConfig, Network, ProposalDraft } from "./types";
import {
  CoSponsorshipError,
  CoSponsorshipErrorCode,
  parseCoSponsorshipError,
} from "./errors";
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

/**
 * CoSponsorshipClient — interact with a deployed NebGov co-sponsorship
 * registry contract.
 *
 * Co-sponsorship lets addresses below the governor's `proposal_threshold`
 * pool their voting power into a shared draft. Once the draft's accumulated
 * co-sponsor power meets the threshold, the creator finalizes it into a real
 * governor proposal via a trusted cross-contract call — see
 * `GovernorContract.propose_via_registry`.
 *
 * @example
 * const client = new CoSponsorshipClient({
 *   governorAddress: "CABC...",
 *   timelockAddress: "CDEF...",
 *   votesAddress: "CGHI...",
 *   coSponsorshipAddress: "CJKL...",
 *   network: "testnet",
 * });
 *
 * const draftId = await client.createDraft(signer, "Fund grant #4", descHash, "ipfs://...", [target], ["exec"], [calldata]);
 * await client.coSponsor(otherSigner, draftId);
 * const proposalId = await client.finalizeDraft(signer, draftId);
 */
export class CoSponsorshipClient {
  private readonly config: GovernorConfig;
  private readonly server: SorobanRpc.Server;
  private readonly contract: Contract;
  private readonly networkPassphrase: string;

  constructor(config: GovernorConfig) {
    if (!config.coSponsorshipAddress) {
      throw new CoSponsorshipError(
        CoSponsorshipErrorCode.TransactionFailed,
        "CoSponsorshipClient requires config.coSponsorshipAddress",
      );
    }
    this.config = config;
    const rpcUrl = config.rpcUrl ?? RPC_URLS[config.network];
    this.server = new SorobanRpc.Server(rpcUrl, { allowHttp: false });
    this.contract = new Contract(config.coSponsorshipAddress);
    this.networkPassphrase = NETWORK_PASSPHRASES[config.network];
  }

  private async retry<T>(fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, {
      maxAttempts: this.config.maxAttempts,
      baseDelayMs: this.config.baseDelayMs,
      retryOn: isNetworkError,
    });
  }

  private readAccount(): string {
    return this.config.simulationAccount ?? this.config.coSponsorshipAddress!;
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
        throw parseCoSponsorshipError(result);
      }
      const confirmed = await this.pollForConfirmation(result.hash);
      return { hash: result.hash, confirmed };
    });
  }

  /**
   * Same as {@link submit}, but for wallet-extension signing flows: takes
   * the signer's public key plus a callback that signs an unsigned XDR
   * envelope (e.g. a wallet-kit `signTransaction`) instead of a raw
   * {@link Keypair}. Mirrors `proposeWithSign` in `governor/proposals.ts`.
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
        throw parseCoSponsorshipError(result);
      }
      const confirmed = await this.pollForConfirmation(result.hash);
      return { hash: result.hash, confirmed };
    });
  }

  /**
   * Create a draft pre-proposal. Unlike a direct governor `propose()` call,
   * the creator does not need to individually meet the governor's
   * `proposal_threshold` — that can instead be met by accumulating
   * co-sponsor pledges via {@link coSponsor}.
   */
  async createDraft(
    signer: Keypair,
    description: string,
    descriptionHash: Buffer | Uint8Array,
    metadataUri: string,
    targets: string[],
    fnNames: string[],
    calldatas: (Buffer | Uint8Array)[],
  ): Promise<bigint> {
    const { confirmed } = await this.submit(
      signer,
      "create_draft",
      nativeToScVal(signer.publicKey(), { type: "address" }),
      nativeToScVal(description, { type: "string" }),
      nativeToScVal(descriptionHash, { type: "bytes" }),
      nativeToScVal(metadataUri, { type: "string" }),
      xdr.ScVal.scvVec(targets.map((t) => nativeToScVal(t, { type: "address" }))),
      xdr.ScVal.scvVec(fnNames.map((f) => nativeToScVal(f, { type: "symbol" }))),
      xdr.ScVal.scvVec(calldatas.map((c) => nativeToScVal(c, { type: "bytes" }))),
    );
    const returnVal = confirmed.returnValue;
    if (!returnVal) {
      throw new CoSponsorshipError(
        CoSponsorshipErrorCode.MissingReturnValue,
        "No return value from create_draft",
      );
    }
    return BigInt(scValToNative(returnVal));
  }

  /** Wallet-signing variant of {@link createDraft} — see {@link submitWithSign}. */
  async createDraftWithSign(
    signerPublicKey: string,
    description: string,
    descriptionHash: Buffer | Uint8Array,
    metadataUri: string,
    targets: string[],
    fnNames: string[],
    calldatas: (Buffer | Uint8Array)[],
    signUnsignedXdr: (xdr: string) => Promise<string>,
  ): Promise<bigint> {
    const { confirmed } = await this.submitWithSign(
      signerPublicKey,
      signUnsignedXdr,
      "create_draft",
      nativeToScVal(signerPublicKey, { type: "address" }),
      nativeToScVal(description, { type: "string" }),
      nativeToScVal(descriptionHash, { type: "bytes" }),
      nativeToScVal(metadataUri, { type: "string" }),
      xdr.ScVal.scvVec(targets.map((t) => nativeToScVal(t, { type: "address" }))),
      xdr.ScVal.scvVec(fnNames.map((f) => nativeToScVal(f, { type: "symbol" }))),
      xdr.ScVal.scvVec(calldatas.map((c) => nativeToScVal(c, { type: "bytes" }))),
    );
    const returnVal = confirmed.returnValue;
    if (!returnVal) {
      throw new CoSponsorshipError(
        CoSponsorshipErrorCode.MissingReturnValue,
        "No return value from create_draft",
      );
    }
    return BigInt(scValToNative(returnVal));
  }

  /** Pledge the signer's current voting power toward a draft. Returns the tx hash. */
  async coSponsor(signer: Keypair, draftId: bigint): Promise<string> {
    const { hash } = await this.submit(
      signer,
      "co_sponsor",
      nativeToScVal(signer.publicKey(), { type: "address" }),
      nativeToScVal(draftId, { type: "u64" }),
    );
    return hash;
  }

  /** Wallet-signing variant of {@link coSponsor} — see {@link submitWithSign}. */
  async coSponsorWithSign(
    signerPublicKey: string,
    draftId: bigint,
    signUnsignedXdr: (xdr: string) => Promise<string>,
  ): Promise<string> {
    const { hash } = await this.submitWithSign(
      signerPublicKey,
      signUnsignedXdr,
      "co_sponsor",
      nativeToScVal(signerPublicKey, { type: "address" }),
      nativeToScVal(draftId, { type: "u64" }),
    );
    return hash;
  }

  /** Remove a previously pledged co-sponsorship. Returns the tx hash. */
  async withdrawCoSponsorship(signer: Keypair, draftId: bigint): Promise<string> {
    const { hash } = await this.submit(
      signer,
      "withdraw_co_sponsorship",
      nativeToScVal(signer.publicKey(), { type: "address" }),
      nativeToScVal(draftId, { type: "u64" }),
    );
    return hash;
  }

  /** Wallet-signing variant of {@link withdrawCoSponsorship} — see {@link submitWithSign}. */
  async withdrawCoSponsorshipWithSign(
    signerPublicKey: string,
    draftId: bigint,
    signUnsignedXdr: (xdr: string) => Promise<string>,
  ): Promise<string> {
    const { hash } = await this.submitWithSign(
      signerPublicKey,
      signUnsignedXdr,
      "withdraw_co_sponsorship",
      nativeToScVal(signerPublicKey, { type: "address" }),
      nativeToScVal(draftId, { type: "u64" }),
    );
    return hash;
  }

  /**
   * Promote a draft into a real governor proposal once its accumulated
   * co-sponsor power meets the governor's threshold. Only callable by the
   * draft's creator. Returns the new governor proposal id.
   */
  async finalizeDraft(signer: Keypair, draftId: bigint): Promise<bigint> {
    const { confirmed } = await this.submit(
      signer,
      "finalize_draft",
      nativeToScVal(signer.publicKey(), { type: "address" }),
      nativeToScVal(draftId, { type: "u64" }),
    );
    const returnVal = confirmed.returnValue;
    if (!returnVal) {
      throw new CoSponsorshipError(
        CoSponsorshipErrorCode.MissingReturnValue,
        "No return value from finalize_draft",
      );
    }
    return BigInt(scValToNative(returnVal));
  }

  /** Wallet-signing variant of {@link finalizeDraft} — see {@link submitWithSign}. */
  async finalizeDraftWithSign(
    signerPublicKey: string,
    draftId: bigint,
    signUnsignedXdr: (xdr: string) => Promise<string>,
  ): Promise<bigint> {
    const { confirmed } = await this.submitWithSign(
      signerPublicKey,
      signUnsignedXdr,
      "finalize_draft",
      nativeToScVal(signerPublicKey, { type: "address" }),
      nativeToScVal(draftId, { type: "u64" }),
    );
    const returnVal = confirmed.returnValue;
    if (!returnVal) {
      throw new CoSponsorshipError(
        CoSponsorshipErrorCode.MissingReturnValue,
        "No return value from finalize_draft",
      );
    }
    return BigInt(scValToNative(returnVal));
  }

  /** Cancel a draft. Only callable by the draft's creator or the registry admin. Returns the tx hash. */
  async cancelDraft(signer: Keypair, draftId: bigint): Promise<string> {
    const { hash } = await this.submit(
      signer,
      "cancel_draft",
      nativeToScVal(signer.publicKey(), { type: "address" }),
      nativeToScVal(draftId, { type: "u64" }),
    );
    return hash;
  }

  /** Wallet-signing variant of {@link cancelDraft} — see {@link submitWithSign}. */
  async cancelDraftWithSign(
    signerPublicKey: string,
    draftId: bigint,
    signUnsignedXdr: (xdr: string) => Promise<string>,
  ): Promise<string> {
    const { hash } = await this.submitWithSign(
      signerPublicKey,
      signUnsignedXdr,
      "cancel_draft",
      nativeToScVal(signerPublicKey, { type: "address" }),
      nativeToScVal(draftId, { type: "u64" }),
    );
    return hash;
  }

  /** Get a draft by id. */
  async getDraft(draftId: bigint): Promise<ProposalDraft> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(this.readAccount()),
          { fee: BASE_FEE, networkPassphrase: this.networkPassphrase },
        )
          .addOperation(
            this.contract.call("get_draft", nativeToScVal(draftId, { type: "u64" })),
          )
          .setTimeout(30)
          .build(),
      );

      if (SorobanRpc.Api.isSimulationError(result)) {
        throw parseCoSponsorshipError({ status: "ERROR", error: result.error });
      }

      const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result?.retval;
      if (!raw) throw new Error("No return value");

      return scValToNative(raw) as ProposalDraft;
    });
  }

  /** Get a paginated slice of drafts in creation-id order. */
  async getActiveDrafts(offset: number, limit: number): Promise<ProposalDraft[]> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(this.readAccount()),
          { fee: BASE_FEE, networkPassphrase: this.networkPassphrase },
        )
          .addOperation(
            this.contract.call(
              "get_active_drafts",
              nativeToScVal(offset, { type: "u64" }),
              nativeToScVal(limit, { type: "u64" }),
            ),
          )
          .setTimeout(30)
          .build(),
      );

      if (SorobanRpc.Api.isSimulationError(result)) return [];

      const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result?.retval;
      if (!raw) return [];

      return scValToNative(raw) as ProposalDraft[];
    });
  }

  /** Get the voting power a specific address has pledged to a draft. */
  async getCoSponsorPower(draftId: bigint, sponsor: string): Promise<bigint> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(this.readAccount()),
          { fee: BASE_FEE, networkPassphrase: this.networkPassphrase },
        )
          .addOperation(
            this.contract.call(
              "get_co_sponsor_power",
              nativeToScVal(draftId, { type: "u64" }),
              nativeToScVal(sponsor, { type: "address" }),
            ),
          )
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
   * Check whether a draft's accumulated co-sponsor power meets the
   * governor's current proposal threshold.
   */
  async draftThresholdMet(draftId: bigint): Promise<boolean> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(this.readAccount()),
          { fee: BASE_FEE, networkPassphrase: this.networkPassphrase },
        )
          .addOperation(
            this.contract.call(
              "draft_threshold_met",
              nativeToScVal(draftId, { type: "u64" }),
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
        throw new CoSponsorshipError(
          CoSponsorshipErrorCode.TransactionFailed,
          `Transaction failed: ${hash}`,
        );
      }
    }
    throw new CoSponsorshipError(
      CoSponsorshipErrorCode.TransactionTimeout,
      `Transaction not confirmed after ${retries} retries`,
    );
  }
}
