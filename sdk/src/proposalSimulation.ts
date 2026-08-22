import { GovernorError, GovernorErrorCode } from "./errors";
import { withRetry, isNetworkError } from "./utils";
import type { GovernorConfig, SimulationHistoryEntry, SimulationResult } from "./types";

function mapResult(raw: any): SimulationResult {
  return {
    target: raw.target,
    fnName: raw.fn_name,
    success: Boolean(raw.success),
    decodedSummary: raw.decoded_summary,
    returnValue: raw.return_value,
    revertReason: raw.revert_reason,
    treasuryImpact: raw.treasury_impact
      ? {
          token: raw.treasury_impact.token,
          capRemainingBefore:
            raw.treasury_impact.cap_remaining_before === null
              ? null
              : BigInt(raw.treasury_impact.cap_remaining_before),
          capRemainingAfter:
            raw.treasury_impact.cap_remaining_after === null
              ? null
              : BigInt(raw.treasury_impact.cap_remaining_after),
        }
      : undefined,
  };
}

/**
 * Client for the proposal calldata simulation service (issue #1000).
 *
 * Like {@link GovernanceTuningClient}, this talks to the **backend**
 * (`backend/src/routes/proposal-simulation.ts`), not the indexer or Soroban
 * RPC directly — the backend owns the RPC client, the human-readable
 * decoding of known target/fn_name pairs, and the simulation-history table.
 * Requires `config.backendUrl` to be set.
 *
 * @example
 * const client = new ProposalSimulationClient({ ...config, backendUrl: "https://api.nebgov.dev" });
 * const preview = await client.previewDraft(targets, fnNames, calldatas);
 */
export class ProposalSimulationClient {
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

  private async backendRequest<T>(path: string, init?: RequestInit): Promise<T> {
    if (!this.config.backendUrl) {
      throw new GovernorError(
        GovernorErrorCode.SimulationFailed,
        `ProposalSimulationClient requires config.backendUrl to be set`,
      );
    }
    return this.retry(async () => {
      const resp = await fetch(`${this.config.backendUrl}${path}`, init);
      if (!resp.ok) {
        throw new GovernorError(
          GovernorErrorCode.SimulationFailed,
          `Backend request failed: ${resp.status}`,
        );
      }
      return resp.json() as Promise<T>;
    });
  }

  /**
   * Dry-run a not-yet-submitted draft's actions against current chain
   * state. Hits `POST /proposal-simulation/preview`.
   *
   * @param targets   - Contract addresses each action calls
   * @param fnNames   - Function name for each action, same order as `targets`
   * @param calldatas - XDR-encoded (`Vec<Val>`) calldata bytes for each action
   */
  async previewDraft(
    targets: string[],
    fnNames: string[],
    calldatas: Buffer[] | Uint8Array[],
    descriptionHash?: string,
  ): Promise<SimulationResult[]> {
    const raw = await this.backendRequest<any>("/proposal-simulation/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targets,
        fnNames,
        calldatas: calldatas.map((c) => Buffer.from(c).toString("base64")),
        ...(descriptionHash ? { descriptionHash } : {}),
      }),
    });
    return (raw.results as any[]).map(mapResult);
  }

  /**
   * Simulate an already-submitted, not-yet-executed proposal against
   * current chain state. Hits `GET /proposal-simulation/:proposalId`.
   */
  async simulateProposal(proposalId: number): Promise<SimulationResult[]> {
    const raw = await this.backendRequest<any>(`/proposal-simulation/${proposalId}`);
    return (raw.results as any[]).map(mapResult);
  }

  /**
   * Fetch prior simulation runs for a proposal — state may have changed
   * between votes opening and now. Hits
   * `GET /proposal-simulation/:proposalId/history`.
   */
  async getSimulationHistory(proposalId: number): Promise<SimulationHistoryEntry[]> {
    const raw = await this.backendRequest<any[]>(`/proposal-simulation/${proposalId}/history`);
    return raw.map((entry) => ({
      simulatedAt: entry.simulated_at,
      simulatedAtLedger: entry.simulated_at_ledger,
      results: (entry.results as any[]).map(mapResult),
      anyActionWouldRevert: Boolean(entry.any_action_would_revert),
    }));
  }
}
