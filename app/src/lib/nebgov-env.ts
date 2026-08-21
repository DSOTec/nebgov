import type { GovernorConfig, Network } from "@nebgov/sdk";
import { backendBaseUrl } from "./backend";

/** Governor client config from Next public env (or null if misconfigured). */
export function readGovernorConfig(): GovernorConfig | null {
  const governorAddress = process.env.NEXT_PUBLIC_GOVERNOR_ADDRESS;
  const timelockAddress = process.env.NEXT_PUBLIC_TIMELOCK_ADDRESS;
  const votesAddress = process.env.NEXT_PUBLIC_VOTES_ADDRESS;
  const coSponsorshipAddress = process.env.NEXT_PUBLIC_CO_SPONSORSHIP_ADDRESS;
  const signalAnchorAddress = process.env.NEXT_PUBLIC_SIGNAL_ANCHOR_ADDRESS;
  const proposalBondsAddress = process.env.NEXT_PUBLIC_PROPOSAL_BONDS_ADDRESS;
  const network = (process.env.NEXT_PUBLIC_NETWORK || "testnet") as Network;
  const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL;

  if (!governorAddress || !timelockAddress || !votesAddress) return null;

  return {
    governorAddress,
    timelockAddress,
    votesAddress,
    network,
    backendUrl: backendBaseUrl(),
    ...(rpcUrl ? { rpcUrl } : {}),
    ...(coSponsorshipAddress ? { coSponsorshipAddress } : {}),
    ...(signalAnchorAddress ? { signalAnchorAddress } : {}),
    ...(proposalBondsAddress ? { proposalBondsAddress } : {}),
  };
}

export function subscriptionOptsFromConfig(config: GovernorConfig): {
  network: Network;
  rpcUrl?: string;
} {
  return { network: config.network, ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}) };
}

/** Returns the indexer base URL or null if not configured. */
export function readIndexerUrl(): string | null {
  return process.env.NEXT_PUBLIC_INDEXER_URL ?? null;
}
