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
import { ClaimableReward, GovernorConfig, Network, VotingRewardsEpoch } from "./types";
import {
  VotingRewardsError,
  VotingRewardsErrorCode,
  parseVotingRewardsError,
} from "./errors";
import { withRetry, isNetworkError, hexToBytes32 } from "./utils";

export type VotingRewardsConfig = GovernorConfig;

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
 * VotingRewardsClient — interact with a deployed NebGov voting-rewards
 * contract (Issue #1011).
 *
 * The program pays voters for participating: a funded token pool is split
 * per epoch across everyone who cast a vote during it, proportional to the
 * voting power they cast. Eligibility is computed off-chain from the
 * indexer's vote history; only a Merkle root of each epoch's
 * `(address, amount)` set is published on-chain, and each voter claims their
 * own reward against it with a proof.
 *
 * Proofs are *not* recomputed client-side: {@link getClaimableRewards} reads
 * them from the backend, which built them from the same tree whose root was
 * published, so a claim can never be assembled against a different tree than
 * the one the contract will verify against.
 *
 * @example
 * const client = new VotingRewardsClient({
 *   governorAddress: "CABC...",
 *   timelockAddress: "CDEF...",
 *   votesAddress: "CGHI...",
 *   votingRewardsAddress: "CJKL...",
 *   backendUrl: "https://api.example.com",
 *   network: "testnet",
 * });
 *
 * const rewards = await client.getClaimableRewards(address);
 * for (const reward of rewards.filter((r) => !r.claimed)) {
 *   await client.claim(signer, reward.epochId, reward.amount, reward.merkleProof);
 * }
 */
export class VotingRewardsClient {
  private readonly config: VotingRewardsConfig;
  private readonly server: SorobanRpc.Server;
  private readonly contract: Contract;
  private readonly networkPassphrase: string;

  constructor(config: VotingRewardsConfig) {
    if (!config.votingRewardsAddress) {
      throw new VotingRewardsError(
        VotingRewardsErrorCode.TransactionFailed,
        "VotingRewardsClient requires config.votingRewardsAddress",
      );
    }
    this.config = config;
    const rpcUrl = config.rpcUrl ?? RPC_URLS[config.network];
    this.server = new SorobanRpc.Server(rpcUrl, { allowHttp: false });
    this.contract = new Contract(config.votingRewardsAddress);
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
    return this.config.simulationAccount ?? this.config.votingRewardsAddress!;
  }

  private proofToScVal(proof: string[]): xdr.ScVal {
    return xdr.ScVal.scvVec(
      proof.map((node) => nativeToScVal(hexToBytes32(node), { type: "bytes" })),
    );
  }

  private async simulate(fnName: string, ...args: xdr.ScVal[]): Promise<xdr.ScVal | undefined> {
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
        throw parseVotingRewardsError({ status: "ERROR", error: result.error });
      }

      return (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
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
        throw parseVotingRewardsError(result);
      }
      const confirmed = await this.pollForConfirmation(result.hash);
      return { hash: result.hash, confirmed };
    });
  }

  /**
   * Same as {@link submit}, but for wallet-extension signing flows: takes
   * the signer's public key plus a callback that signs an unsigned XDR
   * envelope instead of a raw {@link Keypair}.
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
        throw parseVotingRewardsError(result);
      }
      const confirmed = await this.pollForConfirmation(result.hash);
      return { hash: result.hash, confirmed };
    });
  }

  private parseEpoch(native: Record<string, unknown>): VotingRewardsEpoch {
    const rawRoot = native.merkle_root;
    let merkleRoot: string | null = null;
    if (rawRoot !== null && rawRoot !== undefined) {
      merkleRoot =
        typeof rawRoot === "string" ? rawRoot : Buffer.from(rawRoot as Uint8Array).toString("hex");
    }

    return {
      id: BigInt(native.id as bigint | number | string),
      startLedger: Number(native.start_ledger),
      endLedger: Number(native.end_ledger),
      merkleRoot,
      totalRewardAmount: BigInt(native.total_reward_amount as bigint | number | string),
      claimedAmount: BigInt(native.claimed_amount as bigint | number | string),
      finalized: Boolean(native.finalized),
    };
  }

  /** Read one epoch's on-chain record. */
  async getEpoch(epochId: bigint | number): Promise<VotingRewardsEpoch> {
    const raw = await this.simulate(
      "get_epoch",
      nativeToScVal(BigInt(epochId), { type: "u64" }),
    );
    if (!raw) {
      throw new VotingRewardsError(
        VotingRewardsErrorCode.MissingReturnValue,
        "No return value from get_epoch",
      );
    }
    return this.parseEpoch(scValToNative(raw) as Record<string, unknown>);
  }

  /** The epoch currently accepting votes. */
  async getCurrentEpochId(): Promise<bigint> {
    const raw = await this.simulate("get_current_epoch_id");
    if (!raw) {
      throw new VotingRewardsError(
        VotingRewardsErrorCode.MissingReturnValue,
        "No return value from get_current_epoch_id",
      );
    }
    return BigInt(scValToNative(raw) as bigint | number | string);
  }

  /**
   * Reward tokens held by the contract that aren't already committed to a
   * published epoch — the ceiling the next epoch can be published for.
   */
  async getAvailablePool(): Promise<bigint> {
    const raw = await this.simulate("get_available_pool");
    if (!raw) {
      throw new VotingRewardsError(
        VotingRewardsErrorCode.MissingReturnValue,
        "No return value from get_available_pool",
      );
    }
    return BigInt(scValToNative(raw) as bigint | number | string);
  }

  /**
   * The address allowed to publish epoch roots. In the intended deployment
   * this is the governor contract itself, so publishing is a
   * governance-executed action rather than a trusted operator key.
   */
  async getAdmin(): Promise<string> {
    const raw = await this.simulate("get_admin");
    if (!raw) {
      throw new VotingRewardsError(
        VotingRewardsErrorCode.MissingReturnValue,
        "No return value from get_admin",
      );
    }
    return String(scValToNative(raw));
  }

  /** Whether `address` has already claimed its reward for `epochId`. */
  async hasClaimed(epochId: bigint | number, address: string): Promise<boolean> {
    const raw = await this.simulate(
      "has_claimed",
      nativeToScVal(BigInt(epochId), { type: "u64" }),
      nativeToScVal(address, { type: "address" }),
    );
    if (!raw) {
      throw new VotingRewardsError(
        VotingRewardsErrorCode.MissingReturnValue,
        "No return value from has_claimed",
      );
    }
    return Boolean(scValToNative(raw));
  }

  /** Submit an on-chain claim for one epoch. Returns the tx hash. */
  async claim(
    claimant: Keypair,
    epochId: bigint | number,
    amount: bigint,
    proof: string[],
  ): Promise<string> {
    const { hash } = await this.submit(
      claimant,
      "claim",
      nativeToScVal(claimant.publicKey(), { type: "address" }),
      nativeToScVal(BigInt(epochId), { type: "u64" }),
      nativeToScVal(amount, { type: "i128" }),
      this.proofToScVal(proof),
    );
    return hash;
  }

  /** Wallet-signing variant of {@link claim} */
  async claimWithSign(
    claimantPublicKey: string,
    epochId: bigint | number,
    amount: bigint,
    proof: string[],
    signUnsignedXdr: (xdr: string) => Promise<string>,
  ): Promise<string> {
    const { hash } = await this.submitWithSign(
      claimantPublicKey,
      signUnsignedXdr,
      "claim",
      nativeToScVal(claimantPublicKey, { type: "address" }),
      nativeToScVal(BigInt(epochId), { type: "u64" }),
      nativeToScVal(amount, { type: "i128" }),
      this.proofToScVal(proof),
    );
    return hash;
  }

  /** Transfer `amount` of the reward token into the pool. Returns the tx hash. */
  async fundPool(funder: Keypair, amount: bigint): Promise<string> {
    const { hash } = await this.submit(
      funder,
      "fund_pool",
      nativeToScVal(funder.publicKey(), { type: "address" }),
      nativeToScVal(amount, { type: "i128" }),
    );
    return hash;
  }

  /** Wallet-signing variant of {@link fundPool} */
  async fundPoolWithSign(
    funderPublicKey: string,
    amount: bigint,
    signUnsignedXdr: (xdr: string) => Promise<string>,
  ): Promise<string> {
    const { hash } = await this.submitWithSign(
      funderPublicKey,
      signUnsignedXdr,
      "fund_pool",
      nativeToScVal(funderPublicKey, { type: "address" }),
      nativeToScVal(amount, { type: "i128" }),
    );
    return hash;
  }

  /** Roll the program into its next epoch. Permissionless once the current epoch has ended. */
  async startNextEpoch(caller: Keypair): Promise<string> {
    const { hash } = await this.submit(caller, "start_next_epoch");
    return hash;
  }

  /**
   * Publish an epoch's Merkle root directly, as the contract's admin.
   *
   * Only usable when the admin is a plain keypair. When the admin is the
   * governor contract — the intended deployment, so publishing is itself a
   * governance-executed action — use {@link encodePublishEpochRootCalldata}
   * to package the same call as proposal calldata instead.
   */
  async publishEpochRoot(
    admin: Keypair,
    epochId: bigint | number,
    merkleRoot: string,
    totalRewardAmount: bigint,
  ): Promise<string> {
    const { hash } = await this.submit(
      admin,
      "publish_epoch_root",
      nativeToScVal(admin.publicKey(), { type: "address" }),
      nativeToScVal(BigInt(epochId), { type: "u64" }),
      nativeToScVal(hexToBytes32(merkleRoot), { type: "bytes" }),
      nativeToScVal(totalRewardAmount, { type: "i128" }),
    );
    return hash;
  }

  /**
   * Encode calldata for a `publish_epoch_root` action targeting this
   * contract, for use as one of a governance proposal's
   * `targets`/`fnNames`/`calldatas`.
   *
   * Built with explicit per-arg type hints rather than the generic
   * `encodeCalldata()` helper, for the same reason
   * `ProposalBondsClient.encodeSlashCalldata` is: that helper would infer
   * `ScVal.scvString` for a plain address string, and the contract's
   * `Address` parameter would trap on execution.
   */
  encodePublishEpochRootCalldata(
    adminAddress: string,
    epochId: bigint | number,
    merkleRoot: string,
    totalRewardAmount: bigint,
  ): { target: string; fnName: string; calldata: Buffer } {
    const args = xdr.ScVal.scvVec([
      nativeToScVal(adminAddress, { type: "address" }),
      nativeToScVal(BigInt(epochId), { type: "u64" }),
      nativeToScVal(hexToBytes32(merkleRoot), { type: "bytes" }),
      nativeToScVal(totalRewardAmount, { type: "i128" }),
    ]);
    return {
      target: this.config.votingRewardsAddress!,
      fnName: "publish_epoch_root",
      calldata: Buffer.from(args.toXDR()),
    };
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
        throw new VotingRewardsError(
          VotingRewardsErrorCode.TransactionFailed,
          `Transaction failed: ${hash}`,
        );
      }
    }
    throw new VotingRewardsError(
      VotingRewardsErrorCode.TransactionTimeout,
      `Transaction not confirmed after ${retries} retries`,
    );
  }

  // ─── Backend-backed query methods ────────────────────────────────────────

  private async backendRequest<T>(path: string): Promise<T> {
    if (!this.config.backendUrl) {
      throw new VotingRewardsError(
        VotingRewardsErrorCode.SimulationFailed,
        `VotingRewardsClient.${path} requires config.backendUrl to be set`,
      );
    }
    return this.retry(async () => {
      const resp = await fetch(`${this.config.backendUrl}${path}`);
      if (!resp.ok) {
        throw new VotingRewardsError(
          VotingRewardsErrorCode.TransactionFailed,
          `Backend request failed: ${resp.status} ${resp.statusText}`,
        );
      }
      return resp.json() as Promise<T>;
    });
  }

  /**
   * Every epoch `address` earned a reward in, newest first, each carrying
   * the ready-to-submit proof the backend built from the published tree.
   */
  async getClaimableRewards(address: string): Promise<ClaimableReward[]> {
    const raw = await this.backendRequest<{
      data: {
        epoch_id: string;
        amount: string;
        merkle_proof: string[];
        claimed: boolean;
      }[];
    }>(`/voting-rewards/claims/${address}`);

    return raw.data.map((row) => ({
      epochId: BigInt(row.epoch_id),
      amount: BigInt(row.amount),
      merkleProof: row.merkle_proof,
      claimed: row.claimed,
    }));
  }

  /** Top earners for one epoch, as served by the backend's leaderboard endpoint. */
  async getEpochLeaderboard(
    epochId: bigint | number,
    limit = 20,
  ): Promise<{ address: string; amount: bigint; claimed: boolean }[]> {
    const raw = await this.backendRequest<{
      data: { claimant_address: string; amount: string; claimed: boolean }[];
    }>(`/voting-rewards/epochs/${epochId}/leaderboard?limit=${limit}`);

    return raw.data.map((row) => ({
      address: row.claimant_address,
      amount: BigInt(row.amount),
      claimed: row.claimed,
    }));
  }
}
