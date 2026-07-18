import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  Keypair,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import {
  GovernorConfig,
  GovernorSettings,
  VoteSupport,
  VoteType,
  Network,
  Proposal,
  ProposalState,
  ProposalVotes,
  CanProposeResult,
  VotingHistoryEntry,
} from "../types";

import { GovernorError, GovernorErrorCode, parseGovernorError } from "../errors";
import { hexToBytes32, withRetry } from "../utils";

const RPC_URLS: Record<Network, string> = {
  mainnet: "https://soroban-rpc.mainnet.stellar.gateway.fm",
  testnet: "https://soroban-testnet.stellar.org",
  futurenet: "https://rpc-futurenet.stellar.org",
};

const NETWORK_PASSPHRASES: Record<Network, string> = {
  mainnet: Networks.PUBLIC,
  testnet: Networks.TESTNET,
  futurenet: Networks.FUTURENET,
};

const DEFAULT_MAX_VOTING_DELAY = 1_209_600;
const DEFAULT_MIN_VOTING_PERIOD = 1;

export function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string") return BigInt(value);
  return 0n;
}

export function simulationCostValue(
  cost: unknown,
  ...keys: string[]
): bigint | undefined {
  if (!cost || typeof cost !== "object") return undefined;
  const record = cost as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null) return toBigInt(value);
  }
  return undefined;
}

export function scVecAddress(addrs: string[]): xdr.ScVal {
  return xdr.ScVal.scvVec(
    addrs.map((a) => nativeToScVal(a, { type: "address" })),
  );
}

export function scVecSymbol(syms: string[]): xdr.ScVal {
  return xdr.ScVal.scvVec(
    syms.map((s) => nativeToScVal(s.trim(), { type: "symbol" })),
  );
}

export function scVecBytes(blobs: (Buffer | Uint8Array)[]): xdr.ScVal {
  return xdr.ScVal.scvVec(
    blobs.map((b) => nativeToScVal(b, { type: "bytes" })),
  );
}

/**
 * GovernorClient — interact with a deployed NebGov governor contract.
 *
 * TODO issue #14: add full error handling, retry logic, and simulation flow.
 */
export class GovernorClient {
  readonly config: GovernorConfig;
  readonly server: SorobanRpc.Server;
  readonly contract: Contract;
  readonly networkPassphrase: string;

  constructor(config: GovernorConfig) {
    this.config = config;
    const rpcUrl = config.rpcUrl ?? RPC_URLS[config.network];
    this.server = new SorobanRpc.Server(rpcUrl, { allowHttp: false });
    this.contract = new Contract(config.governorAddress);
    this.networkPassphrase = NETWORK_PASSPHRASES[config.network];
  }

  async retry<T>(
    fn: () => Promise<T>,
    retryOn?: (e: unknown) => boolean,
  ): Promise<T> {
    return withRetry(fn, {
      maxAttempts: this.config.maxAttempts ?? 3,
      baseDelayMs: this.config.baseDelayMs ?? 1000,
      retryOn,
      onRetry: (attempt, error) => {
        console.debug(`[GovernorClient] Retry attempt ${attempt} due to error:`, error);
      },
    });
  }

  isNetworkError(e: unknown): boolean {
    if (e instanceof Error) {
      const msg = e.message.toLowerCase();
      if (
        msg.includes("fetch") ||
        msg.includes("network") ||
        msg.includes("timeout") ||
        msg.includes("aborted") ||
        msg.includes("connection refused") ||
        msg.includes("econnrefused") ||
        msg.includes("500") ||
        msg.includes("502") ||
        msg.includes("503") ||
        msg.includes("504")
      ) {
        return true;
      }
    }
    return false;
  }

  isRetryableSubmissionError(e: unknown): boolean {
    if (this.isNetworkError(e)) return true;

    // Do not retry on contract errors (parsed as GovernorError with code < 100)
    if (e instanceof GovernorError && e.code < 100) {
      return false;
    }

    // Do not retry if already in mempool (idempotency check)
    if (e instanceof Error && e.message.includes("TransactionAlreadyInMempool")) {
      return false;
    }

    return false;
  }

  readAccount(sourceAccount?: string): string {
    return (
      sourceAccount ??
      this.config.simulationAccount ??
      this.config.governorAddress
    );
  }

  async pollForConfirmation(
    hash: string,
    retries = 10,
    delayMs = 2000,
  ): Promise<SorobanRpc.Api.GetSuccessfulTransactionResponse> {
    for (let i = 0; i < retries; i++) {
      await new Promise((r) => setTimeout(r, delayMs));
      const status = await this.server.getTransaction(hash);
      if (status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        return status as SorobanRpc.Api.GetSuccessfulTransactionResponse;
      }
      if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        throw new Error(`Transaction failed: ${hash}`);
      }
    }
    throw new Error(`Transaction not confirmed after ${retries} retries`);
  }

  async execute(signer: Keypair, proposalId: bigint): Promise<void> {
    return this.retry(async () => {
      const account = await this.server.getAccount(signer.publicKey());
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call("execute", nativeToScVal(proposalId, { type: "u64" })),
        )
        .setTimeout(30)
        .build();

      const simResult = await this.server.simulateTransaction(tx);
      if (SorobanRpc.Api.isSimulationError(simResult)) {
        const errStr = (simResult as SorobanRpc.Api.SimulateTransactionErrorResponse).error ?? "";
        throw parseGovernorError(errStr);
      }

      const assembled = SorobanRpc.assembleTransaction(
        tx,
        simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse,
      ).build();
      assembled.sign(signer);

      const result = await this.server.sendTransaction(assembled);
      if (result.status === "ERROR") {
        throw parseGovernorError((result as unknown as { error?: string }).error ?? "");
      }
      await this.pollForConfirmation(result.hash);
    }, (e) => this.isRetryableSubmissionError(e));
  }

  async listProposals(from: number, count: number): Promise<Proposal[]> {
    const account = await this.server.getAccount(this.readAccount());

    const listTx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "get_proposal_list",
          nativeToScVal(from, { type: "u32" }),
          nativeToScVal(count, { type: "u32" }),
        ),
      )
      .setTimeout(30)
      .build();

    const listResult = await this.server.simulateTransaction(listTx);
    if (!SorobanRpc.Api.isSimulationError(listResult)) {
      const raw = (listResult as SorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
      return raw ? (scValToNative(raw) as Proposal[]) : [];
    }

    // Fallback: fetch proposal_count then individual proposals
    const countTx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(this.contract.call("proposal_count"))
      .setTimeout(30)
      .build();

    const countResult = await this.server.simulateTransaction(countTx);
    if (SorobanRpc.Api.isSimulationError(countResult)) return [];

    const countRaw = (countResult as SorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    const total = countRaw ? Number(scValToNative(countRaw)) : 0;

    const proposals: Proposal[] = [];
    for (let i = from + 1; i <= Math.min(from + count, total); i++) {
      const proposalTx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call("get_proposal", nativeToScVal(BigInt(i), { type: "u64" })),
        )
        .setTimeout(30)
        .build();

      const proposalResult = await this.server.simulateTransaction(proposalTx);
      if (SorobanRpc.Api.isSimulationError(proposalResult)) continue;

      const proposalRaw = (proposalResult as SorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
      if (proposalRaw) {
        proposals.push(scValToNative(proposalRaw) as Proposal);
      }
    }
    return proposals;
  }
}