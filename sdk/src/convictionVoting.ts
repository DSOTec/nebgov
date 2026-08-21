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
  ConvictionProposal,
  ConvictionSnapshot,
  GovernorConfig,
  Network,
} from "./types";

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

export class ConvictionVotingClient {
  private readonly server: SorobanRpc.Server;
  private readonly contract: Contract;
  private readonly passphrase: string;

  constructor(private readonly config: GovernorConfig) {
    if (!config.convictionVotingAddress) {
      throw new Error("ConvictionVotingClient requires convictionVotingAddress");
    }
    this.server = new SorobanRpc.Server(config.rpcUrl ?? RPC_URLS[config.network]);
    this.contract = new Contract(config.convictionVotingAddress);
    this.passphrase = PASSPHRASES[config.network];
  }

  async createProposal(
    proposer: Keypair,
    target: string,
    fnName: string,
    calldata: Buffer,
    requestedAmount: bigint,
  ): Promise<number> {
    const result = await this.submit(
      proposer,
      "create_proposal",
      nativeToScVal(proposer.publicKey(), { type: "address" }),
      nativeToScVal(target, { type: "address" }),
      nativeToScVal(fnName, { type: "symbol" }),
      nativeToScVal(calldata, { type: "bytes" }),
      nativeToScVal(requestedAmount, { type: "i128" }),
    );
    return Number(scValToNative(result.returnValue!));
  }

  async stake(staker: Keypair, proposalId: number, amount: bigint): Promise<string> {
    return (await this.submit(
      staker,
      "stake",
      nativeToScVal(staker.publicKey(), { type: "address" }),
      nativeToScVal(proposalId, { type: "u64" }),
      nativeToScVal(amount, { type: "i128" }),
    )).hash;
  }

  async withdrawStake(staker: Keypair): Promise<string> {
    return (await this.submit(
      staker,
      "withdraw_stake",
      nativeToScVal(staker.publicKey(), { type: "address" }),
    )).hash;
  }

  async checkpointConviction(
    caller: Keypair,
    proposalId: number,
  ): Promise<{ conviction: bigint; executed: boolean }> {
    const result = await this.submit(
      caller,
      "checkpoint_conviction",
      nativeToScVal(proposalId, { type: "u64" }),
    );
    const conviction = BigInt(scValToNative(result.returnValue!));
    const proposal = await this.getProposal(proposalId);
    return { conviction, executed: proposal.executed };
  }

  async getProposal(proposalId: number): Promise<ConvictionProposal> {
    const native = await this.simulate(
      "get_proposal",
      nativeToScVal(proposalId, { type: "u64" }),
    ) as Record<string, unknown>;
    return {
      id: BigInt(String(native.id)),
      proposer: String(native.proposer),
      target: String(native.target),
      fnName: String(native.fn_name),
      calldata: native.calldata as Buffer | Uint8Array,
      requestedAmount: BigInt(String(native.requested_amount)),
      createdLedger: Number(native.created_ledger),
      conviction: BigInt(String(native.conviction)),
      lastUpdatedLedger: Number(native.last_updated_ledger),
      executed: Boolean(native.executed),
      cancelled: Boolean(native.cancelled),
    };
  }

  async getRequiredThreshold(requestedAmount: bigint): Promise<bigint> {
    return BigInt(String(await this.simulate(
      "get_required_threshold",
      nativeToScVal(requestedAmount, { type: "i128" }),
    )));
  }

  async getConvictionHistory(proposalId: number): Promise<ConvictionSnapshot[]> {
    if (!this.config.indexerUrl) throw new Error("indexerUrl is required");
    const response = await fetch(
      `${this.config.indexerUrl}/conviction/proposals/${proposalId}/conviction-history`,
    );
    if (!response.ok) throw new Error(`Indexer request failed: ${response.status}`);
    const json = await response.json() as { data: Array<Record<string, unknown>> };
    return json.data.map((row) => ({
      proposalId: BigInt(String(row.proposal_id)),
      ledger: Number(row.ledger),
      conviction: BigInt(String(row.conviction)),
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

  private async simulate(fn: string, ...args: xdr.ScVal[]): Promise<unknown> {
    const source = this.config.simulationAccount ?? this.config.convictionVotingAddress!;
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
