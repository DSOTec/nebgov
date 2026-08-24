import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  Keypair,
  nativeToScVal,
  scValToNative,
} from "@stellar/stellar-sdk";
import { GovernorConfig } from "./types";
import { withRetry } from "./utils";
import { parseVoteEscrowError } from "./errors";

const RPC_URLS: Record<string, string> = {
  futurenet: "https://soroban-futurenet.stellar.org",
  testnet: "https://soroban-testnet.stellar.org",
  public: "https://soroban-mainnet.stellar.org",
};

const NETWORK_PASSPHRASES: Record<string, string> = {
  futurenet: "Test SDF Future Network ; October 2022",
  testnet: "Test SDF Network ; September 2015",
  public: "Public Global Stellar Network ; September 2015",
};

export interface Lock {
  owner: string;
  amount: bigint;
  start_ledger: number;
  end_ledger: number;
  initial_voting_power: bigint;
  withdrawn: boolean;
}

export interface VoteEscrowStats {
  total_locked: bigint;
  avg_lock_duration: number;
  num_active_locks: number;
}

export class VoteEscrowClient {
  private readonly server: SorobanRpc.Server;
  private readonly contract: Contract;
  private readonly networkPassphrase: string;
  private readonly config: GovernorConfig;

  constructor(config: GovernorConfig) {
    this.config = config;
    const rpcUrl = config.rpcUrl ?? RPC_URLS[config.network];
    this.server = new SorobanRpc.Server(rpcUrl, { allowHttp: false });
    this.contract = new Contract(config.voteEscrowAddress || "");
    this.networkPassphrase = NETWORK_PASSPHRASES[config.network];
  }

  private async retry<T>(
    fn: () => Promise<T>,
    retryOn?: (e: unknown) => boolean
  ): Promise<T> {
    return withRetry(fn, {
      maxAttempts: 5,
      baseDelayMs: 1000,
      retryOn,
    });
  }

  private readAccount(fallback?: string): string {
    return this.config.simulationAccount ?? fallback ?? this.contract.contractId();
  }

  async createLock(
    signer: Keypair,
    amount: bigint,
    durationLedgers: number
  ): Promise<string> {
    return this.retry(async () => {
      const account = await this.server.getAccount(signer.publicKey());
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            "create_lock",
            nativeToScVal(signer.publicKey(), { type: "address" }),
            nativeToScVal(amount, { type: "i128" }),
            nativeToScVal(durationLedgers, { type: "u32" })
          )
        )
        .setTimeout(30)
        .build();
      const prepared = await this.server.prepareTransaction(tx);
      prepared.sign(signer);
      const result = await this.server.sendTransaction(prepared);
      if (result.status === "ERROR") throw parseVoteEscrowError(result);
      return result.hash;
    });
  }

  async createLockWithSign(
    signerPublicKey: string,
    amount: bigint,
    durationLedgers: number,
    signUnsignedXdr: (xdr: string) => Promise<string>
  ): Promise<string> {
    return this.retry(async () => {
      const account = await this.server.getAccount(signerPublicKey);
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            "create_lock",
            nativeToScVal(signerPublicKey, { type: "address" }),
            nativeToScVal(amount, { type: "i128" }),
            nativeToScVal(durationLedgers, { type: "u32" })
          )
        )
        .setTimeout(30)
        .build();
      const prepared = await this.server.prepareTransaction(tx);
      const signedXdr = await signUnsignedXdr(prepared.toXDR());
      const signedTx = TransactionBuilder.fromXDR(
        signedXdr,
        this.networkPassphrase
      );
      const result = await this.server.sendTransaction(signedTx);
      if (result.status === "ERROR") throw parseVoteEscrowError(result);
      return result.hash;
    });
  }

  async increaseLockAmount(
    signer: Keypair,
    additionalAmount: bigint
  ): Promise<string> {
    return this.retry(async () => {
      const account = await this.server.getAccount(signer.publicKey());
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            "increase_lock_amount",
            nativeToScVal(signer.publicKey(), { type: "address" }),
            nativeToScVal(additionalAmount, { type: "i128" })
          )
        )
        .setTimeout(30)
        .build();
      const prepared = await this.server.prepareTransaction(tx);
      prepared.sign(signer);
      const result = await this.server.sendTransaction(prepared);
      if (result.status === "ERROR") throw parseVoteEscrowError(result);
      return result.hash;
    });
  }

  async extendLock(signer: Keypair, newEndLedger: number): Promise<string> {
    return this.retry(async () => {
      const account = await this.server.getAccount(signer.publicKey());
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            "extend_lock",
            nativeToScVal(signer.publicKey(), { type: "address" }),
            nativeToScVal(newEndLedger, { type: "u32" })
          )
        )
        .setTimeout(30)
        .build();
      const prepared = await this.server.prepareTransaction(tx);
      prepared.sign(signer);
      const result = await this.server.sendTransaction(prepared);
      if (result.status === "ERROR") throw parseVoteEscrowError(result);
      return result.hash;
    });
  }

  async withdraw(signer: Keypair): Promise<string> {
    return this.retry(async () => {
      const account = await this.server.getAccount(signer.publicKey());
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            "withdraw",
            nativeToScVal(signer.publicKey(), { type: "address" })
          )
        )
        .setTimeout(30)
        .build();
      const prepared = await this.server.prepareTransaction(tx);
      prepared.sign(signer);
      const result = await this.server.sendTransaction(prepared);
      if (result.status === "ERROR") throw parseVoteEscrowError(result);
      return result.hash;
    });
  }

  async getLock(owner: string): Promise<Lock | null> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(this.readAccount(owner)),
          {
            fee: BASE_FEE,
            networkPassphrase: this.networkPassphrase,
          }
        )
          .addOperation(
            this.contract.call(
              "get_lock",
              nativeToScVal(owner, { type: "address" })
            )
          )
          .setTimeout(30)
          .build()
      );
      if (SorobanRpc.Api.isSimulationError(result)) return null;
      const raw = (
        result as SorobanRpc.Api.SimulateTransactionSuccessResponse
      ).result?.retval;
      if (!raw) return null;
      const native = scValToNative(raw) as Record<string, any>;
      if (!native) return null;
      return {
        owner: native.owner,
        amount: BigInt(native.amount),
        start_ledger: Number(native.start_ledger),
        end_ledger: Number(native.end_ledger),
        initial_voting_power: BigInt(native.initial_voting_power),
        withdrawn: Boolean(native.withdrawn),
      };
    });
  }

  async getVotingPower(owner: string): Promise<bigint> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(this.readAccount(owner)),
          {
            fee: BASE_FEE,
            networkPassphrase: this.networkPassphrase,
          }
        )
          .addOperation(
            this.contract.call(
              "get_votes",
              nativeToScVal(owner, { type: "address" })
            )
          )
          .setTimeout(30)
          .build()
      );
      if (SorobanRpc.Api.isSimulationError(result)) return 0n;
      const raw = (
        result as SorobanRpc.Api.SimulateTransactionSuccessResponse
      ).result?.retval;
      return raw ? BigInt(scValToNative(raw)) : 0n;
    });
  }

  async getEscrowStats(): Promise<VoteEscrowStats> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(this.readAccount()),
          {
            fee: BASE_FEE,
            networkPassphrase: this.networkPassphrase,
          }
        )
          .addOperation(this.contract.call("get_past_total_supply"))
          .setTimeout(30)
          .build()
      );
      if (SorobanRpc.Api.isSimulationError(result)) {
        return {
          total_locked: 0n,
          avg_lock_duration: 0,
          num_active_locks: 0,
        };
      }
      return {
        total_locked: 0n,
        avg_lock_duration: 0,
        num_active_locks: 0,
      };
    });
  }
}
