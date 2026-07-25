/**
 * `MockSorobanServer` — a stateful, in-memory stand-in for
 * `SorobanRpc.Server`, wired in by `SimulationHarness.boot()` via
 * `jest.mock("@stellar/stellar-sdk", ...)` (the same seam
 * `sdk/src/__tests__/governor.test.ts` uses).
 *
 * `@nebgov/sdk`'s `GovernorClient`/`TimelockClient`/`VotesClient` build real
 * Soroban operations via `Contract.call()` + `TransactionBuilder`, so this
 * class decodes the real XDR operation off the transaction it's handed
 * (contract address, function name, args) and dispatches to the matching
 * in-memory executor, rather than short-circuiting the SDK's own encoding.
 */
import { Address, nativeToScVal, scValToNative, SorobanDataBuilder, xdr } from "@stellar/stellar-sdk";
import { LedgerClock } from "../ledger";
import { cloneStore, MockLedgerStore } from "./store";
import { MockContractError } from "./errors";
import { governorExecutor } from "./governor-executor";
import { timelockExecutor } from "./timelock-executor";
import { tokenVotesExecutor } from "./token-votes-executor";
import { encAddress, encBool, encEnum, encI128, encMap, encU32, encU64, encVec, encVoid } from "./codec";

interface DecodedInvocation {
  contractAddress: string;
  functionName: string;
  args: unknown[];
  caller: string;
}

interface StoredTxResult {
  status: "SUCCESS" | "FAILED";
  returnValue?: xdr.ScVal;
  error?: string;
}

/**
 * Duck-typed `Account` (the trio `TransactionBuilder` actually calls:
 * `accountId()`/`sequenceNumber()`/`incrementSequenceNumber()`). Several SDK
 * read paths call `getAccount()` with a contract ("C...") address as a
 * throwaway simulation source, which the real `Account` class's strkey
 * validation would reject — this accepts any id.
 */
class MockAccount {
  constructor(
    private readonly id: string,
    private sequence: bigint,
  ) {}

  accountId(): string {
    return this.id;
  }

  sequenceNumber(): string {
    return this.sequence.toString();
  }

  incrementSequenceNumber(): void {
    this.sequence += 1n;
  }
}

function decodeInvocation(tx: { operations: unknown[]; source: string }): DecodedInvocation {
  const op = tx.operations[0] as { type?: string; func?: xdr.HostFunction; source?: string };
  if (!op || op.type !== "invokeHostFunction" || !op.func) {
    throw new Error("MockSorobanServer only supports a single invokeHostFunction operation");
  }
  const invoke = op.func.invokeContract();
  const contractAddress = Address.fromScAddress(invoke.contractAddress()).toString();
  const rawName = invoke.functionName();
  const functionName = typeof rawName === "string" ? rawName : Buffer.from(rawName).toString();
  const args = invoke.args().map((arg) => scValToNative(arg));
  return { contractAddress, functionName, args, caller: op.source ?? tx.source };
}

function encodeGovernorSettings(settings: MockLedgerStore["governor"]["settings"]): xdr.ScVal {
  return encMap({
    voting_delay: encU32(settings.votingDelay),
    voting_period: encU32(settings.votingPeriod),
    quorum_numerator: encU32(settings.quorumNumerator),
    proposal_threshold: encI128(settings.proposalThreshold),
    guardian: encAddress(settings.guardian),
    vote_type: encEnum(settings.voteType),
    proposal_grace_period: encU32(settings.proposalGracePeriod),
    use_dynamic_quorum: encBool(settings.useDynamicQuorum),
    reflector_oracle: settings.reflectorOracle ? encAddress(settings.reflectorOracle) : encVoid(),
    min_quorum_usd: encI128(settings.minQuorumUsd),
    max_calldata_size: encU32(settings.maxCalldataSize),
    proposal_cooldown: encU32(settings.proposalCooldown),
    max_proposals_per_period: encU32(settings.maxProposalsPerPeriod),
    proposal_period_duration: encU32(settings.proposalPeriodDuration),
  });
}

function encodeReturn(contract: "governor" | "timelock" | "votes", fnName: string, value: unknown): xdr.ScVal {
  if (contract === "governor") {
    switch (fnName) {
      case "propose":
      case "proposal_count":
        return encU64(value as bigint);
      case "cast_vote":
      case "queue":
      case "execute":
      case "cancel":
      case "cancel_queued":
      case "update_config":
      case "set_guardian":
      case "set_voting_strategy":
      case "migrate":
      case "pause":
      case "unpause":
        return encVoid();
      case "state":
        return encEnum(value as string);
      case "get_settings":
        return encodeGovernorSettings(value as MockLedgerStore["governor"]["settings"]);
      case "get_quorum":
      case "proposal_threshold":
        return encI128(value as bigint);
      case "is_quorum_reached":
        return encBool(value as boolean);
      case "proposal_votes":
        return encVec((value as bigint[]).map(encI128));
      case "has_voted":
        return encBool(value as boolean);
      case "get_proposal":
        return encVoid();
      case "proposals_count_by_state":
        return encVoid();
      default:
        throw new Error(`MockSorobanServer: no encoder for governor.${fnName}`);
    }
  }
  if (contract === "timelock") {
    switch (fnName) {
      case "is_ready":
      case "is_pending":
        return encBool(value as boolean);
      case "min_delay":
      case "execution_window":
        return encU64(value as bigint);
      case "schedule_with_deps":
        return value ? encAddress(value as string) : encVoid();
      case "validate_dependency_dag":
      case "execute_batch_partial":
      case "retry_failed_operation":
      case "skip_failed_operation":
        return encVoid();
      default:
        throw new Error(`MockSorobanServer: no encoder for timelock.${fnName}`);
    }
  }
  switch (fnName) {
    case "delegate":
      return encVoid();
    case "get_votes":
    case "get_base_votes":
    case "get_past_votes":
    case "get_past_total_supply":
      return encI128(value as bigint);
    case "delegates":
      return value ? encAddress(value as string) : encVoid();
    default:
      throw new Error(`MockSorobanServer: no encoder for votes.${fnName}`);
  }
}

export class MockSorobanServer {
  private readonly results = new Map<string, StoredTxResult>();

  constructor(
    private store: MockLedgerStore,
    private readonly clock: LedgerClock,
  ) {}

  /** Swap in a restored store (e.g. after `SimulationHarness.restore()`). */
  setStore(store: MockLedgerStore): void {
    this.store = store;
    this.results.clear();
  }

  private resolveContract(address: string): "governor" | "timelock" | "votes" {
    if (address === this.store.addresses.governor) return "governor";
    if (address === this.store.addresses.timelock) return "timelock";
    if (address === this.store.addresses.votes) return "votes";
    throw new Error(`MockSorobanServer: unknown contract address ${address}`);
  }

  private dispatch(invocation: DecodedInvocation, store: MockLedgerStore): unknown {
    const contract = this.resolveContract(invocation.contractAddress);
    if (contract === "governor") {
      const handler = (governorExecutor as Record<string, (...a: unknown[]) => unknown>)[invocation.functionName];
      if (!handler) throw new Error(`MockSorobanServer: unknown governor function ${invocation.functionName}`);
      return handler(store, this.clock, invocation.caller, invocation.args);
    }
    if (contract === "timelock") {
      const handler = (timelockExecutor as Record<string, (...a: unknown[]) => unknown>)[invocation.functionName];
      if (!handler) throw new Error(`MockSorobanServer: unknown timelock function ${invocation.functionName}`);
      return handler(store.timelock, this.clock, invocation.caller, invocation.args);
    }
    const handler = (tokenVotesExecutor as Record<string, (...a: unknown[]) => unknown>)[invocation.functionName];
    if (!handler) throw new Error(`MockSorobanServer: unknown votes function ${invocation.functionName}`);
    return handler(store.votes, this.clock, invocation.caller, invocation.args);
  }

  async getAccount(accountId: string): Promise<MockAccount> {
    return new MockAccount(accountId, 0n);
  }

  async getLatestLedger(): Promise<{ id: string; protocolVersion: number; sequence: number }> {
    return { id: "mock-ledger", protocolVersion: 21, sequence: this.clock.sequence };
  }

  async prepareTransaction<T>(tx: T): Promise<T> {
    return tx;
  }

  async simulateTransaction(tx: { operations: unknown[]; source: string }): Promise<Record<string, unknown>> {
    const invocation = decodeInvocation(tx);
    const contract = this.resolveContract(invocation.contractAddress);
    const scratch = cloneStore(this.store);

    try {
      const value = this.dispatch(invocation, scratch);
      const retval = encodeReturn(contract, invocation.functionName, value);
      return {
        _parsed: true,
        id: "1",
        latestLedger: this.clock.sequence,
        events: [],
        transactionData: new SorobanDataBuilder(),
        minResourceFee: "100000",
        cost: { cpuInsns: "0", memBytes: "0" },
        result: { auth: [], retval },
      };
    } catch (e) {
      return {
        _parsed: true,
        id: "1",
        latestLedger: this.clock.sequence,
        events: [],
        error: e instanceof MockContractError ? e.toSorobanErrorString() : String(e instanceof Error ? e.message : e),
      };
    }
  }

  async sendTransaction(tx: { operations: unknown[]; source: string; hash(): Buffer }): Promise<Record<string, unknown>> {
    const invocation = decodeInvocation(tx);
    const contract = this.resolveContract(invocation.contractAddress);
    const hash = tx.hash().toString("hex");

    try {
      const value = this.dispatch(invocation, this.store);
      const returnValue = encodeReturn(contract, invocation.functionName, value);
      this.results.set(hash, { status: "SUCCESS", returnValue });
      return { status: "PENDING", hash, latestLedgerCloseTime: String(Math.floor(this.clock.timestamp)) };
    } catch (e) {
      const message = e instanceof MockContractError ? e.toSorobanErrorString() : String(e instanceof Error ? e.message : e);
      this.results.set(hash, { status: "FAILED", error: message });
      return { status: "ERROR", hash, error: message };
    }
  }

  async getTransaction(hash: string): Promise<Record<string, unknown>> {
    const result = this.results.get(hash);
    if (!result) {
      return { status: "NOT_FOUND" };
    }
    if (result.status === "FAILED") {
      return { status: "FAILED" };
    }
    return { status: "SUCCESS", returnValue: result.returnValue, latestLedger: this.clock.sequence };
  }
}

// Re-exported so callers building raw operations (functions not yet wrapped
// by @nebgov/sdk, e.g. `cancel_queued`) can reuse the same native<->ScVal
// helpers the executors were verified against.
export { nativeToScVal, scValToNative };
