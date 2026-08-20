import { Keypair } from "@stellar/stellar-sdk";
import {
  GovernorClient,
  hashDescription,
  ProposalState,
  type GovernorSettings,
  type Network,
} from "@nebgov/sdk";
import { logger } from "../logger";
import type { AnalyzerInputs, RecommendationResult } from "./analyzer";
import { getLatestRecommendation } from "./recommendation-store";

// Anything short of these means a prior auto-proposed update_config is still
// in flight (Pending/Active/Succeeded/Queued) — not yet safe to submit another.
const TERMINAL_PROPOSAL_STATES: ReadonlySet<ProposalState> = new Set([
  ProposalState.Executed,
  ProposalState.Defeated,
  ProposalState.Cancelled,
  ProposalState.Expired,
]);

function buildGovernorClient(): GovernorClient | null {
  const governorAddress = process.env.GOVERNOR_CONTRACT_ID;
  const votesAddress = process.env.TOKEN_VOTES_CONTRACT_ID;
  const timelockAddress = process.env.TIMELOCK_CONTRACT_ID;
  if (!governorAddress || !votesAddress || !timelockAddress) return null;

  const network = (process.env.STELLAR_NETWORK ?? "testnet") as Network;
  const rpcUrl = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
  const indexerUrl = process.env.INDEXER_URL ?? "http://localhost:3002";

  return new GovernorClient({
    governorAddress,
    timelockAddress,
    votesAddress,
    network,
    rpcUrl,
    indexerUrl,
  });
}

/**
 * Guards against spamming governance with duplicate proposals.
 *
 * The indexer's "current" settings (what `computeRecommendation` diffs
 * against, via `/config-history`) only change once a proposal actually
 * executes — real wall-clock time away, through voting delay + voting
 * period + the timelock. Since `interval_ms` is admin-configurable down to
 * 60 seconds, without this check the analyzer would resubmit an essentially
 * identical `update_config` proposal every cycle until the first one clears.
 *
 * Returns the still-unresolved proposal id if one is in flight (skip
 * auto-propose this cycle), or `null` if it's safe to submit.
 */
export async function findUnresolvedAutoProposal(): Promise<bigint | null> {
  const latest = await getLatestRecommendation();
  if (!latest?.autoProposed || latest.proposalId === null) return null;

  const governor = buildGovernorClient();
  if (!governor) {
    // Can't check on-chain state — stay safe and assume it's still pending
    // rather than risk a duplicate submission.
    return latest.proposalId;
  }

  try {
    const state = await governor.getProposalState(latest.proposalId);
    return TERMINAL_PROPOSAL_STATES.has(state) ? null : latest.proposalId;
  } catch (err) {
    logger.warn(
      { err, proposalId: latest.proposalId.toString() },
      "governance-tuning: could not check prior auto-proposal's state — skipping this cycle to be safe",
    );
    return latest.proposalId;
  }
}

/**
 * Submits a recommendation as a real `update_config` governance proposal.
 *
 * Only called when `governance_tuning_config.auto_propose` is enabled, a
 * `RELAYER_SECRET_KEY` is configured, and {@link findUnresolvedAutoProposal}
 * confirms no prior auto-proposal is still in flight — by default the
 * analyzer only records recommendations for a human to review (see
 * `GovernanceTuningAnalyzerService`).
 *
 * Deliberately uses `@nebgov/sdk`'s `GovernorClient` rather than hand-rolling
 * the `update_config` calldata encoding a second time — this is the one
 * place in the backend that takes on the SDK's pinned `@stellar/stellar-sdk`
 * ^12 alongside the backend's own ^15 (see the version-mismatch note in
 * `backend/src/routes/relayer.ts`), accepted here since it's opt-in and
 * off by default, and re-deriving `proposals.ts`'s ScVal map encoding by
 * hand would be a much larger correctness risk for a rarely-exercised path.
 *
 * Returns the new proposal's id, or `null` if auto-propose isn't configured.
 */
export async function maybeAutoPropose(
  inputs: AnalyzerInputs,
  result: RecommendationResult,
): Promise<bigint | null> {
  const secret = process.env.RELAYER_SECRET_KEY;
  const governorAddress = process.env.GOVERNOR_CONTRACT_ID;
  const governor = buildGovernorClient();
  if (!secret || !governorAddress || !governor) {
    logger.warn(
      "governance-tuning: auto_propose is enabled but RELAYER_SECRET_KEY/GOVERNOR_CONTRACT_ID/TOKEN_VOTES_CONTRACT_ID/TIMELOCK_CONTRACT_ID aren't all configured — skipping auto-propose",
    );
    return null;
  }

  const currentSettings = await governor.getSettings(governorAddress);
  const newSettings: GovernorSettings = {
    ...currentSettings,
    quorumNumerator: result.recommendedQuorumNumerator,
    proposalThreshold: result.recommendedProposalThreshold,
  };

  const { target, fnName, calldata } = governor.buildUpdateConfigProposal(newSettings);

  const description = [
    "Governance tuning recommendation (automated)",
    "",
    `quorum_numerator: ${inputs.currentQuorumNumerator} -> ${result.recommendedQuorumNumerator}`,
    `proposal_threshold: ${inputs.currentProposalThreshold} -> ${result.recommendedProposalThreshold}`,
    "",
    result.rationale.quorumNumerator.reason,
    result.rationale.proposalThreshold.reason,
  ].join("\n");
  const descriptionHash = await hashDescription(description);

  const signer = Keypair.fromSecret(secret);
  // `signer` is a `Keypair` from the backend's @stellar/stellar-sdk (^15);
  // `governor.propose` types its parameter against @nebgov/sdk's pinned ^12
  // copy. Same class, different package instances — identical at runtime
  // (publicKey()/sign() haven't changed across these majors), incompatible
  // only nominally to the type checker, hence the cast.
  const proposalId = await governor.propose(
    signer as unknown as Parameters<typeof governor.propose>[0],
    description,
    descriptionHash,
    "",
    [target],
    [fnName],
    [Buffer.from(calldata)],
  );

  logger.info({ proposalId: proposalId.toString() }, "Governance tuning auto-proposed on-chain");
  return proposalId;
}
