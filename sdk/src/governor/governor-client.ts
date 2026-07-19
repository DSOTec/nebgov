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
  GovernorSettingsValidationLimits,
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

// Import standalone functions for method delegation
import {
  propose as _propose,
  proposeWithSign as _proposeWithSign,
  simulateTargetInvocation as _simulateTargetInvocation,
  simulateProposal as _simulateProposal,
  estimateProposeResources as _estimateProposeResources,
  cancel as _cancel,
  cancelByGovernance as _cancelByGovernance,
  cancelByGovernanceWithSign as _cancelByGovernanceWithSign,
  waitForProposalState as _waitForProposalState,
  getProposal as _getProposal,
  getQueueTime as _getQueueTime,
  getQueuedOpIds as _getQueuedOpIds,
  getTimelockInfo as _getTimelockInfo,
  getProposalsBatch as _getProposalsBatch,
  getProposalExpiryLedger as _getProposalExpiryLedger,
  buildUpdateConfigProposal as _buildUpdateConfigProposal,
} from "./proposals";
import {
  estimateVoteGas as _estimateVoteGas,
  castVote as _castVote,
  castVoteWithSign as _castVoteWithSign,
  castVoteWithReason as _castVoteWithReason,
  castVoteWithReasonAndSign as _castVoteWithReasonAndSign,
  getProposalVotes as _getProposalVotes,
  hasVoted as _hasVoted,
  canPropose as _canPropose,
  getVotingHistory as _getVotingHistory,
  getVotesCastByAddress as _getVotesCastByAddress,
  getReceipt as _getReceipt,
  getVoteReason as _getVoteReason,
} from "./voting";
import {
  proposalThreshold as _proposalThreshold,
  getSettings as _getSettings,
  getProposalState as _getProposalState,
  getQuorum as _getQuorum,
  isQuorumReached as _isQuorumReached,
  getLatestLedger as _getLatestLedger,
  proposalCount as _proposalCount,
  getProposalsSummaryBatch as _getProposalsSummaryBatch,
} from "./queries";
import {
  getProposalsForAddress as _getProposalsForAddress,
} from "./events";

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

  // ── Proposal methods ──────────────────────────────────────────────────────

  async propose(
    signer: Keypair,
    description: string,
    descriptionHashOrTargets: string | string[],
    metadataUriOrFnNames: string | string[],
    targetsOrCalldatas: string[] | (Buffer | Uint8Array)[],
    fnNamesArg?: string[],
    calldatasArg?: (Buffer | Uint8Array)[],
  ): Promise<bigint> {
    return _propose(this, signer, description, descriptionHashOrTargets, metadataUriOrFnNames, targetsOrCalldatas, fnNamesArg, calldatasArg);
  }

  async proposeWithSign(
    signerPublicKey: string,
    description: string,
    descriptionHash: string,
    metadataUri: string,
    targets: string[],
    fnNames: string[],
    calldatas: (Buffer | Uint8Array)[],
    signUnsignedXdr: (xdr: string) => Promise<string>,
  ): Promise<{ proposalId: bigint; txHash: string }> {
    return _proposeWithSign(this, signerPublicKey, description, descriptionHash, metadataUri, targets, fnNames, calldatas, signUnsignedXdr);
  }

  async simulateTargetInvocation(
    footprintSourceAccount: string,
    contractId: string,
    functionName: string,
    args: xdr.ScVal[],
  ): Promise<{ ok: boolean; error?: string; cpuInsns?: string; memBytes?: string }> {
    return _simulateTargetInvocation(this, footprintSourceAccount, contractId, functionName, args);
  }

  async estimateProposeResources(
    proposer: string,
    description: string,
    descriptionHash: string,
    metadataUri: string,
    targets: string[],
    fnNames: string[],
    calldatas: (Buffer | Uint8Array)[],
  ): Promise<{ ok: boolean; error?: string; cpuInsns?: string; memBytes?: string }> {
    return _estimateProposeResources(this, proposer, description, descriptionHash, metadataUri, targets, fnNames, calldatas);
  }

  async waitForProposalState(proposalId: bigint, targetState: ProposalState, opts?: { timeoutMs?: number; pollIntervalMs?: number }): Promise<void> {
    return _waitForProposalState(this, proposalId, targetState, opts);
  }

  async getProposal(proposalId: bigint): Promise<Proposal> {
    return _getProposal(this, proposalId);
  }

  async getProposalsBatch(proposalIds: bigint[], concurrency = 10): Promise<Array<{ id: bigint; proposal?: Proposal; error?: Error }>> {
    return _getProposalsBatch(this, proposalIds, concurrency);
  }

  async getProposalExpiryLedger(proposalId: bigint): Promise<number> {
    return _getProposalExpiryLedger(this, proposalId);
  }

  buildUpdateConfigProposal(
    newSettings: GovernorSettings,
    limits?: GovernorSettingsValidationLimits,
  ): { target: string; fnName: string; calldata: Uint8Array } {
    return _buildUpdateConfigProposal(this, newSettings, limits);
  }

  async queue(signer: Keypair, proposalId: bigint): Promise<void> {
    return this.retry(async () => {
      const account = await this.server.getAccount(signer.publicKey());
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call("queue", nativeToScVal(proposalId, { type: "u64" })),
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

  // ── Voting methods ────────────────────────────────────────────────────────

  async estimateVoteGas(voter: string, proposalId: bigint, support: VoteSupport): Promise<{ ok: boolean; error?: string; cpuInsns?: string; memBytes?: string; estimatedFeeStroops?: string }> {
    return _estimateVoteGas(this, voter, proposalId, support);
  }

  async castVote(signer: Keypair, proposalId: bigint, support: VoteSupport): Promise<string> {
    return _castVote(this, signer, proposalId, support);
  }

  async castVoteWithSign(signerPublicKey: string, proposalId: bigint, support: VoteSupport, signUnsignedXdr: (xdr: string) => Promise<string>): Promise<void> {
    return _castVoteWithSign(this, signerPublicKey, proposalId, support, signUnsignedXdr);
  }

  async getProposalVotes(proposalId: bigint): Promise<ProposalVotes> {
    return _getProposalVotes(this, proposalId);
  }

  async hasVoted(proposalId: bigint, voter: string): Promise<boolean> {
    return _hasVoted(this, proposalId, voter);
  }

  async canPropose(proposer: string): Promise<CanProposeResult> {
    return _canPropose(this, proposer);
  }

  async getVotingHistory(voter: string, opts?: { fromLedger?: number; limit?: number }): Promise<VotingHistoryEntry[]> {
    return _getVotingHistory(this, voter, opts);
  }

  async getVotesCastByAddress(voter: string, opts?: { fromLedger?: number; limit?: number }): Promise<VotingHistoryEntry[]> {
    return _getVotesCastByAddress(this, voter, opts);
  }

  // ── Query methods ─────────────────────────────────────────────────────────

  async proposalThreshold(): Promise<bigint> {
    return _proposalThreshold(this);
  }

  async getSettings(sourceAccount?: string): Promise<GovernorSettings> {
    return _getSettings(this, sourceAccount);
  }

  async getProposalState(proposalId: bigint): Promise<ProposalState> {
    return _getProposalState(this, proposalId);
  }

  async getQuorum(proposalId: bigint): Promise<bigint> {
    return _getQuorum(this, proposalId);
  }

  async isQuorumReached(proposalId: bigint): Promise<boolean> {
    return _isQuorumReached(this, proposalId);
  }

  async getLatestLedger(): Promise<number> {
    return _getLatestLedger(this);
  }

  async proposalCount(): Promise<bigint> {
    return _proposalCount(this);
  }

  async getProposalsSummaryBatch(proposalIds: bigint[], concurrency = 10): Promise<Array<{ id: bigint; state?: ProposalState; votes?: ProposalVotes; error?: Error }>> {
    return _getProposalsSummaryBatch(this, proposalIds, concurrency);
  }

  // ── Event methods ─────────────────────────────────────────────────────────

  async getProposalsForAddress(proposer: string, opts?: { fromLedger?: number; limit?: number }): Promise<Array<{ id: bigint; proposal: Proposal; state: ProposalState }>> {
    return _getProposalsForAddress(this, proposer, opts);
  }
}