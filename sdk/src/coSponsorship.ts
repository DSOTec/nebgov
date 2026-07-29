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

export type CoSponsorshipConfig = GovernorConfig;

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
  private readonly config: CoSponsorshipConfig;
  private readonly server: SorobanRpc.Server;
  private readonly contract: Contract;
  private readonly networkPassphrase: string;

  constructor(config: CoSponsorshipConfig) {
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

  private parseProposalDraft(native: Record<string, unknown>): ProposalDraft {
    const rawDescriptionHash = native.description_hash;
    const descriptionHash =
      typeof rawDescriptionHash === "string"
        ? rawDescriptionHash
        : Buffer.from(rawDescriptionHash as Uint8Array).toString("hex");

    return {
      id: BigInt(native.id as bigint | number | string),
      creator: String(native.creator),
      description: String(native.description),
      descriptionHash,
      metadataUri: String(native.metadata_uri),
      targets: (native.targets as string[]) ?? [],
      fnNames: (native.fn_names as string[]) ?? [],
      calldatas: (native.calldatas as (Buffer | Uint8Array)[]) ?? [],
      createdLedger: Number(native.created_ledger),
      expiryLedger: Number(native.expiry_ledger),
      coSponsors: (native.co_sponsors as string[]) ?? [],
      coSponsorPower: ((native.co_sponsor_power as (bigint | number | string)[]) ?? []).map(
        (power) => BigInt(power),
      ),
      totalPower: BigInt(native.total_power as bigint | number | string),
      finalized: Boolean(native.finalized),
      cancelled: Boolean(native.cancelled),
    };
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
        throw parseCoSponsorshipError(result, undefined, fnName);
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
        throw parseCoSponsorshipError(result, undefined, fnName);
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

  /** Wallet-signing variant of {@link createDraft} */
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

  /** Wallet-signing variant of {@link coSponsor} */
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

  /** Wallet-signing variant of {@link withdrawCoSponsorship} */
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

  /** Wallet-signing variant of {@link finalizeDraft} */
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

  /** Wallet-signing variant of {@link cancelDraft} */
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

      return this.parseProposalDraft(
        scValToNative(raw) as Record<string, unknown>,
      );
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

      return (
        scValToNative(raw) as Record<string, unknown>[]
      ).map((draft) => this.parseProposalDraft(draft));
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

  // ─── Indexer-backed query methods (#862) ─────────────────────────────────────

  /**
   * Internal helper — mirrors the pattern used by AnalyticsClient.indexerRequest.
   * Requires `config.indexerUrl` to be set; throws CoSponsorshipError otherwise.
   */
  private async indexerRequest<T>(path: string): Promise<T> {
    if (!this.config.indexerUrl) {
      throw new CoSponsorshipError(
        CoSponsorshipErrorCode.SimulationFailed,
        `CoSponsorshipClient.${path} requires config.indexerUrl to be set`,
      );
    }
    return this.retry(async () => {
      const resp = await fetch(`${this.config.indexerUrl}${path}`);
      if (!resp.ok) {
        throw new CoSponsorshipError(
          CoSponsorshipErrorCode.TransactionFailed,
          `Indexer request failed: ${resp.status} ${resp.statusText}`,
        );
      }
      return resp.json() as Promise<T>;
    });
  }

  /**
   * List drafts from the indexer with optional status filtering and pagination.
   *
   * Unlike the on-chain `get_active_drafts` (which scans the full list each
   * call), this method delegates filtering and pagination to the indexer and
   * is O(1) in terms of on-chain resources.
   *
   * @param options.status  Filter to "active" | "finalized" | "cancelled" | "expired".
   *                        Omit to return drafts of all statuses.
   * @param options.page    1-based page number (default: 1).
   * @param options.limit   Drafts per page (default: 20, max: 100).
   */
  async listDrafts(options: {
    status?: "active" | "finalized" | "cancelled" | "expired";
    page?: number;
    limit?: number;
  } = {}): Promise<{ data: ProposalDraft[]; pagination: { page: number; limit: number; hasMore: boolean } }> {
    const params = new URLSearchParams();
    if (options.status) params.set("status", options.status);
    if (options.page) params.set("page", String(options.page));
    if (options.limit) params.set("limit", String(options.limit));

    const query = params.toString() ? `?${params.toString()}` : "";
    const raw = await this.indexerRequest<{
      data: any[];
      pagination: { page: number; limit: number; has_more: boolean };
    }>(`/co-sponsorship/drafts${query}`);

    return {
      data: raw.data.map(mapDraftFromIndexer),
      pagination: {
        page: raw.pagination.page,
        limit: raw.pagination.limit,
        hasMore: raw.pagination.has_more,
      },
    };
  }

  /**
   * Return all drafts created by a specific address, most-recent first.
   *
   * Uses the indexer's creator-index rather than scanning all on-chain
   * draft IDs, making it suitable for use in profile views without
   * incurring ledger scanning costs.
   *
   * @param address  Stellar address (G… or C…) of the draft creator.
   */
  async getDraftsByCreator(address: string): Promise<ProposalDraft[]> {
    const raw = await this.indexerRequest<{ data: any[] }>(
      `/co-sponsorship/drafts?creator=${address}`,
    );
    return raw.data.map(mapDraftFromIndexer);
  }

  /**
   * Return the full co-sponsorship history for a single draft: every address
   * that has pledged power, the amount pledged, and the ledger at which they
   * pledged (or withdrew).
   *
   * @param draftId  The numeric draft ID returned by `createDraft`.
   */
  async getDraftCoSponsorHistory(draftId: bigint): Promise<
    Array<{ sponsorAddress: string; pledgedPower: bigint; pledgedAtLedger: number }>
  > {
    const raw = await this.indexerRequest<{ data: any[] }>(
      `/co-sponsorship/drafts/${draftId}/co-sponsors`,
    );
    return raw.data.map((entry) => ({
      sponsorAddress: entry.sponsor_address as string,
      pledgedPower: BigInt(entry.pledged_power ?? 0),
      pledgedAtLedger: Number(entry.pledged_at_ledger),
    }));
  }
}

/**
 * Map a raw snake_case indexer draft record to the camelCase ProposalDraft
 * interface used throughout the SDK.
 */
function mapDraftFromIndexer(raw: any): ProposalDraft {
  const rawDescriptionHash = raw.description_hash;
  const descriptionHash =
    typeof rawDescriptionHash === "string"
      ? rawDescriptionHash
      : rawDescriptionHash
      ? Buffer.from(rawDescriptionHash as Uint8Array).toString("hex")
      : "";

  return {
    id: BigInt(raw.id ?? raw.draft_id ?? 0),
    creator: String(raw.creator),
    description: String(raw.description ?? ""),
    descriptionHash,
    metadataUri: String(raw.metadata_uri ?? ""),
    targets: (raw.targets as string[]) ?? [],
    fnNames: (raw.fn_names as string[]) ?? [],
    calldatas: (raw.calldatas as (Buffer | Uint8Array)[]) ?? [],
    createdLedger: Number(raw.created_ledger ?? 0),
    expiryLedger: Number(raw.expiry_ledger ?? 0),
    coSponsors: (raw.co_sponsors as string[]) ?? [],
    coSponsorPower: ((raw.co_sponsor_power as (bigint | number | string)[]) ?? []).map(
      (power) => BigInt(power),
    ),
    totalPower: BigInt(raw.total_power ?? 0),
    finalized: Boolean(raw.finalized),
    cancelled: Boolean(raw.cancelled),
  };
}

