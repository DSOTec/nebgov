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
    totalParticipationBpsSum: BigInt(raw.total_participation_bps_sum ?? 0),
    lastProposalLedger: Number(raw.last_proposal_ledger),
    reputationScore: Number(raw.reputation_score),
    thresholdMultiplierBps: Number(raw.threshold_multiplier_bps),
    firstProposalLedger: Number(raw.first_proposal_ledger),
    consecutiveSuccessful: Number(raw.consecutive_successful),
    consecutiveFailed: Number(raw.consecutive_failed),
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
 * Scoring parameters are fixed compile-time constants (not governance-
 * tunable) and the proposer leaderboard is not exposed as an on-chain read
 * function — both kept off the contract to stay under Soroban's WASM size
 * budget. The indexer mirrors the leaderboard from the `ReputationUpdated`
 * event stream at `GET /reputation/leaderboard`.
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

  /**
   * Score history for `proposer`, sourced from the indexer's mirror of
   * `ReputationUpdated` events (`GET /reputation/:address/history`).
   * Requires `config.indexerUrl`.
   */
  async getScoreHistory(proposer: string): Promise<ReputationScoreEntry[]> {
    const { history } = await this.indexerRequest<{ history: any[] }>(
      `/reputation/${proposer}/history`,
    );
    return (history ?? []).map((r) => ({
      ledger: Number(r.ledger),
      score: Number(r.score),
      change: Number(r.change),
      reason: String(r.reason),
    }));
  }

  /**
   * Top-proposer leaderboard, sourced from the indexer's
   * `GET /reputation/leaderboard` endpoint. Requires `config.indexerUrl`.
   */
  async getLeaderboard(limit = 50): Promise<ProposerLeaderboardEntry[]> {
    const { leaderboard } = await this.indexerRequest<{ leaderboard: any[] }>(
      `/reputation/leaderboard?limit=${limit}`,
    );
    return (leaderboard ?? []).map((r) => ({
      rank: Number(r.rank),
      proposer: r.proposer ?? r.address,
      reputationScore: Number(r.reputation_score),
      lastUpdatedLedger: r.last_updated_ledger != null ? Number(r.last_updated_ledger) : null,
    }));
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
