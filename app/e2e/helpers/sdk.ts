import { Keypair } from "@stellar/stellar-sdk";
import { GovernorClient, VotesClient, TimelockClient } from "@nebgov/sdk";
import type { GovernorConfig, Network } from "@nebgov/sdk";

function readEnv(name: string): string | undefined {
  if (typeof process === "undefined") return undefined;
  return process.env[name];
}

export function getE2eEnv() {
  const secretKey = readEnv("TESTNET_SECRET_KEY");
  const governorAddress = readEnv("GOVERNOR_ADDRESS");
  const timelockAddress = readEnv("TIMELOCK_ADDRESS");
  const votesAddress = readEnv("VOTES_ADDRESS");
  const rpcUrl = readEnv("TESTNET_RPC_URL");

  return {
    secretKey,
    governorAddress,
    timelockAddress,
    votesAddress,
    rpcUrl,
  };
}

export function hasE2eEnv(): boolean {
  const env = getE2eEnv();
  return Boolean(
    env.secretKey &&
      env.governorAddress &&
      env.timelockAddress &&
      env.votesAddress,
  );
}

export function createSigner(): Keypair {
  const secretKey = readEnv("TESTNET_SECRET_KEY");
  if (!secretKey) throw new Error("TESTNET_SECRET_KEY not set");
  return Keypair.fromSecret(secretKey);
}

export function createGovernorConfig(): GovernorConfig {
  const env = getE2eEnv();
  if (!env.governorAddress || !env.timelockAddress || !env.votesAddress) {
    throw new Error("Missing GOVERNOR_ADDRESS, TIMELOCK_ADDRESS, or VOTES_ADDRESS");
  }
  return {
    governorAddress: env.governorAddress,
    timelockAddress: env.timelockAddress,
    votesAddress: env.votesAddress,
    network: "testnet" as Network,
    ...(env.rpcUrl ? { rpcUrl: env.rpcUrl } : {}),
  };
}

export function createSdkClients() {
  const config = createGovernorConfig();
  const signer = createSigner();
  return {
    signer,
    config,
    governor: new GovernorClient(config),
    votes: new VotesClient(config),
    timelock: new TimelockClient(config),
  };
}
