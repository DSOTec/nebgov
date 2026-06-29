import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
} from "@stellar/stellar-sdk";
import { LiquidityConfig, Network, Pool } from "./types";
import { TreasuryError, TreasuryErrorCode } from "./errors";
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

function decodePool(raw: unknown): Pool {
  const p = raw as {
    reserve_a: bigint | number | string;
    reserve_b: bigint | number | string;
    total_lp_supply: bigint | number | string;
    fee_bps: number | bigint | string;
  };
  return {
    reserveA: BigInt(p.reserve_a),
    reserveB: BigInt(p.reserve_b),
    totalLpSupply: BigInt(p.total_lp_supply),
    feeBps: Number(p.fee_bps),
  };
}

/**
 * LiquidityClient — read/query a deployed NebGov liquidity pool contract.
 *
 * @example
 * const client = new LiquidityClient({
 *   liquidityAddress: "CABC...",
 *   network: "testnet",
 * });
 *
 * const pool = await client.getPoolSafe(0, 1);
 * if (!pool) {
 *   // show "Initialize Pool" CTA
 * }
 */
export class LiquidityClient {
  private readonly config: LiquidityConfig;
  private readonly server: SorobanRpc.Server;
  private readonly contract: Contract;
  private readonly networkPassphrase: string;

  constructor(config: LiquidityConfig) {
    this.config = config;
    const rpcUrl = config.rpcUrl ?? RPC_URLS[config.network];
    this.server = new SorobanRpc.Server(rpcUrl, { allowHttp: false });
    this.contract = new Contract(config.liquidityAddress);
    this.networkPassphrase = NETWORK_PASSPHRASES[config.network];
  }

  private readAccount(fallback?: string): string {
    const account = this.config.simulationAccount ?? fallback;
    if (!account) {
      throw new TreasuryError(
        TreasuryErrorCode.InvalidArguments,
        "LiquidityClient read methods require simulationAccount in LiquidityConfig",
      );
    }
    return account;
  }

  private async retry<T>(fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, {
      maxAttempts: this.config.maxAttempts ?? 3,
      baseDelayMs: this.config.baseDelayMs ?? 1000,
      retryOn: isNetworkError,
    });
  }

  /**
   * Fetch the current pool state. Throws if the pool has never been
   * initialized — prefer {@link getPoolSafe} when the pool's existence is
   * not guaranteed (e.g. before showing add-liquidity or swap UI).
   */
  async getPool(outcomeA: number, outcomeB: number): Promise<Pool> {
    const pool = await this.getPoolSafe(outcomeA, outcomeB);
    if (!pool) {
      throw new TreasuryError(
        TreasuryErrorCode.InvalidArguments,
        `Pool not found for outcomes (${outcomeA}, ${outcomeB})`,
      );
    }
    return pool;
  }

  /**
   * Fetch the current pool state without throwing if the pool does not
   * exist. Calls the on-chain `get_pool_safe` read function.
   *
   * @returns The pool state, or `null` if no pool has been created for this
   * outcome pair.
   */
  async getPoolSafe(outcomeA: number, outcomeB: number): Promise<Pool | null> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(this.readAccount()),
          { fee: BASE_FEE, networkPassphrase: this.networkPassphrase },
        )
          .addOperation(
            this.contract.call(
              "get_pool_safe",
              nativeToScVal(outcomeA, { type: "u32" }),
              nativeToScVal(outcomeB, { type: "u32" }),
            ),
          )
          .setTimeout(30)
          .build(),
      );

      if (SorobanRpc.Api.isSimulationError(result)) return null;
      const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result?.retval;
      if (!raw) return null;

      const decoded = scValToNative(raw);
      if (decoded === null || decoded === undefined) return null;
      return decodePool(decoded);
    });
  }
}
