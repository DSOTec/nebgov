import { Keypair } from "@stellar/stellar-sdk";
import { GovernorClient } from "../governor";
import type { GovernorConfig } from "../types";

const TESTNET_SECRET_KEY = process.env.TESTNET_SECRET_KEY;
const TESTNET_RPC_URL = process.env.TESTNET_RPC_URL;
const GOVERNOR_ADDRESS = process.env.GOVERNOR_ADDRESS;
const TIMELOCK_ADDRESS = process.env.TIMELOCK_ADDRESS;
const TOKEN_VOTES_ADDRESS = process.env.TOKEN_VOTES_ADDRESS;

const hasEnv = Boolean(
  TESTNET_SECRET_KEY &&
    GOVERNOR_ADDRESS &&
    TIMELOCK_ADDRESS &&
    TOKEN_VOTES_ADDRESS,
);

const describeIfConfigured = hasEnv ? describe : describe.skip;

describeIfConfigured("SDK load tests", () => {
  let governor: GovernorClient;

  beforeAll(() => {
    const signer = Keypair.fromSecret(TESTNET_SECRET_KEY as string);
    const config: GovernorConfig = {
      governorAddress: GOVERNOR_ADDRESS as string,
      timelockAddress: TIMELOCK_ADDRESS as string,
      votesAddress: TOKEN_VOTES_ADDRESS as string,
      network: "testnet",
      rpcUrl: TESTNET_RPC_URL,
      simulationAccount: signer.publicKey(),
    };
    governor = new GovernorClient(config);
  });

  it("handles 500 concurrent getProposal() calls", async () => {
    const count = await governor.proposalCount();
    const maxId = count > 0n ? Number(count) : 1;
    const requests = Array.from({ length: 500 }, (_, i) => {
      const pid = BigInt((i % maxId) + 1);
      return governor.getProposal(pid);
    });

    const start = Date.now();
    const results = await Promise.allSettled(requests);
    const elapsed = Date.now() - start;

    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    expect(elapsed).toBeLessThan(10_000);
    expect(succeeded).toBeGreaterThan(0);
  }, 30_000);
});
