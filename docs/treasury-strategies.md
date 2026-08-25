# Treasury Yield Strategies

`contracts/treasury-strategies` is a governance-controlled allocation layer
that lets idle funds held by `contracts/treasury` earn yield through
whitelisted external protocols, instead of sitting unused.

The contract never custodies funds on its own authority: the treasury
multisig moves tokens in via `deposit`, and every withdrawal ultimately
settles back to that same treasury address.

## Adapter model

Yield sources are integrated behind a minimal trait so any external protocol
can be whitelisted without changing this contract:

```rust
trait StrategyAdapterTrait {
    fn adapter_deposit(env: Env, caller: Address, token: Address, amount: i128);
    fn adapter_withdraw(env: Env, caller: Address, token: Address, amount: i128) -> i128;
    fn adapter_balance(env: Env, token: Address) -> i128;
}
```

`contracts/treasury-strategies/src/adapters/mock_adapter.rs` ships a simple
fixed-APY simulated adapter used by tests and the simulation harness; a real
integration implements the same trait against a live protocol.

Each registered `Strategy` records:

- `adapter` — the whitelisted adapter contract address
- `token` — the asset it accepts
- `max_allocation_bps` — allocation cap (see below)
- `withdrawal_cooldown_ledgers` — delay before a requested withdrawal is claimable
- `active` — whether new deposits can route to it

## Governance controls

Access is split by role:

| Action                              | Caller                          |
| ------------------------------------ | -------------------------------- |
| `register_strategy` / `deactivate_strategy` | admin only                 |
| `deposit` / `request_withdrawal`     | treasury only                    |
| `claim_withdrawal`                   | permissionless, after cooldown   |

**Allocation caps.** Each strategy has a `max_allocation_bps` (out of
`10_000`) capping how much of a token's total deposited value it may hold.
`deposit` routes new funds to the active strategy with the lowest current
allocation for that token, and rejects the deposit
(`AllocationCapExceeded`) if it would push that strategy's allocation above
`max_allocation_bps * total_deposited / 10_000`.

**Withdrawal cooldowns.** `request_withdrawal` (treasury-only) reserves an
amount from a strategy's allocation and records a `claimable_ledger` equal to
the current ledger plus that strategy's `withdrawal_cooldown_ledgers`.
`claim_withdrawal` is permissionless but reverts with
`WithdrawalNotYetClaimable` until that ledger is reached, and
`WithdrawalAlreadyClaimed` if already claimed — funds actually leave the
adapter and land back at the treasury only at claim time.

Deactivating a strategy (`deactivate_strategy`) stops it from receiving new
deposits but does not withdraw existing funds; outstanding allocations still
go through the normal request/claim flow.
