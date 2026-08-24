# fix(treasury,deployment,optimistic-governor): add deactivate UI, verify-deployment coverage, drop unused execute() param

## Summary

- Added an admin-only "Deactivate" action to each strategy card in
  `app/src/app/treasury/strategies/page.tsx`, submitting a treasury
  multisig transaction that calls `treasury-strategies::deactivate_strategy`
  — the same submit/approve flow the existing "Register new strategy" form
  uses. Fixes #1107.
- Added post-deploy validation for `contracts/conviction-voting` and
  `contracts/treasury-strategies` to `scripts/verify-deployment.sh`, so a
  broken or missing deployment of either contract now fails verification
  instead of passing silently. Fixes #1103, #1104.
- Dropped the unused `caller` parameter from
  `optimistic-governor::execute()` so its signature is permissionless like
  `finalize()`, one step earlier in the same lifecycle. Fixes #1108.

## Details

### #1107 — Deactivate strategy UI

`treasury-strategies::deactivate_strategy(admin, strategy_id)` is
admin-gated the same way `register_strategy` is — the contract's `admin` is
the treasury multisig, not a signable wallet — so the new "Deactivate"
button reuses `TreasuryClient.submit(...)` with a new
`encodeDeactivateStrategyCalldata` helper (`app/src/lib/treasury-calldata.ts`)
instead of calling the contract directly. The button only renders for
active strategies, is gated behind the same `canRegister` admin-availability
check as the registration form, and confirms before submitting since it's a
state-changing multisig action.

While in this file, also fixed a duplicate `const treasuryAddress`
declaration (two conflicting definitions had landed from parallel PRs) that
would fail to compile.

### #1103 / #1104 — verify-deployment.sh coverage gaps

- `conviction-voting` has no dedicated `get_config`/`get_settings` getter;
  `get_required_threshold` is the only read-only entrypoint that panics
  with `NotInitialized` until `initialize()` succeeds, so it's called with
  `requested_amount=0` to double as the deployed+initialized check.
- `treasury-strategies` had no read-only entrypoint at all that depended on
  initialization state. Added a minimal `get_treasury()` getter (mirroring
  `TokenVotes::admin()` / `Liquidity::governor()`) and wired the script to
  both confirm it's deployed+initialized and that it's wired to the same
  `TREASURY_ADDRESS` used elsewhere in the env file.
- `query()` now accepts extra CLI args after the function name, needed for
  `get_required_threshold`'s `requested_amount` argument.

### #1108 — optimistic-governor `execute()` signature

`execute(caller, proposal_id)` called `caller.require_auth()` but never
read `caller` again, so any address could still call it by authenticating
as itself — no real access control, just an extra required signer/param
versus `finalize(proposal_id)` one step earlier in the same lifecycle.
Removed the parameter; `execute` is now permissionless like `finalize`.
Updated the SDK's `OptimisticGovernorClient.execute`/`executeWithSign` and
the contract's test suite to match the new signature.

### Also fixed

`app/src/app/vote-escrow/page.tsx` had a pre-existing unescaped apostrophe
that fails `next build`'s lint step (`react/no-unescaped-entities`),
unrelated to the four issues above but blocking a green frontend build.

## Test plan

- [x] `cargo test -p sorogov-optimistic-governor` — 17 passed
- [x] `cargo test -p sorogov-treasury-strategies` — 13 passed (incl. new
      `test_get_treasury_returns_configured_treasury`)
- [x] `cargo test` across the full CI package list — all green except one
      pre-existing, unrelated failure in `sorogov-token-votes`
      (`split_delegation_tests::test_single_100_weight_delegate_split_collapses_to_legacy_delegate_key`),
      confirmed present on `main` before this branch's changes
- [x] `cargo build --target wasm32v1-none --release` across all contract
      packages
- [x] `bash -n scripts/verify-deployment.sh`
- [x] `pnpm --filter @nebgov/sdk build` and `test` — 395 passed
- [x] `pnpm tsc --noEmit` in `app/`
- [x] `pnpm eslint .` in `app/` — no errors (pre-existing warnings only, in
      untouched files)
- [x] `pnpm next build` in `app/` — succeeds
- [x] `pnpm test` in `app/` — same 6 pre-existing failing suites as `main`
      (confirmed via stash comparison), nothing new broken

closes #1107
closes #1103
closes #1104
closes #1108
