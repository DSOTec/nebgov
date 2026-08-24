## Summary

- Makefile's `test-contracts` and `build-wasm` targets ran cargo with no package list at all, so they silently diverged from `.github/workflows/rust.yml`. Governor-factory's tests need prebuilt contract WASM (via `contractimport!`), which the old targets never produced, so `make test-contracts` failed outright. Both targets now use the same explicit `-p sorogov-*` package list as CI — including `proposal-bonds`, `conviction-voting`, and `signal-anchor` — and `test-contracts` depends on `build-wasm` so the WASM artifacts exist before tests run, matching CI's step ordering. Fixes #1096, #1098, #1100.
- Added an admin-only "Register new strategy" form to `app/src/app/treasury/strategies/page.tsx` for the `register_strategy` contract function, which previously had no UI anywhere. Fixes #1106.

## Details

### Makefile (#1096, #1098, #1100)

`register_strategy`'s admin argument must equal the treasury contract's own address in production (per `TreasuryStrategiesClient`'s docstring), not a signable wallet — so it can't be called directly. The new form instead builds the `register_strategy` calldata (adapter, token, max allocation bps, withdrawal cooldown) and submits it through the treasury multisig's existing `submit`/`approve` flow (`TreasuryClient.submit`), the same mechanism `app/src/app/treasury/page.tsx` already uses for admin actions. The form is gated on wallet connection the same way `app/src/app/settings` gates its admin controls; on-chain authorization is still enforced by the treasury contract's own `require_owner` check in `submit()`.

## Test plan

- [x] `make build-wasm` — builds all 14 contract crates
- [x] `make test-contracts` — all contract test suites pass (28 `test result: ok` blocks, 0 failures)
- [x] `pnpm --filter @nebgov/sdk build` — SDK compiles
- [x] `tsc --noEmit` in `app/` — no type errors
- [x] `pnpm build` in `app/` — Next.js production build succeeds, `/treasury/strategies` compiles
- [ ] Manual click-through of the new registration form against a deployed treasury (needs a live testnet treasury + owner wallet)

## Notes for reviewers

- `cargo fmt --all -- --check` and `cargo clippy --workspace --all-targets -- -D warnings` both currently fail on pre-existing drift unrelated to this change (formatting in `co-sponsorship`/`governor`/`timelock`/etc., and `assert_eq!(x, bool)` clippy lints in `treasury/src/stream_tests.rs`). Neither of those touches the files in this PR; `fmt` isn't part of `rust.yml` at all, and the clippy failures predate this branch. Flagging separately rather than folding an unrelated cleanup into this PR.
