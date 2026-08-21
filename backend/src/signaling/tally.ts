import {
  Contract,
  Keypair,
  Networks,
  BASE_FEE,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import pool from "../db/pool";
import { logger } from "../logger";

// Reuses the same RPC/network/contract env vars already configured for
// backend/src/routes/relayer.ts rather than adding a second RPC client.
const NETWORK_PASSPHRASES: Record<string, string> = {
  mainnet: Networks.PUBLIC,
  public: Networks.PUBLIC,
  testnet: Networks.TESTNET,
  futurenet: Networks.FUTURENET,
};

function networkPassphrase(): string {
  const key = (process.env.STELLAR_NETWORK ?? "testnet").toLowerCase();
  return NETWORK_PASSPHRASES[key] ?? Networks.TESTNET;
}

function rpcServer(): rpc.Server {
  const url = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
  return new rpc.Server(url, { allowHttp: false });
}

function votesContract(): Contract {
  const votesAddress = process.env.TOKEN_VOTES_CONTRACT_ID;
  if (!votesAddress) {
    throw new Error("TOKEN_VOTES_CONTRACT_ID is not configured");
  }
  return new Contract(votesAddress);
}

function governorContract(): Contract {
  const governorAddress = process.env.GOVERNOR_CONTRACT_ID;
  if (!governorAddress) {
    throw new Error("GOVERNOR_CONTRACT_ID is not configured");
  }
  return new Contract(governorAddress);
}

/** Fee-source account for read-only simulation — the relayer's own funded account. */
function simulationAccountAddress(): string {
  const secret = process.env.RELAYER_SECRET_KEY;
  if (!secret) {
    throw new Error("RELAYER_SECRET_KEY is not configured");
  }
  return Keypair.fromSecret(secret).publicKey();
}

/** Read-only simulation of `fnName` on `contract`, returning its native-decoded result. */
async function simulateRead(contract: Contract, fnName: string, args: xdr.ScVal[]): Promise<unknown> {
  const server = rpcServer();
  const source = await server.getAccount(simulationAccountAddress());

  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: networkPassphrase(),
  })
    .addOperation(contract.call(fnName, ...args))
    .setTimeout(30)
    .build();

  const result = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(result)) {
    throw new Error(`${fnName} simulation failed: ${result.error}`);
  }
  const raw = (result as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
  return raw ? scValToNative(raw) : undefined;
}

/**
 * Reads `account`'s token-votes voting power as of `ledger` via
 * `get_past_votes`, the same snapshot-checkpointed read the governor
 * contract itself uses for quorum/threshold math. Returns 0n for an
 * address with no checkpointed voting history — the contract never
 * throws for unknown addresses.
 */
export async function getVotingPowerAtLedger(account: string, ledger: number): Promise<bigint> {
  const raw = await simulateRead(votesContract(), "get_past_votes", [
    nativeToScVal(account, { type: "address" }),
    nativeToScVal(ledger, { type: "u32" }),
  ]);
  return raw ? BigInt(raw as bigint) : 0n;
}

/** Reads `account`'s current (non-snapshot) token-votes voting power. */
export async function getCurrentVotingPower(account: string): Promise<bigint> {
  const raw = await simulateRead(votesContract(), "get_votes", [
    nativeToScVal(account, { type: "address" }),
  ]);
  return raw ? BigInt(raw as bigint) : 0n;
}

/**
 * Reads the governor's current `proposal_threshold` — reused as the minimum
 * voting-power bar to create a signaling poll, so the bar tracks the same
 * governance-tuned value formal proposals use instead of a hardcoded number.
 */
export async function getProposalThreshold(): Promise<bigint> {
  const raw = await simulateRead(governorContract(), "proposal_threshold", []);
  return raw ? BigInt(raw as bigint) : 0n;
}

export interface PollResults {
  choices: string[];
  /** Weighted voting power per choice, aligned by index with `choices`. */
  totals: string[];
  totalVotes: number;
  totalWeight: string;
}

/**
 * Computes the weighted tally for `pollId`: reads all cast votes, resolves
 * each distinct voter's voting power at `snapshotLedger` (a vote from an
 * address with zero voting power at the snapshot correctly contributes zero
 * weight rather than being dropped from the count), persists the resolved
 * `voting_power` back onto each `signaling_votes` row, and returns the
 * per-choice weighted totals.
 */
export async function computeWeightedTally(
  pollId: number,
  snapshotLedger: number,
  choices: string[],
): Promise<PollResults> {
  const { rows: votes } = await pool.query<{
    id: number;
    voter_address: string;
    choice_index: number;
  }>(
    `SELECT id, voter_address, choice_index FROM signaling_votes WHERE poll_id = $1`,
    [pollId],
  );

  const powerByVoter = new Map<string, bigint>();
  for (const vote of votes) {
    if (powerByVoter.has(vote.voter_address)) continue;
    try {
      const power = await getVotingPowerAtLedger(vote.voter_address, snapshotLedger);
      powerByVoter.set(vote.voter_address, power);
    } catch (err) {
      logger.error(
        { err, pollId, voter: vote.voter_address },
        "Failed to resolve voting power for signaling vote",
      );
      powerByVoter.set(vote.voter_address, 0n);
    }
  }

  const totals = new Array(choices.length).fill(0n) as bigint[];
  for (const vote of votes) {
    const power = powerByVoter.get(vote.voter_address) ?? 0n;
    if (vote.choice_index >= 0 && vote.choice_index < totals.length) {
      totals[vote.choice_index] += power;
    }
    await pool.query(`UPDATE signaling_votes SET voting_power = $1 WHERE id = $2`, [
      power.toString(),
      vote.id,
    ]);
  }

  const totalWeight = totals.reduce((sum, t) => sum + t, 0n);

  return {
    choices,
    totals: totals.map((t) => t.toString()),
    totalVotes: votes.length,
    totalWeight: totalWeight.toString(),
  };
}
