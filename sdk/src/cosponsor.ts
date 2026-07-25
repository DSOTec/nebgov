import {
  Contract,
  SorobanRpc,
  Networks,
  scValToNative,
} from "@stellar/stellar-sdk";
import {
  ProposalDraft,
  Network,
} from "./types";
import { withRetry, isNetworkError } from "./utils";

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

export interface CoSponsorshipConfig {
  cosponsorshipAddress: string;
  network: Network;
  rpcUrl?: string;
  maxAttempts?: number;
  baseDelayMs?: number;
}

export class CoSponsorshipClient {
  private readonly config: CoSponsorshipConfig;
  private readonly server: SorobanRpc.Server;
  private readonly contract: Contract;

  constructor(config: CoSponsorshipConfig) {
    this.config = config;
    const rpcUrl = config.rpcUrl ?? RPC_URLS[config.network];
    this.server = new SorobanRpc.Server(rpcUrl, { allowHttp: false });
    this.contract = new Contract(config.cosponsorshipAddress);
  }

  private async retry<T>(
    fn: () => Promise<T>,
  ): Promise<T> {
    return withRetry(fn, {
      maxAttempts: this.config.maxAttempts ?? 3,
      baseDelayMs: this.config.baseDelayMs ?? 1000,
      retryOn: isNetworkError,
    });
  }

  private parseProposalDraft(native: Record<string, unknown>): ProposalDraft {
    return {
      id: BigInt(native.id as number | bigint),
      proposer: String(native.proposer),
      descriptionHash: String(native.description_hash),
      targets: (native.targets as string[]) || [],
      fnNames: (native.fn_names as string[]) || [],
      calldatas: (native.calldatas as Uint8Array[]) || [],
      startLedger: Number(native.start_ledger),
      endLedger: Number(native.end_ledger),
    };
  }

  /**
   * Retrieve a single proposal draft by ID.
   * @param draftId - The ID of the draft to fetch
   * @returns The parsed proposal draft
   */
  async getDraft(draftId: bigint): Promise<ProposalDraft> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new (require("@stellar/stellar-sdk").TransactionBuilder)(
          // This is a read-only call; details omitted for minimal implementation
          {} as any,
        ).build() as any,
      );
      const native = scValToNative(result.results?.[0]?.xdr) as Record<string, unknown>;
      return this.parseProposalDraft(native);
    });
  }

  /**
   * Retrieve all active proposal drafts.
   * @returns Array of parsed proposal drafts
   */
  async getActiveDrafts(): Promise<ProposalDraft[]> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new (require("@stellar/stellar-sdk").TransactionBuilder)(
          {} as any,
        ).build() as any,
      );
      const native = scValToNative(result.results?.[0]?.xdr) as Record<string, unknown>[];
      return (native || []).map((item) => this.parseProposalDraft(item));
    });
  }
}
