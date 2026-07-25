import { createHash } from "node:crypto";
import { Address, BASE_FEE, Keypair, nativeToScVal, TransactionBuilder } from "@stellar/stellar-sdk";
import { GovernorClient, GovernorConfig, Network, TimelockClient, VoteType, VotesClient } from "@nebgov/sdk";
import { LedgerClock } from "./ledger";
import { Actor, ActorSet } from "./actors";
import { GovernorSettingsState, MockLedgerStore } from "./mock/store";
import { MockSorobanServer } from "./mock/server";
import { setActiveMockServer } from "./mock/registry";
import { applyDelegation, seedBalances } from "./mock/token-votes-executor";
import { BaseScenario, SimulationResult } from "./scenarios/base";

export interface GovernorSimulationSettings {
  votingDelay: number;
  votingPeriod: number;
  quorumNumerator: number;
  proposalThreshold: bigint;
  /** Timelock minimum delay, in seconds. */
  timelockDelay: bigint;
  /** Timelock execution window, in seconds. Defaults to 14 days. */
  executionWindow?: bigint;
  voteType: VoteType;
  /** Address authorized to veto proposals. Defaults to a deterministic synthetic guardian. */
  guardian?: string;
  /** Ledgers a Succeeded-but-unqueued proposal has before it expires. Defaults to 120_960 (~7 days). */
  proposalGracePeriod?: number;
  /** Minimum ledgers between proposals from the same proposer. Defaults to 100. */
  proposalCooldown?: number;
  /** Maximum proposals per proposer per period. Defaults to 5. */
  maxProposalsPerPeriod?: number;
  /** Period length in ledgers for the max-proposals-per-period cap. Defaults to 10_000. */
  proposalPeriodDuration?: number;
}

export interface SimulationConfig {
  /** Whether to run against the built-in mock Soroban runtime or a live/testnet RPC. */
  mode: "mock" | "testnet";
  settings: GovernorSimulationSettings;
  /** Initial token holders: address -> raw token amount. */
  tokenBalances: Record<string, bigint>;
  /** Delegation map: delegator -> delegatee (self-delegation activates voting power). */
  delegations: Record<string, string>;
  /** Starting ledger sequence number. Defaults to 1000. */
  initialLedger?: number;
  /** Required when mode === "testnet". */
  rpcUrl?: string;
  network?: Network;
}

export interface DeployedContracts {
  governor: string;
  timelock: string;
  votes: string;
}

interface ClockSnapshot {
  current: number;
  genesisTimestamp: number;
}

export interface ContractStateSnapshot {
  store: MockLedgerStore;
  clock: ClockSnapshot;
}

const DEFAULT_EXECUTION_WINDOW = 1_209_600n; // 14 days, matches contracts/timelock's own default.
const DEFAULT_GRACE_PERIOD = 120_960; // ~7 days at 5s/ledger.
const DEFAULT_COOLDOWN = 100;
const DEFAULT_MAX_PER_PERIOD = 5;
const DEFAULT_PERIOD_DURATION = 10_000;
const DEFAULT_GUARDIAN = Keypair.fromRawEd25519Seed(
  createHash("sha256").update("nebgov-simulation-actor:default-guardian").digest(),
).publicKey();
// Read-only simulation calls (getSettings, getProposalState, ...) build a
// throwaway transaction and need a valid classic ("G...") source account —
// contract addresses aren't valid transaction sources. `@nebgov/sdk`
// defaults to the governor's own (contract) address unless a
// `simulationAccount` is configured, so the harness always supplies one.
const SIMULATION_ACCOUNT = Keypair.fromRawEd25519Seed(
  createHash("sha256").update("nebgov-simulation-actor:simulation-account").digest(),
).publicKey();

function contractAddress(marker: number): string {
  return Address.contract(Buffer.alloc(32, marker)).toString();
}

export class SimulationHarness {
  readonly clock: LedgerClock;
  readonly actors = new Map<string, Actor>();
  readonly config: SimulationConfig;

  governorClient!: GovernorClient;
  timelockClient!: TimelockClient;
  votesClient!: VotesClient;

  private store!: MockLedgerStore;
  private mockServer?: MockSorobanServer;
  private addresses!: DeployedContracts;

  constructor(config: SimulationConfig) {
    if (config.mode === "testnet" && !config.rpcUrl) {
      throw new Error("SimulationConfig.rpcUrl is required when mode is 'testnet'");
    }
    this.config = config;
    this.clock = new LedgerClock(config.initialLedger ?? 1000);
  }

  /** Register actors (e.g. from `createActors()`) so scenarios/tests can look them up by name. */
  registerActors(actorSet: ActorSet): void {
    for (const [name, actor] of actorSet.all) {
      this.actors.set(name, actor);
    }
  }

  private buildSettingsState(): GovernorSettingsState {
    const s = this.config.settings;
    return {
      votingDelay: s.votingDelay,
      votingPeriod: s.votingPeriod,
      quorumNumerator: s.quorumNumerator,
      proposalThreshold: s.proposalThreshold,
      guardian: s.guardian ?? DEFAULT_GUARDIAN,
      voteType: s.voteType,
      proposalGracePeriod: s.proposalGracePeriod ?? DEFAULT_GRACE_PERIOD,
      proposalCooldown: s.proposalCooldown ?? DEFAULT_COOLDOWN,
      maxProposalsPerPeriod: s.maxProposalsPerPeriod ?? DEFAULT_MAX_PER_PERIOD,
      proposalPeriodDuration: s.proposalPeriodDuration ?? DEFAULT_PERIOD_DURATION,
    };
  }

  private buildStore(): MockLedgerStore {
    const addresses = this.addresses;
    const store: MockLedgerStore = {
      addresses,
      governor: {
        settings: this.buildSettingsState(),
        proposals: new Map(),
        proposalCount: 0n,
        queueTime: new Map(),
        lastProposalLedger: new Map(),
        proposalsInPeriod: new Map(),
      },
      timelock: {
        minDelay: this.config.settings.timelockDelay,
        executionWindow: this.config.settings.executionWindow ?? DEFAULT_EXECUTION_WINDOW,
        operations: new Map(),
      },
      votes: {
        balances: new Map(),
        delegates: new Map(),
        checkpoints: new Map(),
        totalSupplyCheckpoints: [],
      },
    };

    seedBalances(store.votes, this.config.tokenBalances);
    for (const [delegator, delegatee] of Object.entries(this.config.delegations)) {
      applyDelegation(store.votes, this.clock, delegator, delegatee);
    }

    return store;
  }

  /** Boot the harness: seed state and (in mock mode) intercept Soroban RPC construction. */
  async boot(): Promise<DeployedContracts> {
    this.addresses = {
      governor: contractAddress(1),
      timelock: contractAddress(2),
      votes: contractAddress(3),
    };
    this.store = this.buildStore();

    const clientConfig: GovernorConfig = {
      governorAddress: this.addresses.governor,
      timelockAddress: this.addresses.timelock,
      votesAddress: this.addresses.votes,
      network: this.config.network ?? "testnet",
      rpcUrl: this.config.mode === "testnet" ? this.config.rpcUrl : "https://mock.invalid",
      simulationAccount: this.config.mode === "mock" ? SIMULATION_ACCOUNT : undefined,
      maxAttempts: 1,
    };

    if (this.config.mode === "mock") {
      this.mockServer = new MockSorobanServer(this.store, this.clock);
      setActiveMockServer(this.mockServer);
    }

    this.governorClient = new GovernorClient(clientConfig);
    this.timelockClient = new TimelockClient(clientConfig);
    this.votesClient = new VotesClient(clientConfig);

    return this.addresses;
  }

  /** Advance the simulated ledger by `n` ledgers. */
  async advanceLedgers(n: number): Promise<void> {
    this.clock.advance(n);
  }

  /** Run a scenario against this harness. */
  async run<T extends BaseScenario, A extends unknown[]>(
    ScenarioClass: new (harness: SimulationHarness, ...args: A) => T,
    ...args: A
  ): Promise<SimulationResult> {
    const scenario = new ScenarioClass(this, ...args);
    return scenario.run();
  }

  /**
   * Invoke `cancel_queued` on the governor contract — a guardian veto of a
   * queued proposal. Not yet wrapped by `@nebgov/sdk`'s `GovernorClient`, so
   * built the same way the SDK's own write methods build theirs.
   */
  async cancelQueuedProposal(guardian: Keypair, proposalId: bigint): Promise<void> {
    const server = this.governorClient.server;
    const contract = this.governorClient.contract;
    const account = await server.getAccount(guardian.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.governorClient.networkPassphrase,
    })
      .addOperation(
        contract.call(
          "cancel_queued",
          nativeToScVal(guardian.publicKey(), { type: "address" }),
          nativeToScVal(proposalId, { type: "u64" }),
        ),
      )
      .setTimeout(30)
      .build();

    const prepared = await server.prepareTransaction(tx);
    prepared.sign(guardian);

    const result = await server.sendTransaction(prepared);
    if (result.status === "ERROR") {
      throw new Error(`cancel_queued failed: ${JSON.stringify(result)}`);
    }
    await this.governorClient.pollForConfirmation(result.hash);
  }

  /** Snapshot full contract state for later deterministic replay. */
  async snapshot(): Promise<ContractStateSnapshot> {
    if (this.config.mode !== "mock") {
      throw new Error("snapshot() is only supported in mock mode");
    }
    return {
      store: structuredClone(this.store),
      clock: this.clock.snapshot(),
    };
  }

  /** Restore a previously captured snapshot. */
  async restore(snap: ContractStateSnapshot): Promise<void> {
    if (this.config.mode !== "mock") {
      throw new Error("restore() is only supported in mock mode");
    }
    this.store = structuredClone(snap.store);
    this.clock.restore(snap.clock);
    this.mockServer?.setStore(this.store);
  }

  /** Tear down the harness, releasing it as the active mock Soroban RPC target. */
  async teardown(): Promise<void> {
    if (this.mockServer) {
      setActiveMockServer(undefined);
      this.mockServer = undefined;
    }
  }
}
