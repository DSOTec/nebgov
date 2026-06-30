import {
  BASE_FEE,
  Contract,
  Networks,
  SorobanRpc,
  nativeToScVal,
  scValToNative,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
type StellarNetwork = "mainnet" | "testnet" | "futurenet";

const RPC_URLS: Record<StellarNetwork, string> = {
  mainnet: "https://soroban-rpc.mainnet.stellar.gateway.fm",
  testnet: "https://soroban-testnet.stellar.org",
  futurenet: "https://rpc-futurenet.stellar.org",
};

const NETWORK_PASSPHRASES: Record<StellarNetwork, string> = {
  mainnet: Networks.PUBLIC,
  testnet: Networks.TESTNET,
  futurenet: Networks.FUTURENET,
};

export type TreasuryTx = {
  id: bigint;
  proposer: string;
  target: string;
  fnName: string;
  approvals: number;
  executed: boolean;
  cancelled: boolean;
  dataHex: string;
};

export type TreasurySpendingCap = {
  token: string;
  maxAmount: bigint;
  periodLedgers: number;
};

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export class TreasuryClient {
  private readonly server: SorobanRpc.Server;
  private readonly contract: Contract;
  readonly networkPassphrase: string;

  constructor(opts: {
    network: StellarNetwork;
    treasuryAddress: string;
    rpcUrl?: string;
  }) {
    const rpc = opts.rpcUrl ?? RPC_URLS[opts.network];
    this.server = new SorobanRpc.Server(rpc, { allowHttp: false });
    this.contract = new Contract(opts.treasuryAddress);
    this.networkPassphrase = NETWORK_PASSPHRASES[opts.network];
  }

  private async simulate(
    sourceAccountId: string,
    op: xdr.Operation
  ): Promise<xdr.ScVal | null> {
    const result = await this.server.simulateTransaction(
      new TransactionBuilder(await this.server.getAccount(sourceAccountId), {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(op)
        .setTimeout(30)
        .build()
    );

    if (SorobanRpc.Api.isSimulationError(result)) return null;
    const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
      .result?.retval;
    return raw ?? null;
  }

  private async pollSuccess(
    hash: string,
    retries = 12,
    delayMs = 2000
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
    throw new Error("Transaction not confirmed in time.");
  }

  /** `null` when the contract has no `tx_count` entrypoint (older WASM). */
  async txCount(viewer: string): Promise<number | null> {
    const rv = await this.simulate(viewer, this.contract.call("tx_count"));
    if (!rv) return null;
    const n = scValToNative(rv);
    return Number(n);
  }

  async threshold(viewer: string): Promise<number> {
    const rv = await this.simulate(viewer, this.contract.call("threshold"));
    if (!rv) return 1;
    return Number(scValToNative(rv));
  }

  async getThreshold(viewer: string): Promise<number> {
    return this.threshold(viewer);
  }

  /** Returns `null` when owners entrypoint cannot be simulated. */
  async getOwners(viewer: string): Promise<string[] | null> {
    const rv = await this.simulate(viewer, this.contract.call("owners"));
    if (!rv) return null;
    const owners = scValToNative(rv) as unknown[];
    return owners.map((owner) => String(owner));
  }

  async getTx(viewer: string, id: number): Promise<TreasuryTx | null> {
    const rv = await this.simulate(
      viewer,
      this.contract.call("get_tx", nativeToScVal(id, { type: "u64" }))
    );
    if (!rv) return null;

    const tx = scValToNative(rv) as unknown as {
      id: bigint;
      proposer: string;
      target: string;
      fn_name: string;
      data: Uint8Array;
      approvals: number;
      executed: boolean;
      cancelled: boolean;
    };

    return {
      id: BigInt(tx.id),
      proposer: tx.proposer,
      target: tx.target,
      fnName: String(tx.fn_name ?? ""),
      approvals: Number(tx.approvals),
      executed: !!tx.executed,
      cancelled: !!tx.cancelled,
      dataHex: bytesToHex(tx.data),
    };
  }

  async hasApproved(
    viewer: string,
    txId: number,
    approver: string
  ): Promise<boolean> {
    const rv = await this.simulate(
      viewer,
      this.contract.call(
        "has_approved",
        nativeToScVal(txId, { type: "u64" }),
        nativeToScVal(approver, { type: "address" })
      )
    );
    if (!rv) return false;
    return Boolean(scValToNative(rv));
  }

  /** `null` if the deployed WASM does not expose `is_treasury_owner` (older builds). */
  async isTreasuryOwner(
    viewer: string,
    candidate: string
  ): Promise<boolean | null> {
    const rv = await this.simulate(
      viewer,
      this.contract.call(
        "is_treasury_owner",
        nativeToScVal(candidate, { type: "address" })
      )
    );
    if (!rv) return null;
    return Boolean(scValToNative(rv));
  }

  async isOwner(viewer: string, candidate: string): Promise<boolean | null> {
    return this.isTreasuryOwner(viewer, candidate);
  }

  async getSpendingCap(
    viewer: string,
    token: string,
  ): Promise<TreasurySpendingCap | null> {
    const rv = await this.simulate(
      viewer,
      this.contract.call(
        "get_spending_cap",
        nativeToScVal(token, { type: "address" }),
      ),
    );
    if (!rv) return null;

    const cap = scValToNative(rv) as
      | {
          token: string;
          max_amount: bigint | number | string;
          period_ledgers: bigint | number | string;
        }
      | null;

    if (!cap) return null;

    return {
      token: cap.token,
      maxAmount: BigInt(cap.max_amount),
      periodLedgers: Number(cap.period_ledgers),
    };
  }

  async getSpentThisPeriod(viewer: string, token: string): Promise<bigint> {
    const rv = await this.simulate(
      viewer,
      this.contract.call(
        "get_spent_this_period",
        nativeToScVal(token, { type: "address" }),
      ),
    );
    if (!rv) return 0n;
    return BigInt(scValToNative(rv) as number | bigint | string);
  }

  async submit(
    signerPublicKey: string,
    target: string,
    fnName: string,
    data: Uint8Array,
    signUnsignedXdr: (xdr: string) => Promise<string>
  ): Promise<bigint> {
    const account = await this.server.getAccount(signerPublicKey);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "submit",
          nativeToScVal(signerPublicKey, { type: "address" }),
          nativeToScVal(target, { type: "address" }),
          nativeToScVal(fnName, { type: "symbol" }),
          nativeToScVal(data, { type: "bytes" })
        )
      )
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    const signedXdr = await signUnsignedXdr(prepared.toXDR());
    const signed = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);
    const result = await this.server.sendTransaction(signed);
    if (result.status === "ERROR") {
      throw new Error(`submit failed: ${JSON.stringify(result)}`);
    }
    const confirmed = await this.pollSuccess(result.hash);
    const rv = confirmed.returnValue;
    if (!rv) return 0n;
    return BigInt(scValToNative(rv) as number | bigint);
  }

  async approve(
    signerPublicKey: string,
    txId: number,
    signUnsignedXdr: (xdr: string) => Promise<string>
  ): Promise<void> {
    const account = await this.server.getAccount(signerPublicKey);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "approve",
          nativeToScVal(signerPublicKey, { type: "address" }),
          nativeToScVal(txId, { type: "u64" })
        )
      )
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    const signedXdr = await signUnsignedXdr(prepared.toXDR());
    const signed = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);
    const result = await this.server.sendTransaction(signed);
    if (result.status === "ERROR") {
      throw new Error(`approve failed: ${JSON.stringify(result)}`);
    }
    await this.pollSuccess(result.hash);
  }
}
