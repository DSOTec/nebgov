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

export type TreasuryBudgetStream = {
  id: bigint;
  name: string;
  owner: string;
  token: string;
  totalAllocated: bigint;
  totalSpent: bigint;
  startLedger: number;
  endLedger: number;
  isActive: boolean;
  isRevoked: boolean;
  revokedAtLedger: number | null;
  maxSingleSpend: bigint;
  cooldownLedgers: number;
  lastSpendLedger: number;
  spendCount: number;
  createdByProposalId: bigint;
};

export type TreasuryStreamSpend = {
  streamId: bigint;
  spendIndex: number;
  recipient: string;
  amount: bigint;
  memo: string;
  executedAtLedger: number;
  executedBy: string;
};

export type TreasuryStreamReport = {
  streamId: bigint;
  name: string;
  totalAllocated: bigint;
  totalSpent: bigint;
  remaining: bigint;
  utilizationBps: number;
  isActive: boolean;
  daysRemaining: number;
  spendCount: number;
  avgSpend: bigint;
};

export type TreasuryBudgetSummary = {
  totalStreams: number;
  activeStreams: number;
  totalAllocatedByToken: Array<{ token: string; amount: bigint }>;
  totalSpentByToken: Array<{ token: string; amount: bigint }>;
  totalRemainingByToken: Array<{ token: string; amount: bigint }>;
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

  // ── Budget Stream query methods ───────────────────────────────────────────

  async getStream(viewer: string, streamId: number): Promise<TreasuryBudgetStream | null> {
    const rv = await this.simulate(
      viewer,
      this.contract.call("get_stream", nativeToScVal(streamId, { type: "u64" })),
    );
    if (!rv) return null;
    return this.parseStream(scValToNative(rv) as Record<string, unknown>);
  }

  async getStreams(viewer: string, offset = 0, limit = 20): Promise<TreasuryBudgetStream[]> {
    const rv = await this.simulate(
      viewer,
      this.contract.call(
        "get_streams",
        nativeToScVal(offset, { type: "u64" }),
        nativeToScVal(limit, { type: "u64" }),
      ),
    );
    if (!rv) return [];
    const arr = scValToNative(rv) as unknown[];
    return arr.map((s) => this.parseStream(s as Record<string, unknown>));
  }

  async getStreamsByOwner(viewer: string, owner: string, offset = 0, limit = 20): Promise<TreasuryBudgetStream[]> {
    const rv = await this.simulate(
      viewer,
      this.contract.call(
        "get_streams_by_owner",
        nativeToScVal(owner, { type: "address" }),
        nativeToScVal(offset, { type: "u64" }),
        nativeToScVal(limit, { type: "u64" }),
      ),
    );
    if (!rv) return [];
    const arr = scValToNative(rv) as unknown[];
    return arr.map((s) => this.parseStream(s as Record<string, unknown>));
  }

  async getStreamSpends(viewer: string, streamId: number, offset = 0, limit = 50): Promise<TreasuryStreamSpend[]> {
    const rv = await this.simulate(
      viewer,
      this.contract.call(
        "get_stream_spends",
        nativeToScVal(streamId, { type: "u64" }),
        nativeToScVal(offset, { type: "u32" }),
        nativeToScVal(limit, { type: "u32" }),
      ),
    );
    if (!rv) return [];
    const arr = scValToNative(rv) as Record<string, unknown>[];
    return arr.map((s) => ({
      streamId: BigInt(s.stream_id as number | bigint | string),
      spendIndex: Number(s.spend_index),
      recipient: String(s.recipient),
      amount: BigInt(s.amount as number | bigint | string),
      memo: String(s.memo),
      executedAtLedger: Number(s.executed_at_ledger),
      executedBy: String(s.executed_by),
    }));
  }

  async getStreamReport(viewer: string, streamId: number): Promise<TreasuryStreamReport | null> {
    const rv = await this.simulate(
      viewer,
      this.contract.call("get_stream_report", nativeToScVal(streamId, { type: "u64" })),
    );
    if (!rv) return null;
    const r = scValToNative(rv) as Record<string, unknown>;
    return {
      streamId: BigInt(r.stream_id as number | bigint | string),
      name: String(r.name),
      totalAllocated: BigInt(r.total_allocated as number | bigint | string),
      totalSpent: BigInt(r.total_spent as number | bigint | string),
      remaining: BigInt(r.remaining as number | bigint | string),
      utilizationBps: Number(r.utilization_bps),
      isActive: Boolean(r.is_active),
      daysRemaining: Number(r.days_remaining),
      spendCount: Number(r.spend_count),
      avgSpend: BigInt(r.avg_spend as number | bigint | string),
    };
  }

  async getBudgetSummary(viewer: string): Promise<TreasuryBudgetSummary | null> {
    const rv = await this.simulate(viewer, this.contract.call("get_budget_summary"));
    if (!rv) return null;
    const s = scValToNative(rv) as Record<string, unknown>;
    const parseArr = (arr: unknown): Array<{ token: string; amount: bigint }> => {
      if (!Array.isArray(arr)) return [];
      return arr.map((pair) => {
        const p = pair as [string, number | bigint | string];
        return { token: String(p[0]), amount: BigInt(p[1]) };
      });
    };
    return {
      totalStreams: Number(s.total_streams),
      activeStreams: Number(s.active_streams),
      totalAllocatedByToken: parseArr(s.total_allocated_by_token),
      totalSpentByToken: parseArr(s.total_spent_by_token),
      totalRemainingByToken: parseArr(s.total_remaining_by_token),
    };
  }

  async getStreamRemaining(viewer: string, streamId: number): Promise<bigint> {
    const rv = await this.simulate(
      viewer,
      this.contract.call("get_stream_remaining", nativeToScVal(streamId, { type: "u64" })),
    );
    if (!rv) return 0n;
    return BigInt(scValToNative(rv) as number | bigint | string);
  }

  // ── Budget Stream write methods ───────────────────────────────────────────

  async createStream(
    signerPublicKey: string,
    name: string,
    owner: string,
    token: string,
    totalAllocated: bigint,
    startLedger: number,
    endLedger: number,
    maxSingleSpend: bigint,
    cooldownLedgers: number,
    proposalId: bigint,
    signUnsignedXdr: (xdr: string) => Promise<string>,
  ): Promise<bigint> {
    const account = await this.server.getAccount(signerPublicKey);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "create_stream",
          nativeToScVal(signerPublicKey, { type: "address" }),
          nativeToScVal(name, { type: "symbol" }),
          nativeToScVal(owner, { type: "address" }),
          nativeToScVal(token, { type: "address" }),
          nativeToScVal(totalAllocated, { type: "i128" }),
          nativeToScVal(startLedger, { type: "u32" }),
          nativeToScVal(endLedger, { type: "u32" }),
          nativeToScVal(maxSingleSpend, { type: "i128" }),
          nativeToScVal(cooldownLedgers, { type: "u32" }),
          nativeToScVal(proposalId, { type: "u64" }),
        ),
      )
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    const signedXdr = await signUnsignedXdr(prepared.toXDR());
    const signed = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);
    const result = await this.server.sendTransaction(signed);
    if (result.status === "ERROR") {
      throw new Error(`create_stream failed: ${JSON.stringify(result)}`);
    }
    const confirmed = await this.pollSuccess(result.hash);
    const rv = confirmed.returnValue;
    if (!rv) return 0n;
    return BigInt(scValToNative(rv) as number | bigint);
  }

  async streamSpend(
    signerPublicKey: string,
    streamId: number,
    recipient: string,
    amount: bigint,
    memo: string,
    signUnsignedXdr: (xdr: string) => Promise<string>,
  ): Promise<void> {
    const account = await this.server.getAccount(signerPublicKey);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "stream_spend",
          nativeToScVal(signerPublicKey, { type: "address" }),
          nativeToScVal(streamId, { type: "u64" }),
          nativeToScVal(recipient, { type: "address" }),
          nativeToScVal(amount, { type: "i128" }),
          nativeToScVal(memo, { type: "string" }),
        ),
      )
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    const signedXdr = await signUnsignedXdr(prepared.toXDR());
    const signed = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);
    const result = await this.server.sendTransaction(signed);
    if (result.status === "ERROR") {
      throw new Error(`stream_spend failed: ${JSON.stringify(result)}`);
    }
    await this.pollSuccess(result.hash);
  }

  async revokeStream(
    signerPublicKey: string,
    streamId: number,
    signUnsignedXdr: (xdr: string) => Promise<string>,
  ): Promise<void> {
    const account = await this.server.getAccount(signerPublicKey);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "revoke_stream",
          nativeToScVal(signerPublicKey, { type: "address" }),
          nativeToScVal(streamId, { type: "u64" }),
        ),
      )
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    const signedXdr = await signUnsignedXdr(prepared.toXDR());
    const signed = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);
    const result = await this.server.sendTransaction(signed);
    if (result.status === "ERROR") {
      throw new Error(`revoke_stream failed: ${JSON.stringify(result)}`);
    }
    await this.pollSuccess(result.hash);
  }

  async extendStream(
    signerPublicKey: string,
    streamId: number,
    newEndLedger: number,
    signUnsignedXdr: (xdr: string) => Promise<string>,
  ): Promise<void> {
    const account = await this.server.getAccount(signerPublicKey);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "extend_stream",
          nativeToScVal(signerPublicKey, { type: "address" }),
          nativeToScVal(streamId, { type: "u64" }),
          nativeToScVal(newEndLedger, { type: "u32" }),
        ),
      )
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    const signedXdr = await signUnsignedXdr(prepared.toXDR());
    const signed = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);
    const result = await this.server.sendTransaction(signed);
    if (result.status === "ERROR") {
      throw new Error(`extend_stream failed: ${JSON.stringify(result)}`);
    }
    await this.pollSuccess(result.hash);
  }

  async topUpStream(
    signerPublicKey: string,
    streamId: number,
    additionalAmount: bigint,
    signUnsignedXdr: (xdr: string) => Promise<string>,
  ): Promise<void> {
    const account = await this.server.getAccount(signerPublicKey);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "top_up_stream",
          nativeToScVal(signerPublicKey, { type: "address" }),
          nativeToScVal(streamId, { type: "u64" }),
          nativeToScVal(additionalAmount, { type: "i128" }),
        ),
      )
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    const signedXdr = await signUnsignedXdr(prepared.toXDR());
    const signed = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);
    const result = await this.server.sendTransaction(signed);
    if (result.status === "ERROR") {
      throw new Error(`top_up_stream failed: ${JSON.stringify(result)}`);
    }
    await this.pollSuccess(result.hash);
  }

  // ── Stream parsing helper ─────────────────────────────────────────────────

  private parseStream(s: Record<string, unknown>): TreasuryBudgetStream {
    return {
      id: BigInt(s.id as number | bigint | string),
      name: String(s.name),
      owner: String(s.owner),
      token: String(s.token),
      totalAllocated: BigInt(s.total_allocated as number | bigint | string),
      totalSpent: BigInt(s.total_spent as number | bigint | string),
      startLedger: Number(s.start_ledger),
      endLedger: Number(s.end_ledger),
      isActive: Boolean(s.is_active),
      isRevoked: Boolean(s.is_revoked),
      revokedAtLedger: s.revoked_at_ledger != null ? Number(s.revoked_at_ledger) : null,
      maxSingleSpend: BigInt(s.max_single_spend as number | bigint | string),
      cooldownLedgers: Number(s.cooldown_ledgers),
      lastSpendLedger: Number(s.last_spend_ledger),
      spendCount: Number(s.spend_count),
      createdByProposalId: BigInt(s.created_by_proposal_id as number | bigint | string),
    };
  }
}
