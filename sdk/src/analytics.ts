import { AllTimeStats, GovernanceSnapshot, GovernorConfig, VoterHistory } from "./types";
import { GovernorError, GovernorErrorCode } from "./errors";
import { withRetry, isNetworkError } from "./utils";

function mapGovernanceSnapshot(raw: any): GovernanceSnapshot {
  return {
    ledger: Number(raw.ledger),
    totalVotesCast: BigInt(raw.total_votes_cast ?? 0),
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
 * AnalyticsClient — governance analytics for NebGov (Issue #765).
 *
 * Entirely indexer-backed: there's no on-chain analytics module (no room
 * in the governor contract's WASM budget alongside the proposer
 * reputation module — see git history for
 * `contracts/governor/src/analytics.rs`). `config.indexerUrl` is required
 * for every method here.
 *
 * @example
 * const client = new AnalyticsClient({
 *   governorAddress: "CABC...",
 *   timelockAddress: "CDEF...",
 *   votesAddress: "CGHI...",
 *   network: "testnet",
 *   indexerUrl: "https://indexer.example.com",
 * });
 *
 * const stats = await client.getAllTimeStats();
 * const history = await client.getVoterHistory(address);
 */
export class AnalyticsClient {
  private readonly config: GovernorConfig;

  constructor(config: GovernorConfig) {
    this.config = config;
  }

  private async retry<T>(fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, {
      maxAttempts: this.config.maxAttempts,
      baseDelayMs: this.config.baseDelayMs,
      retryOn: isNetworkError,
    });
  }

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

  /** Get a specific snapshot by the ledger it was taken at, or `null` if none exists. */
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

  /**
   * Running all-time governance totals. `quorumHitCount`/`quorumMissCount`/
   * `passRateBps` are always 0: determining them requires the eligible
   * supply (and, for dynamic quorum, a live oracle price) at each
   * proposal's start ledger, which the indexer doesn't track — see
   * `GET /analytics/all-time-stats` in `packages/indexer/src/api.ts`.
   */
  async getAllTimeStats(): Promise<AllTimeStats> {
    const raw = await this.indexerRequest<any>("/analytics/all-time-stats");
    return mapAllTimeStats(raw);
  }

  /** Lifetime voting participation record for a single voter. */
  async getVoterHistory(voter: string): Promise<VoterHistory> {
    const raw = await this.indexerRequest<any>(`/analytics/voters/${voter}/history`);
    return mapVoterHistory(raw);
  }
}
