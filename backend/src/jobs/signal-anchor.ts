import crypto from "crypto";
import {
  Contract,
  Keypair,
  Networks,
  BASE_FEE,
  TransactionBuilder,
  nativeToScVal,
  rpc,
} from "@stellar/stellar-sdk";
import pool from "../db/pool";
import { logger } from "../logger";
import { computeWeightedTally, type PollResults } from "../signaling/tally";

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

function anchorContract(): Contract | null {
  const address = process.env.SIGNAL_ANCHOR_CONTRACT_ID;
  return address ? new Contract(address) : null;
}

function getRelayerKeypair(): Keypair {
  const secret = process.env.RELAYER_SECRET_KEY;
  if (!secret) {
    throw new Error("RELAYER_SECRET_KEY is not configured");
  }
  return Keypair.fromSecret(secret);
}

/** Deterministic hash of a finalized tally — anchored on-chain as immutable proof. */
export function computeResultHash(pollId: number, results: PollResults): string {
  const canonical = JSON.stringify({
    pollId,
    choices: results.choices,
    totals: results.totals,
  });
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

async function anchorOnChain(pollId: number, resultHashHex: string): Promise<string> {
  const contract = anchorContract();
  if (!contract) {
    throw new Error("SIGNAL_ANCHOR_CONTRACT_ID is not configured");
  }
  const relayer = getRelayerKeypair();
  const server = rpcServer();
  const account = await server.getAccount(relayer.publicKey());

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: networkPassphrase(),
  })
    .addOperation(
      contract.call(
        "anchor_result",
        nativeToScVal(relayer.publicKey(), { type: "address" }),
        nativeToScVal(pollId, { type: "u64" }),
        nativeToScVal(Buffer.from(resultHashHex, "hex"), { type: "bytes" }),
      ),
    )
    .setTimeout(30)
    .build();

  const prepared = await server.prepareTransaction(tx);
  prepared.sign(relayer);
  const result = await server.sendTransaction(prepared);
  if (result.status === "ERROR") {
    throw new Error(`anchor_result submission failed: ${JSON.stringify(result.errorResult ?? result)}`);
  }
  return result.hash;
}

/**
 * Closes signaling polls whose `end_time` has passed, finalizes their
 * weighted tally, and — when `SIGNAL_ANCHOR_ON_CHAIN=true` — submits the
 * finalized `(poll_id, result_hash)` to the signal-anchor contract so the
 * published result can't be silently edited afterward.
 */
export class SignalAnchorService {
  private interval: NodeJS.Timeout | null = null;
  private isProcessing = false;

  start() {
    const intervalMs = Number(process.env.SIGNAL_ANCHOR_INTERVAL_MS ?? "30000");
    logger.info({ intervalMs }, "Starting signal anchor service");
    this.interval = setInterval(() => this.tick(), intervalMs);
    this.tick();
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async tick() {
    if (this.isProcessing) return;
    this.isProcessing = true;
    try {
      await this.finalizeEndedPolls();
    } catch (error) {
      logger.error({ err: error }, "Signal anchor tick failed");
    } finally {
      this.isProcessing = false;
    }
  }

  private async finalizeEndedPolls(): Promise<void> {
    const { rows: polls } = await pool.query(
      `SELECT id, choices, snapshot_ledger FROM signaling_polls
       WHERE finalized = FALSE AND end_time <= NOW()`,
    );

    for (const poll of polls) {
      try {
        const results = await computeWeightedTally(poll.id, poll.snapshot_ledger, poll.choices);
        const resultHash = computeResultHash(poll.id, results);

        let anchoredTxHash: string | null = null;
        if (process.env.SIGNAL_ANCHOR_ON_CHAIN === "true") {
          try {
            anchoredTxHash = await anchorOnChain(poll.id, resultHash);
          } catch (err) {
            logger.error({ err, pollId: poll.id }, "Failed to anchor signaling result on-chain");
          }
        }

        await pool.query(
          `UPDATE signaling_polls
           SET finalized = TRUE, result_hash = $1, anchored_tx_hash = $2
           WHERE id = $3`,
          [resultHash, anchoredTxHash, poll.id],
        );
        logger.info({ pollId: poll.id, resultHash, anchoredTxHash }, "Finalized signaling poll");
      } catch (err) {
        logger.error({ err, pollId: poll.id }, "Failed to finalize signaling poll");
      }
    }
  }
}

export const signalAnchorService = new SignalAnchorService();
