import { Keypair } from "@stellar/stellar-sdk";
import {
  GovernorClient,
  ProposalState,
  VotingRewardsClient,
  hashDescription,
  type Network,
} from "@nebgov/sdk";
import { logger } from "../logger";
import {
  markEpochPublished,
  recordPublishProposal,
  type StoredEpoch,
} from "./store";

/**
 * Placeholder root for an epoch nobody voted in. There are no leaves, so no
 * proof can verify against anything — the epoch is still published (for a
 * zero allocation) purely to keep the on-chain epoch history contiguous and
 * to stop the publisher retrying it forever.
 */
export const EMPTY_EPOCH_ROOT = "0".repeat(64);

// Anything short of these means a prior `publish_epoch_root` proposal is
// still in flight (Pending/Active/Succeeded/Queued) — not safe to submit a
// second one. Same rule `governance-tuning/auto-propose.ts` applies.
const TERMINAL_PROPOSAL_STATES: ReadonlySet<ProposalState> = new Set([
  ProposalState.Executed,
  ProposalState.Defeated,
  ProposalState.Cancelled,
  ProposalState.Expired,
]);

export function buildVotingRewardsClient(): VotingRewardsClient | null {
  const votingRewardsAddress = process.env.VOTING_REWARDS_CONTRACT_ID;
  const governorAddress = process.env.GOVERNOR_CONTRACT_ID;
  const votesAddress = process.env.TOKEN_VOTES_CONTRACT_ID;
  const timelockAddress = process.env.TIMELOCK_CONTRACT_ID;
  if (!votingRewardsAddress || !governorAddress || !votesAddress || !timelockAddress) {
    return null;
  }

  return new VotingRewardsClient({
    governorAddress,
    timelockAddress,
    votesAddress,
    votingRewardsAddress,
    network: (process.env.STELLAR_NETWORK ?? "testnet") as Network,
    rpcUrl: process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org",
    indexerUrl: process.env.INDEXER_URL ?? "http://localhost:3002",
    backendUrl: process.env.BACKEND_URL ?? `http://localhost:${process.env.PORT ?? 3001}`,
  });
}

function buildGovernorClient(): GovernorClient | null {
  const governorAddress = process.env.GOVERNOR_CONTRACT_ID;
  const votesAddress = process.env.TOKEN_VOTES_CONTRACT_ID;
  const timelockAddress = process.env.TIMELOCK_CONTRACT_ID;
  if (!governorAddress || !votesAddress || !timelockAddress) return null;

  return new GovernorClient({
    governorAddress,
    timelockAddress,
    votesAddress,
    network: (process.env.STELLAR_NETWORK ?? "testnet") as Network,
    rpcUrl: process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org",
    indexerUrl: process.env.INDEXER_URL ?? "http://localhost:3002",
  });
}

export function getRelayerKeypair(): Keypair | null {
  const secret = process.env.RELAYER_SECRET_KEY;
  if (!secret) return null;
  try {
    return Keypair.fromSecret(secret);
  } catch (err) {
    logger.error({ err }, "voting-rewards: RELAYER_SECRET_KEY is not a valid Stellar secret");
    return null;
  }
}

/** Outcome of trying to get one epoch's root onto the chain. */
export type PublishOutcome =
  | { kind: "published"; hash: string }
  | { kind: "proposed"; proposalId: bigint }
  | { kind: "skipped"; reason: string };

/**
 * Get an epoch's Merkle root published on-chain, by whichever route the
 * contract's admin implies.
 *
 * - **Admin is the relayer key** — a single-operator deployment: submit
 *   `publish_epoch_root` directly.
 * - **Admin is the governor contract** — the intended deployment, where
 *   publishing is itself a governance-executed action: package the same call
 *   as `update_config`-shaped proposal calldata and submit it as an ordinary
 *   proposal, exactly as `governance-tuning/auto-propose.ts` does for its
 *   recommendations. The epoch stays unpublished in the database until the
 *   proposal executes and the on-chain epoch reports `finalized`.
 * - **Anything else** — an admin this backend holds no key for: do nothing
 *   and say so, so an operator can publish by hand.
 */
export async function publishEpochRoot(
  client: VotingRewardsClient,
  epoch: StoredEpoch,
): Promise<PublishOutcome> {
  const root = epoch.merkleRoot ?? EMPTY_EPOCH_ROOT;
  const admin = await client.getAdmin();
  const relayer = getRelayerKeypair();

  if (relayer && admin === relayer.publicKey()) {
    const hash = await client.publishEpochRoot(
      relayer,
      epoch.epochId,
      root,
      epoch.totalRewardAmount,
    );
    await markEpochPublished(epoch.epochId);
    logger.info(
      { epochId: epoch.epochId.toString(), hash },
      "voting-rewards: published epoch root directly as contract admin",
    );
    return { kind: "published", hash };
  }

  if (admin !== process.env.GOVERNOR_CONTRACT_ID) {
    return {
      kind: "skipped",
      reason:
        "the voting-rewards admin is neither this backend's relayer key nor the configured governor — publish the root manually",
    };
  }

  if (!relayer) {
    return {
      kind: "skipped",
      reason: "RELAYER_SECRET_KEY is not configured, so no proposal can be submitted",
    };
  }

  const governor = buildGovernorClient();
  if (!governor) {
    return { kind: "skipped", reason: "governor contract addresses are not fully configured" };
  }

  const pending = await findUnresolvedPublishProposal(governor, epoch);
  if (pending !== null) {
    return {
      kind: "skipped",
      reason: `publish proposal ${pending.toString()} for this epoch has not resolved yet`,
    };
  }

  const { target, fnName, calldata } = client.encodePublishEpochRootCalldata(
    admin,
    epoch.epochId,
    root,
    epoch.totalRewardAmount,
  );

  const description = [
    `Publish voting rewards Merkle root for epoch ${epoch.epochId.toString()} (automated)`,
    "",
    `ledgers: ${epoch.startLedger} – ${epoch.endLedger}`,
    `merkle_root: ${root}`,
    `total_reward_amount: ${epoch.totalRewardAmount.toString()}`,
  ].join("\n");
  const descriptionHash = await hashDescription(description);

  // `relayer` is a `Keypair` from the backend's @stellar/stellar-sdk (^15)
  // while `governor.propose` types its parameter against @nebgov/sdk's
  // pinned ^12 copy — same class, different package instances, identical at
  // runtime. Same cast, and the same reasoning, as in
  // `governance-tuning/auto-propose.ts`.
  const proposalId = await governor.propose(
    relayer as unknown as Parameters<typeof governor.propose>[0],
    description,
    descriptionHash,
    "",
    [target],
    [fnName],
    [Buffer.from(calldata)],
  );

  await recordPublishProposal(epoch.epochId, proposalId);
  logger.info(
    { epochId: epoch.epochId.toString(), proposalId: proposalId.toString() },
    "voting-rewards: proposed epoch root publication through governance",
  );
  return { kind: "proposed", proposalId };
}

/**
 * The still-unresolved proposal id previously submitted for this epoch, or
 * `null` if it is safe to submit one.
 *
 * A proposal that was defeated, cancelled or expired is worth resubmitting —
 * the root itself is still valid and the epoch is still unpaid.
 */
async function findUnresolvedPublishProposal(
  governor: GovernorClient,
  epoch: StoredEpoch,
): Promise<bigint | null> {
  if (epoch.publishProposalId === null) return null;

  try {
    const state = await governor.getProposalState(epoch.publishProposalId);
    return TERMINAL_PROPOSAL_STATES.has(state) ? null : epoch.publishProposalId;
  } catch (err) {
    logger.warn(
      { err, proposalId: epoch.publishProposalId.toString() },
      "voting-rewards: could not read the prior publish proposal's state — skipping this cycle to be safe",
    );
    return epoch.publishProposalId;
  }
}
