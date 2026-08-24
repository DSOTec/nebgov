## Summary

Fixes four deployment-tooling gaps where contracts added in recent feature work weren't wired into the local deploy-verification script or Makefile, so a broken deployment or a `make` run could silently skip them:

- **#1102** — `scripts/verify-deployment.sh` had no check for `contracts/optimistic-governor`.
- **#1101** — `scripts/verify-deployment.sh` had no check for `contracts/proposal-bonds`.
- **#1099** — `Makefile` build/test targets didn't cover `contracts/treasury-strategies`, even though CI already builds/tests it via `-p sorogov-treasury-strategies`.
- **#1097** — `Makefile` build/test targets didn't cover `contracts/optimistic-governor`, even though CI already builds/tests it via `-p sorogov-optimistic-governor`.

## Changes

**`scripts/verify-deployment.sh`**
- Added a validation section for `OptimisticGovernor`: calls `get_config()`, which panics with `NotInitialized` until `initialize()` has succeeded, so a non-error response proves the contract is deployed *and* initialized. Also checks the returned `votes_token` matches the deployed `TOKEN_VOTES_ADDRESS`.
- Added the same pattern for `ProposalBonds` using `get_settings()`, checking `governor` matches `GOVERNOR_ADDRESS`.
- Added two small helpers, `check_initialized` and `check_contains`, since neither contract exposes a scalar `admin()`-style getter like the existing checks use — both only expose struct-returning getters.

**`Makefile`**
- Replaced the implicit `--workspace`/default-member build and test selection with an explicit `CONTRACT_PACKAGES` list (kept in sync with `.github/workflows/rust.yml`), so `test-contracts`, `build-wasm`, and `lint` always cover every contract by name — including `treasury-strategies` and `optimistic-governor` — instead of relying on undocumented workspace-default behavior.
- Made `test-contracts` depend on `build-wasm`: `governor-factory`'s tests load prebuilt `.wasm` artifacts via `contractimport!`, which fails with "No such file or directory" on a clean checkout unless the WASM is built first — mirroring CI's separate "Build WASMs for test dependencies" step.

## Verification

Ran the equivalent of the CI workflow locally against these changes:

- `make build-wasm` — passes, produces all 14 contract `.wasm` artifacts.
- `make test-contracts` — passes (28/28 test suites green) after adding the `build-wasm` prerequisite.
- `bash -n scripts/verify-deployment.sh` — syntax OK.
- `make -n test-contracts|build-wasm|lint` — confirmed `sorogov-treasury-strategies` and `sorogov-optimistic-governor` now appear explicitly in every target's expanded command.

**Known pre-existing failure, out of scope:** `make lint` fails on `contracts/treasury/src/streams.rs` (clippy `too_many_arguments`, `unnecessary_cast`, `manual_checked_ops`). Confirmed via `git stash` that this fails identically on unmodified `main` with the original `cargo clippy --workspace -- -D warnings` command — it's unrelated business logic in `treasury`, not something introduced or touched by this PR. Flagging separately rather than fixing here since it would mean changing contract logic outside the scope of these four issues.

## Test plan

- [x] `make build-wasm`
- [x] `make test-contracts`
- [x] `bash -n scripts/verify-deployment.sh`
- [ ] Run `make verify-testnet` against a real testnet deployment with `OPTIMISTIC_GOVERNOR_ADDRESS` / `PROPOSAL_BONDS_ADDRESS` set, to confirm the new checks pass against live contracts (note: `scripts/deploy-testnet.sh` doesn't currently deploy either contract, so these addresses must be set manually for now — separate follow-up if desired)
