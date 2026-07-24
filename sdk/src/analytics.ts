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
  AllTimeStats,
  GovernanceSnapshot,
  GovernorConfig,
  Network,
  ProposalParticipation,
  VoterHistory,
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

/**
 * Maps a `GovernanceSnapshot` — from either a direct on-chain read (the
 * value returned by `take_analytics_snapshot`) or an indexer
 * `/analytics/snapshots*` row — to the SDK's public type. Both sources
 * carry the same minimal shape: the on-chain struct was trimmed to just
 * `ledger`/`participation_bps` to stay under Soroban's WASM size cap (see
 * `contracts/governor/src/analytics.rs`), and the indexer table mirrors it
 * exactly since it's populated from the same `AnalyticsSnapshotTaken` event.
 */
function mapGovernanceSnapshot(raw: any): GovernanceSnapshot {
  return {
    ledger: Number(raw.ledger),
    participationBps: Number(raw.participation_bps ?? 0),
  };
}

function mapAllTimeStats(raw: any): AllTimeStats {
  return {
    totalProposals: BigInt(raw.total_proposals ?? 0),
    totalVotesCast: BigInt(raw.total_votes_cast ?? 0),
    uniqueVoters: BigInt(raw.unique_voters ?? 0),
    quorumHitCount: BigInt(raw.quorum_hit_count ?? 0),
    quorumMissCount: BigInt(raw.quorum_miss_count ?? 0),
    passRateBps: Number(raw.pass_rate_bps ?? 0),
  };
}

function mapProposalParticipation(raw: any): ProposalParticipation {
  return {
    proposalId: BigInt(raw.proposal_id ?? 0),
    totalEligibleSupply: BigInt(raw.total_eligible_supply ?? 0),
    totalVotesCast: BigInt(raw.total_votes_cast ?? 0),
    participationBps: Number(raw.participation_bps ?? 0),
    quorumRequired: BigInt(raw.quorum_required ?? 0),
    quorumReached: Boolean(raw.quorum_reached),
  };
}

function mapVoterHistory(raw: any): VoterHistory {
  return {
    voter: raw.voter,
    proposalsVoted: Number(raw.proposals_voted),
    proposalsEligible: Number(raw.proposals_eligible),
    participationRateBps: Number(raw.participation_rate_bps),
    totalWeightCast: BigInt(raw.total_weight_cast ?? 0),
    forCount: Number(raw.for_count),
    againstCount: Number(raw.against_count),
    abstainCount: Number(raw.abstain_count),
    lastVotedLedger: Number(raw.last_voted_ledger),
  };
}

/**
 * AnalyticsClient — interact with the Governance Analytics Module (Issue
 * #765) exposed on a deployed NebGov governor contract.
 *
 * The analytics functions live directly on the governor contract (not a
 * separate deployment), so this client targets `config.governorAddress`
 * just like {@link GovernorClient}.
 *
 * @example
 * const client = new AnalyticsClient({
 *   governorAddress: "CABC...",
 *   timelockAddress: "CDEF...",
 *   votesAddress: "CGHI...",
 *   network: "testnet",
 * });
 *
 * const stats = await client.getAllTimeStats();
 * const history = await client.getVoterHistory(address);
 */
export class AnalyticsClient {
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

  /**
   * Fetches JSON from the configured indexer. Used by the methods below
   * that read data the contract no longer exposes directly (trimmed to
   * stay under Soroban's WASM size cap — see
   * `contracts/governor/src/analytics.rs`).
   */
  private async indexerRequest<T>(path: string): Promise<T> {
    if (!this.config.indexerUrl) {
      throw new GovernorError(
        GovernorErrorCode.SimulationFailed,
        `AnalyticsClient.${path} requires config.indexerUrl to be set`,
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

  /**
   * Get a specific snapshot by the ledger it was taken at, or `null` if
   * none exists. Reads from the indexer (`config.indexerUrl` required) —
   * there's no on-chain `get_snapshot` function; snapshots aren't
   * persisted on-chain at all, only emitted as an event and materialized
   * by the indexer (see module docs in `contracts/governor/src/analytics.rs`).
   */
  async getSnapshot(ledger: number): Promise<GovernanceSnapshot | null> {
    const { data } = await this.indexerRequest<{ data: any[] }>(
      `/analytics/snapshots?ledger=${ledger}`,
    );
    return data[0] ? mapGovernanceSnapshot(data[0]) : null;
  }

  /** Get the most recently captured snapshot, or `null` if none has been taken yet. */
  async getLatestSnapshot(): Promise<GovernanceSnapshot | null> {
    const raw = await this.indexerRequest<any>("/analytics/snapshots/latest");
    return raw ? mapGovernanceSnapshot(raw) : null;
  }

  /** Most-recent-first list of ledgers with a captured snapshot. */
  async getSnapshotList(limit = 200): Promise<number[]> {
    const { data } = await this.indexerRequest<{ data: Array<{ ledger: number }> }>(
      `/analytics/snapshots?limit=${limit}`,
    );
    return data.map((row) => Number(row.ledger));
  }

  /** Running all-time governance totals (votes cast, proposals, quorum hit/miss, participation). */
  async getAllTimeStats(): Promise<AllTimeStats> {
    const raw = await this.simulate("get_all_time_stats");
    return mapAllTimeStats(raw);
  }

  /** Participation breakdown for a single proposal. Safe to call at any point in its lifecycle. */
  async getProposalParticipation(proposalId: bigint): Promise<ProposalParticipation> {
    const raw = await this.simulate(
      "get_proposal_participation",
      nativeToScVal(proposalId, { type: "u64" }),
    );
    return mapProposalParticipation(raw);
  }

  /**
   * Lifetime voting participation record for a single voter. Reads from
   * the indexer (`config.indexerUrl` required) — there's no on-chain
   * `get_voter_history` function; the indexer already derives this live
   * and more cheaply from indexed `VoteCast` events (see
   * `GET /analytics/voters/:address/history` in `packages/indexer/src/api.ts`).
   */
  async getVoterHistory(voter: string): Promise<VoterHistory> {
    const raw = await this.indexerRequest<any>(`/analytics/voters/${voter}/history`);
    return mapVoterHistory(raw);
  }

  /**
   * Permissionless: capture a new governance analytics snapshot at the
   * current ledger. `signer` only pays the transaction fee — the contract
   * does not check their identity. Returns the tx hash.
   */
  async takeSnapshot(signer: Keypair): Promise<string> {
    const { hash } = await this.submit(
      signer,
      "take_analytics_snapshot",
      nativeToScVal(signer.publicKey(), { type: "address" }),
    );
    return hash;
  }

  /** Wallet-signing variant of {@link takeSnapshot}. */
  async takeSnapshotWithSign(
    signerPublicKey: string,
    signUnsignedXdr: (xdr: string) => Promise<string>,
  ): Promise<string> {
    const { hash } = await this.submitWithSign(
      signerPublicKey,
      signUnsignedXdr,
      "take_analytics_snapshot",
      nativeToScVal(signerPublicKey, { type: "address" }),
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
