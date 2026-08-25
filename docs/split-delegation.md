# Split Delegation

`contracts/token-votes/src/split_delegation.rs` lets a token holder delegate
arbitrary basis-point percentages of their voting power across multiple
delegatees at once, instead of the legacy single-target `delegate()`. It's
exposed on the frontend delegates page via `SplitDelegationEditor`.

## Entrypoints

| Function                                       | Description                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------ |
| `delegate_split(delegator, splits)`              | Replaces the delegator's entire distribution with `splits`.             |
| `undelegate_split(delegator)`                    | Clears any split/legacy distribution and reverts to self-delegation.    |
| `get_split_delegations(delegator) -> Vec<SplitDelegation>` | Reads the current distribution, legacy or split (see below).  |

Each `SplitDelegation { delegatee, weight_bps }` entry's `weight_bps` is out
of `10_000` (basis points). A `delegate_split` call is rejected
(`TokenVotesError`) if:

- the split list is empty, or has more entries than the governance-settable
  `MaxSplitTargets` cap (default `10`)
- any entry has `weight_bps == 0`
- any delegatee appears more than once
- the weights don't sum to exactly `10_000`

The delegator's token balance is split across entries proportionally to
`weight_bps`, with integer-division rounding remainder credited to the last
entry so the parts always sum exactly to the balance.

## Interop with legacy `delegate()`

Split delegation is additive, not a replacement — `delegate()` /
`undelegate()` keep working unchanged for any account that never calls a
`*_split` entrypoint. The two are unified on both sides:

- **Write side**: a `delegate_split` call with a single 100%-weight entry
  collapses into the same storage key `delegate()` uses, rather than a
  separate split record. So an account that only ever submits one-entry
  splits stays fully compatible with `delegate()`/`undelegate()` and with
  `delegation_registry`'s chain resolution.
- **Read side**: `get_split_delegations` falls back to the legacy `Delegate`
  mapping when no split record exists, returning it as a single 100%-weight
  entry.

This compatibility is one-directional: once a delegator has a genuine
multi-entry split on file, falling back to the plain `delegate()` entrypoint
is out of scope — call `undelegate_split` first.
