import {
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  SorobanRpc,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  type xdr,
} from "@stellar/stellar-sdk";
import type {
  GovernorConfig,
  Network,
  OptimisticGovernorSettings,
  OptimisticObjection,
  OptimisticProposal,
  OptimisticProposalState,
} from "./types";
import { hexToBytes32 } from "./utils";

const RPC_URLS: Record<Network, string> = {
  mainnet: "https://soroban-rpc.mainnet.stellar.gateway.fm",
  testnet: "https://soroban-testnet.stellar.org",
  futurenet: "https://rpc-futurenet.stellar.org",
};

const PASSPHRASES: Record<Network, string> = {
  mainnet: Networks.PUBLIC,
  testnet: Networks.TESTNET,
  futurenet: Networks.FUTURENET,
};

export class OptimisticGovernorClient {
  private readonly server: SorobanRpc.Server;
  private readonly contract: Contract;
  private readonly passphrase: string;

  constructor(private readonly config: GovernorConfig) {
    if (!config.optimisticGovernorAddress) {
      throw new Error("OptimisticGovernorClient requires optimisticGovernorAddress");
    }
    this.server = new SorobanRpc.Server(config.rpcUrl ?? RPC_URLS[config.network]);
    this.contract = new Contract(config.optimisticGovernorAddress);
    this.passphrase = PASSPHRASES[config.network];
  }

  /** Schedules `target.fnName(calldata)` for execution by default, subject to the challenge window. */
  async propose(
    proposer: Keypair,
    target: string,
    fnName: string,
    calldata: Buffer,
    descriptionHash: string,
  ): Promise<number> {
    const result = await this.submit(
      proposer,
      "propose",
      nativeToScVal(proposer.publicKey(), { type: "address" }),
      nativeToScVal(target, { type: "address" }),
      nativeToScVal(fnName, { type: "symbol" }),
      nativeToScVal(calldata, { type: "bytes" }),
      nativeToScVal(hexToBytes32(descriptionHash), { type: "bytes" }),
    );
    return Number(scValToNative(result.returnValue!));
  }

  /** Casts an objection weighted by the objector's voting power at the proposal's created ledger. */
  async object(objector: Keypair, proposalId: number): Promise<string> {
    return (await this.submit(
      objector,
      "object",
      nativeToScVal(objector.publicKey(), { type: "address" }),
      nativeToScVal(proposalId, { type: "u64" }),
    )).hash;
  }

  /** Permissionless: moves a proposal to `Passed` once its challenge window has elapsed unobjected. */
  async finalize(caller: Keypair, proposalId: number): Promise<{ state: OptimisticProposalState }> {
    await this.submit(
      caller,
      "finalize",
      nativeToScVal(proposalId, { type: "u64" }),
    );
    const proposal = await this.getProposal(proposalId);
    return { state: proposal.state };
  }

  async execute(caller: Keypair, proposalId: number): Promise<string> {
    return (await this.submit(
      caller,
      "execute",
      nativeToScVal(caller.publicKey(), { type: "address" }),
      nativeToScVal(proposalId, { type: "u64" }),
    )).hash;
  }

  async cancel(caller: Keypair, proposalId: number): Promise<string> {
    return (await this.submit(
      caller,
      "cancel",
      nativeToScVal(caller.publicKey(), { type: "address" }),
      nativeToScVal(proposalId, { type: "u64" }),
    )).hash;
  }

  async getProposal(proposalId: number): Promise<OptimisticProposal> {
    const native = await this.simulate(
      "get_proposal",
      nativeToScVal(proposalId, { type: "u64" }),
    ) as Record<string, unknown>;
    return mapProposal(native);
  }

  /** Read-only settings snapshot, e.g. to render an objection-weight progress bar client-side. */
  async getConfig(): Promise<OptimisticGovernorSettings> {
    const native = await this.simulate("get_config") as Record<string, unknown>;
    return {
      votesToken: String(native.votes_token),
      challengeWindowLedgers: Number(native.challenge_window_ledgers),
      objectionThresholdBps: Number(native.objection_threshold_bps),
      proposerBondAmount: BigInt(String(native.proposer_bond_amount)),
      proposerBondToken: String(native.proposer_bond_token),
    };
  }

  async updateConfig(
    admin: Keypair,
    challengeWindowLedgers: number,
    objectionThresholdBps: number,
  ): Promise<string> {
    return (await this.submit(
      admin,
      "update_config",
      nativeToScVal(admin.publicKey(), { type: "address" }),
      nativeToScVal(challengeWindowLedgers, { type: "u32" }),
      nativeToScVal(objectionThresholdBps, { type: "u32" }),
    )).hash;
  }

  /** Indexer-backed listing, optionally filtered by lifecycle state. */
  async listProposals(status?: OptimisticProposalState): Promise<OptimisticProposal[]> {
    if (!this.config.indexerUrl) throw new Error("indexerUrl is required");
    const query = status ? `?status=${encodeURIComponent(toIndexerState(status))}` : "";
    const response = await fetch(`${this.config.indexerUrl}/optimistic/proposals${query}`);
    if (!response.ok) throw new Error(`Indexer request failed: ${response.status}`);
    const json = await response.json() as { data: Array<Record<string, unknown>> };
    return json.data.map(mapIndexedProposal);
  }

  /** Indexer-backed objection history for a proposal. */
  async getObjections(proposalId: number): Promise<OptimisticObjection[]> {
    if (!this.config.indexerUrl) throw new Error("indexerUrl is required");
    const response = await fetch(
      `${this.config.indexerUrl}/optimistic/proposals/${proposalId}/objections`,
    );
    if (!response.ok) throw new Error(`Indexer request failed: ${response.status}`);
    const json = await response.json() as { data: Array<Record<string, unknown>> };
    return json.data.map((row) => ({
      proposalId: BigInt(String(row.proposal_id)),
      objector: String(row.objector),
      weight: BigInt(String(row.weight)),
      runningTotal: BigInt(String(row.running_total)),
      ledger: Number(row.ledger),
    }));
  }

  private async submit(signer: Keypair, fn: string, ...args: xdr.ScVal[]) {
    const account = await this.server.getAccount(signer.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.passphrase,
    }).addOperation(this.contract.call(fn, ...args)).setTimeout(30).build();
    const prepared = await this.server.prepareTransaction(tx);
    prepared.sign(signer);
    const sent = await this.server.sendTransaction(prepared);
    if (sent.status === "ERROR") throw new Error(`Transaction submission failed: ${fn}`);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const status = await this.server.getTransaction(sent.hash);
      if (status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        return { hash: sent.hash, ...status };
      }
      if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        throw new Error(`Transaction failed: ${sent.hash}`);
      }
    }
    throw new Error(`Transaction confirmation timed out: ${sent.hash}`);
  }

  /**
   * Same as {@link submit}, but for wallet-extension signing flows: takes
   * the signer's public key plus a callback that signs an unsigned XDR
   * envelope instead of a raw {@link Keypair}, mirroring
   * `ProposalBondsClient`'s `submitWithSign`.
   */
  private async submitWithSign(
    signerPublicKey: string,
    signUnsignedXdr: (xdr: string) => Promise<string>,
    fn: string,
    ...args: xdr.ScVal[]
  ) {
    const account = await this.server.getAccount(signerPublicKey);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.passphrase,
    }).addOperation(this.contract.call(fn, ...args)).setTimeout(30).build();
    const prepared = await this.server.prepareTransaction(tx);
    const signedXdr = await signUnsignedXdr(prepared.toXDR());
    const signed = TransactionBuilder.fromXDR(signedXdr, this.passphrase);
    const sent = await this.server.sendTransaction(signed);
    if (sent.status === "ERROR") throw new Error(`Transaction submission failed: ${fn}`);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const status = await this.server.getTransaction(sent.hash);
      if (status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        return { hash: sent.hash, ...status };
      }
      if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        throw new Error(`Transaction failed: ${sent.hash}`);
      }
    }
    throw new Error(`Transaction confirmation timed out: ${sent.hash}`);
  }

  /** Wallet-signing variant of {@link propose}. */
  async proposeWithSign(
    proposerPublicKey: string,
    target: string,
    fnName: string,
    calldata: Buffer,
    descriptionHash: string,
    signUnsignedXdr: (xdr: string) => Promise<string>,
  ): Promise<number> {
    const result = await this.submitWithSign(
      proposerPublicKey,
      signUnsignedXdr,
      "propose",
      nativeToScVal(proposerPublicKey, { type: "address" }),
      nativeToScVal(target, { type: "address" }),
      nativeToScVal(fnName, { type: "symbol" }),
      nativeToScVal(calldata, { type: "bytes" }),
      nativeToScVal(hexToBytes32(descriptionHash), { type: "bytes" }),
    );
    return Number(scValToNative(result.returnValue!));
  }

  /** Wallet-signing variant of {@link object}. */
  async objectWithSign(
    objectorPublicKey: string,
    proposalId: number,
    signUnsignedXdr: (xdr: string) => Promise<string>,
  ): Promise<string> {
    const { hash } = await this.submitWithSign(
      objectorPublicKey,
      signUnsignedXdr,
      "object",
      nativeToScVal(objectorPublicKey, { type: "address" }),
      nativeToScVal(proposalId, { type: "u64" }),
    );
    return hash;
  }

  /** Wallet-signing variant of {@link finalize}. Permissionless — any connected account may call it. */
  async finalizeWithSign(
    callerPublicKey: string,
    proposalId: number,
    signUnsignedXdr: (xdr: string) => Promise<string>,
  ): Promise<{ state: OptimisticProposalState }> {
    await this.submitWithSign(
      callerPublicKey,
      signUnsignedXdr,
      "finalize",
      nativeToScVal(proposalId, { type: "u64" }),
    );
    const proposal = await this.getProposal(proposalId);
    return { state: proposal.state };
  }

  /** Wallet-signing variant of {@link execute}. */
  async executeWithSign(
    callerPublicKey: string,
    proposalId: number,
    signUnsignedXdr: (xdr: string) => Promise<string>,
  ): Promise<string> {
    const { hash } = await this.submitWithSign(
      callerPublicKey,
      signUnsignedXdr,
      "execute",
      nativeToScVal(callerPublicKey, { type: "address" }),
      nativeToScVal(proposalId, { type: "u64" }),
    );
    return hash;
  }

  /** Wallet-signing variant of {@link cancel}. */
  async cancelWithSign(
    callerPublicKey: string,
    proposalId: number,
    signUnsignedXdr: (xdr: string) => Promise<string>,
  ): Promise<string> {
    const { hash } = await this.submitWithSign(
      callerPublicKey,
      signUnsignedXdr,
      "cancel",
      nativeToScVal(callerPublicKey, { type: "address" }),
      nativeToScVal(proposalId, { type: "u64" }),
    );
    return hash;
  }

  private async simulate(fn: string, ...args: xdr.ScVal[]): Promise<unknown> {
    const source = this.config.simulationAccount ?? this.config.optimisticGovernorAddress!;
    const account = await this.server.getAccount(source);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.passphrase,
    }).addOperation(this.contract.call(fn, ...args)).setTimeout(30).build();
    const result = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(result) || !result.result?.retval) {
      throw new Error(`Simulation failed: ${fn}`);
    }
    return scValToNative(result.result.retval);
  }
}

function mapProposal(native: Record<string, unknown>): OptimisticProposal {
  return {
    id: BigInt(String(native.id)),
    proposer: String(native.proposer),
    target: String(native.target),
    fnName: String(native.fn_name),
    calldata: native.calldata as Buffer | Uint8Array,
    descriptionHash: native.description_hash as Buffer | Uint8Array,
    createdLedger: Number(native.created_ledger),
    challengeEndLedger: Number(native.challenge_end_ledger),
    objectionVotes: BigInt(String(native.objection_votes)),
    state: mapState(native.state),
  };
}

/** The on-chain `OptimisticProposalState` enum decodes as `{ tag: "ChallengeWindow", values: undefined }`. */
function mapState(raw: unknown): OptimisticProposalState {
  const tag = (raw as { tag?: string })?.tag ?? String(raw);
  return tag as OptimisticProposalState;
}

function toIndexerState(state: OptimisticProposalState): string {
  const map: Record<OptimisticProposalState, string> = {
    ChallengeWindow: "challenge_window",
    Objected: "objected",
    Passed: "passed",
    Executed: "executed",
    Cancelled: "cancelled",
  };
  return map[state];
}

function fromIndexerState(state: string): OptimisticProposalState {
  const map: Record<string, OptimisticProposalState> = {
    challenge_window: "ChallengeWindow",
    objected: "Objected",
    passed: "Passed",
    executed: "Executed",
    cancelled: "Cancelled",
  };
  return map[state] ?? "ChallengeWindow";
}

/**
 * The indexer's `optimistic_proposals` row only carries what the
 * `ProposalCreated` event emits (proposer, challenge_end_ledger) plus
 * lifecycle fields — `target`/`fnName`/`calldata`/`descriptionHash` require
 * a live `get_proposal` read, same scope boundary as the on-chain event
 * body itself.
 */
function mapIndexedProposal(row: Record<string, unknown>): OptimisticProposal {
  return {
    id: BigInt(String(row.proposal_id)),
    proposer: String(row.proposer),
    target: "",
    fnName: "",
    calldata: Buffer.alloc(0),
    descriptionHash: Buffer.alloc(0),
    createdLedger: Number(row.created_ledger),
    challengeEndLedger: Number(row.challenge_end_ledger),
    objectionVotes: BigInt(String(row.objection_votes ?? 0)),
    state: fromIndexerState(String(row.state)),
  };
}
