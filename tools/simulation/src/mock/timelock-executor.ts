/**
 * Mock replica of `contracts/timelock/src/lib.rs`'s scheduling/execution
 * bookkeeping. `schedule`/`execute`/`cancel` are only ever invoked
 * in-process by the Governor executor (mirroring how the real Governor
 * contract is the sole `require_governor`-gated caller of the Timelock
 * contract), never dispatched from a directly-signed Actor transaction.
 *
 * Simplification: `execute()` marks the operation executed but does not
 * actually invoke the scheduled target/fn_name/calldata — the harness has no
 * general-purpose contract-call dispatcher for arbitrary targets. Execution
 * success is modeled as "the timelock operation transitioned to executed",
 * matching the six `ProposalState` transitions the acceptance criteria care
 * about.
 */
import { createHash } from "node:crypto";
import { LedgerClock } from "../ledger";
import { TimelockOperationRecord, TimelockState } from "./store";
import { MockContractError } from "./errors";
import { TimelockErrorCode } from "@nebgov/sdk";

function computeOpId(target: string, data: Uint8Array, fnName: string, delay: bigint, predecessor: Uint8Array, salt: Uint8Array): string {
  return createHash("sha256")
    .update(target)
    .update(fnName)
    .update(Buffer.from(data))
    .update(String(delay))
    .update(Buffer.from(predecessor))
    .update(Buffer.from(salt))
    .digest("hex");
}

function requireGovernor(state: TimelockState, governorAddress: string, caller: string): void {
  if (caller !== governorAddress) {
    throw new MockContractError(0, "only governor");
  }
}

export function scheduleOperation(
  state: TimelockState,
  clock: LedgerClock,
  target: string,
  data: Uint8Array,
  fnName: string,
  delay: bigint,
  predecessor: Uint8Array = new Uint8Array(),
  salt: Uint8Array = new Uint8Array(),
): string {
  if (delay < state.minDelay) {
    throw new MockContractError(100, "schedule: delay too short");
  }
  const opId = computeOpId(target, data, fnName, delay, predecessor, salt);
  const readyAt = clock.timestamp + Number(delay);
  const expiresAt = readyAt + Number(state.executionWindow);
  const op: TimelockOperationRecord = {
    target,
    fnName,
    data,
    readyAt,
    expiresAt,
    executed: false,
    cancelled: false,
  };
  state.operations.set(opId, op);
  return opId;
}

export function executeOperation(state: TimelockState, clock: LedgerClock, opId: string): void {
  const op = state.operations.get(opId);
  if (!op) throw new MockContractError(100, "execute: operation not found");
  if (op.executed || op.cancelled) {
    throw new MockContractError(100, "execute: invalid operation state");
  }
  if (clock.timestamp < op.readyAt) {
    throw new MockContractError(100, "execute: operation not ready");
  }
  if (clock.timestamp > op.expiresAt) {
    throw new MockContractError(TimelockErrorCode.OperationExpired, "execute: operation expired");
  }
  op.executed = true;
}

export function cancelOperation(state: TimelockState, opId: string): void {
  const op = state.operations.get(opId);
  if (!op) throw new MockContractError(100, "cancel: operation not found");
  if (op.executed) throw new MockContractError(100, "cancel: already executed");
  op.cancelled = true;
}

export const timelockExecutor = {
  is_ready(state: TimelockState, clock: LedgerClock, _caller: string, args: unknown[]): boolean {
    const [opIdBytes] = args as [Uint8Array];
    const opId = Buffer.from(opIdBytes).toString("hex");
    const op = state.operations.get(opId);
    if (!op) return false;
    return !op.executed && !op.cancelled && clock.timestamp >= op.readyAt && clock.timestamp <= op.expiresAt;
  },

  is_pending(state: TimelockState, clock: LedgerClock, _caller: string, args: unknown[]): boolean {
    const [opIdBytes] = args as [Uint8Array];
    const opId = Buffer.from(opIdBytes).toString("hex");
    const op = state.operations.get(opId);
    if (!op) return false;
    return !op.executed && !op.cancelled && clock.timestamp < op.readyAt;
  },

  min_delay(state: TimelockState): bigint {
    return state.minDelay;
  },

  execution_window(state: TimelockState): bigint {
    return state.executionWindow;
  },
};

export type TimelockFunction = keyof typeof timelockExecutor;
