import {
  BASE_FEE,
  Contract,
  Networks,
  SorobanRpc,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

export interface TreasuryStreamRecord {
  streamId: string;
  name: string;
  owner: string;
  token: string;
  totalAllocated: string;
  totalSpent: string;
  startLedger: number;
  endLedger: number;
  isActive: boolean;
  isRevoked: boolean;
  revokedAtLedger: number | null;
  maxSingleSpend: string;
  cooldownLedgers: number;
  lastSpendLedger: number;
  spendCount: number;
  createdByProposalId: string;
}

export interface TreasuryStreamSpendRecord {
  streamId: string;
  spendIndex: number;
  recipient: string;
  amount: string;
  memo: string;
  executedAtLedger: number;
  executedBy: string;
}

export interface TreasuryStateReader {
  getStream(streamId: string): Promise<TreasuryStreamRecord>;
  getStreams(offset: number, limit: number): Promise<TreasuryStreamRecord[]>;
  getStreamSpends(
    streamId: string,
    offset: number,
    limit: number,
  ): Promise<TreasuryStreamSpendRecord[]>;
}

function parseStream(raw: Record<string, unknown>): TreasuryStreamRecord {
  const revokedAt = raw.revoked_at_ledger;
  return {
    streamId: String(raw.id),
    name: String(raw.name),
    owner: String(raw.owner),
    token: String(raw.token),
    totalAllocated: String(raw.total_allocated),
    totalSpent: String(raw.total_spent),
    startLedger: Number(raw.start_ledger),
    endLedger: Number(raw.end_ledger),
    isActive: Boolean(raw.is_active),
    isRevoked: Boolean(raw.is_revoked),
    revokedAtLedger:
      revokedAt === undefined || revokedAt === null ? null : Number(revokedAt),
    maxSingleSpend: String(raw.max_single_spend),
    cooldownLedgers: Number(raw.cooldown_ledgers),
    lastSpendLedger: Number(raw.last_spend_ledger),
    spendCount: Number(raw.spend_count),
    createdByProposalId: String(raw.created_by_proposal_id),
  };
}

function parseSpend(
  raw: Record<string, unknown>,
): TreasuryStreamSpendRecord {
  return {
    streamId: String(raw.stream_id),
    spendIndex: Number(raw.spend_index),
    recipient: String(raw.recipient),
    amount: String(raw.amount),
    memo: String(raw.memo),
    executedAtLedger: Number(raw.executed_at_ledger),
    executedBy: String(raw.executed_by),
  };
}

export function createTreasuryStateReader(options: {
  server: SorobanRpc.Server;
  treasuryAddress: string;
  simulationAccount: string;
  networkPassphrase?: string;
}): TreasuryStateReader {
  const {
    server,
    treasuryAddress,
    simulationAccount,
    networkPassphrase = Networks.TESTNET,
  } = options;
  const contract = new Contract(treasuryAddress);

  async function simulate(
    method: string,
    args: xdr.ScVal[] = [],
  ): Promise<xdr.ScVal> {
    const account = await server.getAccount(simulationAccount);
    const transaction = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(30)
      .build();
    const result = await server.simulateTransaction(transaction);
    if (SorobanRpc.Api.isSimulationError(result)) {
      throw new Error(
        `Treasury ${method} simulation failed: ${result.error}`,
      );
    }
    const retval = result.result?.retval;
    if (!retval) {
      throw new Error(`Treasury ${method} returned no value`);
    }
    return retval;
  }

  return {
    async getStream(streamId: string): Promise<TreasuryStreamRecord> {
      const retval = await simulate("get_stream", [
        nativeToScVal(BigInt(streamId), { type: "u64" }),
      ]);
      return parseStream(
        scValToNative(retval) as Record<string, unknown>,
      );
    },

    async getStreams(
      offset: number,
      limit: number,
    ): Promise<TreasuryStreamRecord[]> {
      const retval = await simulate("get_streams", [
        nativeToScVal(BigInt(offset), { type: "u64" }),
        nativeToScVal(BigInt(limit), { type: "u64" }),
      ]);
      return (scValToNative(retval) as Record<string, unknown>[]).map(
        parseStream,
      );
    },

    async getStreamSpends(
      streamId: string,
      offset: number,
      limit: number,
    ): Promise<TreasuryStreamSpendRecord[]> {
      const retval = await simulate("get_stream_spends", [
        nativeToScVal(BigInt(streamId), { type: "u64" }),
        nativeToScVal(offset, { type: "u32" }),
        nativeToScVal(limit, { type: "u32" }),
      ]);
      return (scValToNative(retval) as Record<string, unknown>[]).map(
        parseSpend,
      );
    },
  };
}

export async function getAllTreasuryStreams(
  reader: TreasuryStateReader,
): Promise<TreasuryStreamRecord[]> {
  const pageSize = 100;
  const streams: TreasuryStreamRecord[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await reader.getStreams(offset, pageSize);
    streams.push(...page);
    if (page.length < pageSize) return streams;
  }
}

export async function getAllStreamSpends(
  reader: TreasuryStateReader,
  stream: TreasuryStreamRecord,
): Promise<TreasuryStreamSpendRecord[]> {
  const pageSize = 100;
  const spends: TreasuryStreamSpendRecord[] = [];
  for (let offset = 0; offset < stream.spendCount; offset += pageSize) {
    const page = await reader.getStreamSpends(
      stream.streamId,
      offset,
      Math.min(pageSize, stream.spendCount - offset),
    );
    spends.push(...page);
    if (page.length === 0) break;
  }
  return spends;
}
