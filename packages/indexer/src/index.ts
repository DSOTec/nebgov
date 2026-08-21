import { createServer } from "http";
import { Networks, SorobanRpc } from "@stellar/stellar-sdk";
import dotenv from "dotenv";
import { initDb, pool } from "./db";
import {
  processEvents,
  getLastIndexedLedger,
  updateLastIndexedLedger,
  maybeTakeGovernanceSnapshot,
} from "./events";
import { createApp } from "./api";
import { createWsServer } from "./ws";
import { createTreasuryStateReader } from "./treasuryReader";
import { bootstrapTreasuryProjection } from "./treasuryProjection";

dotenv.config();

const GOVERNOR_ADDRESS = process.env.GOVERNOR_ADDRESS ?? "";
const WRAPPER_ADDRESS = process.env.WRAPPER_ADDRESS ?? "";
const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS ?? "";
const LIQUIDITY_ADDRESS = process.env.LIQUIDITY_ADDRESS ?? "";
const CO_SPONSORSHIP_ADDRESS = process.env.CO_SPONSORSHIP_ADDRESS ?? "";
const PROPOSAL_BONDS_ADDRESS = process.env.PROPOSAL_BONDS_ADDRESS ?? "";
const TOKEN_VOTES_ADDRESS = process.env.TOKEN_VOTES_ADDRESS ?? "";
const TIMELOCK_ADDRESS = process.env.TIMELOCK_ADDRESS ?? "";
const TREASURY_SIMULATION_ACCOUNT =
  process.env.TREASURY_SIMULATION_ACCOUNT ?? "";
const NETWORK_PASSPHRASE =
  process.env.STELLAR_NETWORK_PASSPHRASE ?? Networks.TESTNET;
const RPC_URL = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 5000);
const PORT = Number(process.env.PORT ?? 3001);

// Track indexer startup time for uptime calculation
export const startTime = Date.now();

let pollingInterval: ReturnType<typeof setInterval> | null = null;
let currentBatchPromise: Promise<void> = Promise.resolve();
let isShuttingDown = false;

async function shutdown(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log("Shutting down gracefully...");

  if (pollingInterval !== null) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }

  // Wait for the in-flight batch to complete before closing the DB connection
  await currentBatchPromise;

  await pool.end();
  console.log("Database connections closed.");
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

async function runIndexer(): Promise<void> {
  const server = new SorobanRpc.Server(RPC_URL, { allowHttp: false });
  if (TREASURY_ADDRESS && !TREASURY_SIMULATION_ACCOUNT) {
    throw new Error(
      "TREASURY_SIMULATION_ACCOUNT is required when TREASURY_ADDRESS is configured",
    );
  }
  const treasuryStateReader =
    TREASURY_ADDRESS && TREASURY_SIMULATION_ACCOUNT
      ? createTreasuryStateReader({
          server,
          treasuryAddress: TREASURY_ADDRESS,
          simulationAccount: TREASURY_SIMULATION_ACCOUNT,
          networkPassphrase: NETWORK_PASSPHRASE,
        })
      : undefined;

  const config = {
    rpcUrl: RPC_URL,
    governorAddress: GOVERNOR_ADDRESS,
    wrapperAddress: WRAPPER_ADDRESS,
    treasuryAddress: TREASURY_ADDRESS,
    liquidityAddress: LIQUIDITY_ADDRESS,
    coSponsorshipAddress: CO_SPONSORSHIP_ADDRESS,
    proposalBondsAddress: PROPOSAL_BONDS_ADDRESS,
    tokenVotesAddress: TOKEN_VOTES_ADDRESS,
    timelockAddress: TIMELOCK_ADDRESS,
    treasuryStateReader,
    pollIntervalMs: POLL_INTERVAL_MS,
  };

  if (treasuryStateReader) {
    const currentLedger = (await server.getLatestLedger()).sequence;
    const hydrated = await bootstrapTreasuryProjection(
      treasuryStateReader,
      currentLedger,
    );
    console.log(
      `Hydrated ${hydrated.streams} treasury streams and ${hydrated.spends} spends`,
    );
  }

  let lastLedger = await getLastIndexedLedger();

  console.log(`Starting indexer from ledger ${lastLedger}`);

  async function pollOnce(): Promise<void> {
    if (isShuttingDown) return;
    const batchPromise = (async () => {
      const latestLedger = await processEvents(server, config, lastLedger + 1);
      if (latestLedger > lastLedger) {
        await updateLastIndexedLedger(latestLedger);
        lastLedger = latestLedger;
        console.log(`Indexed up to ledger ${lastLedger}`);
        await maybeTakeGovernanceSnapshot(latestLedger);
      }
    })();
    currentBatchPromise = batchPromise.catch((err) => {
      console.error("Batch processing error:", err);
    });
    await currentBatchPromise;
  }

  // Run the first poll immediately, then schedule subsequent ones.
  await pollOnce();

  pollingInterval = setInterval(() => {
    currentBatchPromise = pollOnce().catch((err) => {
      console.error("Poll error:", err);
    });
  }, POLL_INTERVAL_MS);
}

async function main(): Promise<void> {
  await initDb();
  console.log("Database initialized");

  // Start REST API + WebSocket server
  const rpcServer = new SorobanRpc.Server(RPC_URL, { allowHttp: false });
  const app = createApp(rpcServer);
  const httpServer = createServer(app);
  createWsServer(httpServer);
  httpServer.listen(PORT, () => {
    console.log(`NebGov indexer API running on port ${PORT}`);
    console.log(`WebSocket endpoint: ws://localhost:${PORT}/events`);
  });

  // Start indexer loop
  runIndexer().catch((err) => {
    console.error("Indexer fatal error:", err);
    process.exit(1);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
