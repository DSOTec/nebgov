import { VotesClient } from "@nebgov/sdk";
import { AssertionError } from "./errors";

/** Asserts an account's raw seeded balance (`SimulationConfig.tokenBalances`), not its delegated voting power. */
export async function assertTokenBalance(client: VotesClient, address: string, expected: bigint): Promise<void> {
  const actual = await client.getBaseVotes(address);
  if (actual !== expected) {
    throw new AssertionError(`${address}: expected base balance ${expected}, got ${actual}`);
  }
}

export async function assertDelegatedVotes(client: VotesClient, address: string, expected: bigint): Promise<void> {
  const actual = await client.getVotes(address);
  if (actual !== expected) {
    throw new AssertionError(`${address}: expected delegated votes ${expected}, got ${actual}`);
  }
}
