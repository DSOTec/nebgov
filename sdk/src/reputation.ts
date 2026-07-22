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
  ReputationConfig,
  ReputationScoreEntry,
  ProposerLeaderboardEntry,
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
    proposalsSucceeded: Number(raw.proposals_succeeded),
    proposalsExecuted: Number(raw.proposals_executed),
    proposalsDefeated: Number(raw.proposals_defeated),
    proposalsCancelled: Number(raw.proposals_cancelled),
    proposalsExpired: Number(raw.proposals_expired),
    totalParticipationBpsSum: BigInt(raw.total_participation_bps_sum ?? 0),
    totalQuorumHit: Number(raw.total_quorum_hit),
    lastProposalLedger: Number(raw.last_proposal_ledger),
    reputationScore: Number(raw.reputation_score),
    thresholdMultiplierBps: Number(raw.threshold_multiplier_bps),
    firstProposalLedger: Number(raw.first_proposal_ledger),
    consecutiveSuccessful: Number(raw.consecutive_successful),
    consecutiveFailed: Number(raw.consecutive_failed),
  };
}

function mapReputationConfig(raw: any): ReputationConfig {
  return {
    enabled: Boolean(raw.enabled),
    scoreForSucceed: Number(raw.score_for_succeed),
    scoreForExecuted: Number(raw.score_for_executed),
    scoreForDefeated: Number(raw.score_for_defeated),
    scoreForCancelled: Number(raw.score_for_cancelled),
    scoreForExpired: Number(raw.score_for_expired),
    scoreForHighParticipation: Number(raw.score_for_high_participation),
    minProposalsForDiscount: Number(raw.min_proposals_for_discount),
    maxScore: Number(raw.max_score),
    minScore: Number(raw.min_score),
    maxThresholdMultiplierBps: Number(raw.max_threshold_multiplier_bps),
    minThresholdMultiplierBps: Number(raw.min_threshold_multiplier_bps),
    decayRatePer1000Ledgers: Number(raw.decay_rate_per_1000_ledgers),
  };
}

function reputationConfigToScVal(config: ReputationConfig): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("enabled"),
      val: xdr.ScVal.scvBool(config.enabled),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("score_for_succeed"),
      val: nativeToScVal(config.scoreForSucceed, { type: "i32" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("score_for_executed"),
      val: nativeToScVal(config.scoreForExecuted, { type: "i32" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("score_for_defeated"),
      val: nativeToScVal(config.scoreForDefeated, { type: "i32" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("score_for_cancelled"),
      val: nativeToScVal(config.scoreForCancelled, { type: "i32" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("score_for_expired"),
      val: nativeToScVal(config.scoreForExpired, { type: "i32" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("score_for_high_participation"),
      val: nativeToScVal(config.scoreForHighParticipation, { type: "i32" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("min_proposals_for_discount"),
      val: nativeToScVal(config.minProposalsForDiscount, { type: "u32" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("max_score"),
      val: nativeToScVal(config.maxScore, { type: "i32" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("min_score"),
      val: nativeToScVal(config.minScore, { type: "i32" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("max_threshold_multiplier_bps"),
      val: nativeToScVal(config.maxThresholdMultiplierBps, { type: "u32" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("min_threshold_multiplier_bps"),
      val: nativeToScVal(config.minThresholdMultiplierBps, { type: "u32" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("decay_rate_per_1000_ledgers"),
      val: nativeToScVal(config.decayRatePer1000Ledgers, { type: "i32" }),
    }),
  ]);
}

/**
 * ReputationClient — interact with the Proposer Reputation System (Issue
 * #771) exposed on a deployed NebGov governor contract.
 *
 * The reputation functions live directly on the governor contract (not a
 * separate deployment), so this client targets `config.governorAddress`
 * just like {@link GovernorClient}.
 *
 * @example
 * const client = new ReputationClient({
 *   governorAddress: "CABC...",
 *   timelockAddress: "CDEF...",
 *   votesAddress: "CGHI...",
 *   network: "testnet",
 * });
 *
 * const rep = await client.getProposerReputation(address);
 * const threshold = await client.getEffectiveThreshold(address);
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

  /** Same as {@link submit}, but for wallet-extension signing flows. */
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

  /** Get a proposer's full reputation record (zero-valued defaults if they have no history). */
  async getProposerReputation(proposer: string): Promise<ProposerReputation> {
    const raw = await this.simulate(
      "get_proposer_reputation",
      nativeToScVal(proposer, { type: "address" }),
    );
    return mapProposerReputation(raw);
  }

  /** Get the currently configured reputation scoring/threshold parameters. */
  async getReputationConfig(): Promise<ReputationConfig> {
    const raw = await this.simulate("get_reputation_config");
    return mapReputationConfig(raw);
  }

  /**
   * Reputation-adjusted effective proposal threshold for `proposer` — what
   * they would actually need to meet, as used by `propose()`. Falls back to
   * the flat `proposal_threshold` when reputation is disabled or the address
   * has no history yet.
   */
  async getEffectiveThreshold(proposer: string): Promise<bigint> {
    const raw = await this.simulate(
      "get_effective_threshold",
      nativeToScVal(proposer, { type: "address" }),
    );
    return BigInt(raw as string | number | bigint);
  }

  /** Full (bounded, most-recent-N) score change history for a proposer. */
  async getScoreHistory(proposer: string): Promise<ReputationScoreEntry[]> {
    const raw = (await this.simulate(
      "get_reputation_score_history",
      nativeToScVal(proposer, { type: "address" }),
    )) as any[];
    return raw.map((entry) => ({
      ledger: Number(entry.ledger),
      score: Number(entry.score),
      change: Number(entry.change),
      reason: String(entry.reason),
    }));
  }

  /** Cached top-proposer leaderboard, ordered by reputation score descending. */
  async getLeaderboard(): Promise<ProposerLeaderboardEntry[]> {
    const raw = (await this.simulate("get_proposer_leaderboard")) as any[];
    return raw.map((entry) => ({
      rank: Number(entry.rank),
      proposer: entry.proposer,
      reputationScore: Number(entry.reputation_score),
      totalProposals: Number(entry.total_proposals),
      successRateBps: Number(entry.success_rate_bps),
      avgParticipationBps: Number(entry.avg_participation_bps),
    }));
  }

  /**
   * Update the reputation scoring/threshold configuration. Governance-only:
   * on-chain this requires the governor contract to call itself, so in
   * practice `signer` can only be the transaction submitter for a proposal
   * whose target/calldata invokes `update_reputation_config` — the same
   * pattern as any other governance-only setter (see
   * `buildUpdateConfigProposal`). A direct call from an external keypair
   * will fail auth. Returns the submitting transaction's hash.
   */
  async updateReputationConfig(signer: Keypair, config: ReputationConfig): Promise<string> {
    const { hash } = await this.submit(
      signer,
      "update_reputation_config",
      nativeToScVal(signer.publicKey(), { type: "address" }),
      reputationConfigToScVal(config),
    );
    return hash;
  }

  /** Wallet-signing variant of {@link updateReputationConfig}. */
  async updateReputationConfigWithSign(
    signerPublicKey: string,
    config: ReputationConfig,
    signUnsignedXdr: (xdr: string) => Promise<string>,
  ): Promise<string> {
    const { hash } = await this.submitWithSign(
      signerPublicKey,
      signUnsignedXdr,
      "update_reputation_config",
      nativeToScVal(signerPublicKey, { type: "address" }),
      reputationConfigToScVal(config),
    );
    return hash;
  }

  /** Permissionless: rebuild the cached top-proposer leaderboard. Returns the tx hash. */
  async refreshLeaderboard(signer: Keypair): Promise<string> {
    const { hash } = await this.submit(
      signer,
      "refresh_proposer_leaderboard",
      nativeToScVal(signer.publicKey(), { type: "address" }),
    );
    return hash;
  }

  /** Wallet-signing variant of {@link refreshLeaderboard}. */
  async refreshLeaderboardWithSign(
    signerPublicKey: string,
    signUnsignedXdr: (xdr: string) => Promise<string>,
  ): Promise<string> {
    const { hash } = await this.submitWithSign(
      signerPublicKey,
      signUnsignedXdr,
      "refresh_proposer_leaderboard",
      nativeToScVal(signerPublicKey, { type: "address" }),
    );
    return hash;
  }

  /**
   * Permissionless: decay `proposer`'s score a step back toward zero based
   * on ledgers elapsed since it was last touched. `signer` only pays the
   * transaction fee — the contract does not check their identity. Returns
   * the tx hash.
   */
  async applyDecay(signer: Keypair, proposer: string): Promise<string> {
    const { hash } = await this.submit(
      signer,
      "apply_reputation_decay",
      nativeToScVal(proposer, { type: "address" }),
    );
    return hash;
  }

  /** Wallet-signing variant of {@link applyDecay}. */
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
