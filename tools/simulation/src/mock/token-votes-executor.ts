/**
 * Mock replica of `contracts/token-votes/src/lib.rs`'s delegation +
 * checkpoint bookkeeping (`delegate`, `get_votes`, `get_past_votes`).
 *
 * Simplification (documented in the harness plan): there is no separate
 * simulated SEP-41 token contract. `SimulationConfig.tokenBalances` seeds
 * each account's raw, delegatable balance directly into this executor.
 * Time-weighted checkpoints (`weighted_sum` bonus) are out of scope — voting
 * power is the flat delegated amount, which is sufficient to exercise the
 * governor's quorum/threshold/vote-weight logic exactly as the six
 * `ProposalState` transitions require.
 */
import { LedgerClock } from "../ledger";
import { Checkpoint, TokenVotesState } from "./store";
import { MockContractError } from "./errors";

function lastCheckpointVotes(list: Checkpoint[] | undefined): bigint {
  if (!list || list.length === 0) return 0n;
  return list[list.length - 1].votes;
}

function pushCheckpoint(map: Map<string, Checkpoint[]>, account: string, ledger: number, votes: bigint): void {
  const list = map.get(account) ?? [];
  list.push({ ledger, votes });
  map.set(account, list);
}

function checkpointAt(list: Checkpoint[] | undefined, ledger: number): bigint {
  if (!list || list.length === 0) return 0n;
  // Checkpoints are appended in non-decreasing ledger order; scan from the
  // end for the last entry at or before the target ledger.
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].ledger <= ledger) return list[i].votes;
  }
  return 0n;
}

export function seedBalances(state: TokenVotesState, balances: Record<string, bigint>): void {
  for (const [account, amount] of Object.entries(balances)) {
    state.balances.set(account, amount);
  }
}

export function applyDelegation(
  state: TokenVotesState,
  clock: LedgerClock,
  delegator: string,
  delegatee: string,
): void {
  const amount = state.balances.get(delegator) ?? 0n;
  const isFirstDelegation = !state.delegates.has(delegator);
  const oldDelegatee = state.delegates.get(delegator) ?? delegator;

  // On a delegator's first-ever `delegate()` call there is no prior
  // checkpoint to net against (even when self-delegating, i.e.
  // `oldDelegatee === delegatee` by default) — it must still activate their
  // voting power by crediting the new delegatee.
  if (isFirstDelegation || oldDelegatee !== delegatee) {
    if (!isFirstDelegation) {
      pushCheckpoint(state.checkpoints, oldDelegatee, clock.sequence, lastCheckpointVotes(state.checkpoints.get(oldDelegatee)) - amount);
    }
    pushCheckpoint(state.checkpoints, delegatee, clock.sequence, lastCheckpointVotes(state.checkpoints.get(delegatee)) + amount);
  }
  state.delegates.set(delegator, delegatee);

  if (isFirstDelegation && amount > 0n) {
    const lastTotal = lastCheckpointVotes(state.totalSupplyCheckpoints);
    state.totalSupplyCheckpoints.push({ ledger: clock.sequence, votes: lastTotal + amount });
  }
}

export const tokenVotesExecutor = {
  delegate(state: TokenVotesState, clock: LedgerClock, caller: string, args: unknown[]): unknown {
    const [delegator, delegatee] = args as [string, string];
    if (caller !== delegator) {
      throw new MockContractError(1, "delegate: delegator must authorize this call");
    }
    applyDelegation(state, clock, delegator, delegatee);
    return null;
  },

  get_votes(state: TokenVotesState, _clock: LedgerClock, _caller: string, args: unknown[]): bigint {
    const [account] = args as [string];
    return lastCheckpointVotes(state.checkpoints.get(account));
  },

  get_base_votes(state: TokenVotesState, _clock: LedgerClock, _caller: string, args: unknown[]): bigint {
    const [account] = args as [string];
    return state.balances.get(account) ?? 0n;
  },

  get_past_votes(state: TokenVotesState, clock: LedgerClock, _caller: string, args: unknown[]): bigint {
    const [account, ledger] = args as [string, number];
    if (ledger > clock.sequence) {
      throw new MockContractError(100, "get_past_votes: cannot query a future ledger");
    }
    return checkpointAt(state.checkpoints.get(account), ledger);
  },

  get_past_total_supply(state: TokenVotesState, clock: LedgerClock, _caller: string, args: unknown[]): bigint {
    const [ledger] = args as [number];
    if (ledger > clock.sequence) {
      throw new MockContractError(100, "get_past_total_supply: cannot query a future ledger");
    }
    return checkpointAt(state.totalSupplyCheckpoints, ledger);
  },

  delegates(state: TokenVotesState, _clock: LedgerClock, _caller: string, args: unknown[]): string | null {
    const [account] = args as [string];
    return state.delegates.get(account) ?? null;
  },
};

export type TokenVotesFunction = keyof typeof tokenVotesExecutor;
