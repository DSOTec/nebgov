# Contributing to NebGov

Thank you for contributing to NebGov, the permissionless governance framework for Stellar.

## Prerequisites

- **Rust** (stable toolchain) with `wasm32-unknown-unknown` target
- **Stellar CLI** (`stellar`) for contract building and testing
- **Node.js 20+** with **pnpm 9+**
- **Git**

### Install Prerequisites

```bash
# Rust toolchain
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add wasm32-unknown-unknown

# Stellar CLI
cargo install --locked stellar-cli

# Node.js (via nvm)
nvm install 20
npm install -g pnpm@9
```

## Local Setup

```bash
git clone https://github.com/nebgov/nebgov && cd nebgov

# Build all Soroban contracts
stellar contract build

# Install JS dependencies
pnpm install

# Build the SDK
pnpm build:sdk
```

## Running Tests

```bash
# Rust contract tests (all contracts)
cargo test --workspace

# Test a single contract
cargo test -p sorogov-governor

# SDK unit tests
pnpm test:sdk

# Frontend unit tests
pnpm test:app

# Frontend E2E tests (requires running app)
cd app && npx playwright test

# Backend tests (requires PostgreSQL — see Docker section below)
cd backend && npm test

# Fuzz tests (requires nightly Rust)
cargo +nightly fuzz run governor_state
```

> **Note:** Backend tests require a running PostgreSQL instance. Use `docker compose up db` to start one, or run the full stack with `docker compose up --build`.

## Docker Development Stack

Bring up the full local environment (PostgreSQL + indexer + backend + app) with one command:

```bash
cp .env.example .env
# Edit .env and set GOVERNOR_ADDRESS (required)
docker compose up --build
```

| Service   | URL                          |
| --------- | ---------------------------- |
| App       | http://localhost:3000         |
| Backend   | http://localhost:3001/health  |
| Indexer   | http://localhost:3002/health  |
| PostgreSQL| localhost:5432               |

To start only the database (for running backend tests without the full stack):

```bash
docker compose up db
```

## Security Scanning

We use [CoinFabrik Scout](https://github.com/CoinFabrik/scout) to automatically scan our Soroban contracts for security vulnerabilities.

### Local Usage

To run Scout locally, you first need to install the `scout-audit` tool:

```bash
cargo install cargo-scout-audit
```

Then, run the scanner from the repository root:

```bash
cargo scout-audit --output-format html
```

This will generate an `audit_report.html` file with the results.

### Interpreting Results

- **Critical/High**: These findings will fail the CI build and **must** be addressed before merging.
- **Medium/Low/Info**: These findings do not fail the CI but should be reviewed and fixed if applicable.

### Suppressing False Positives

If a finding is confirmed as a false positive, it can be suppressed in `.scout.toml` at the repository root. Each suppression must include a justification:

```toml
[[suppressions]]
detector = "detector_name"
reason = "Suppressed: [reason] — [date] — [author]"
```

## Project Structure

| Directory                    | Description                             |
| ---------------------------- | --------------------------------------- |
| `contracts/governor`         | Core governance contract (Rust/Soroban) |
| `contracts/timelock`         | Delayed execution controller            |
| `contracts/token-votes`      | Voting power with checkpointing         |
| `contracts/token-votes-wrapper` | Wrapper for external token voting    |
| `contracts/governor-factory` | Permissionless governor deployer        |
| `contracts/treasury`         | Multi-sig treasury                      |
| `contracts/liquidity`        | Liquidity management                    |
| `sdk/`                       | TypeScript SDK (`@nebgov/sdk`)          |
| `app/`                       | Next.js governance dashboard            |
| `backend/`                   | Express.js backend API                  |
| `packages/cli`               | CLI tool (`@nebgov/cli`)                |
| `packages/indexer`           | Governance event indexer                |
| `fuzz/`                      | Fuzz testing targets (libfuzzer)        |
| `docs/`                      | Architecture docs and ADRs              |

## How to Contribute

### 1. Find an issue

Browse [open issues](https://github.com/nebgov/nebgov/issues). Each issue is tagged with a type and complexity:

**Type labels:**

- `bug` — something is broken or not working as expected
- `enhancement` — new feature or improvement to existing functionality
- `security` — vulnerability or security concern (do not open a public issue; use [SECURITY.md](./SECURITY.md))
- `documentation` — documentation improvements or additions

**Complexity labels:**

- `complexity: trivial` — small, well-scoped change
- `complexity: medium` — moderate implementation work
- `complexity: high` — significant feature or architectural change

When opening a new issue, please choose one of the repository's issue templates so your report includes all required details.

Issues tagged `good first issue` are recommended for first-time contributors.

## Branch Naming

- `feat/issue-<number>-<description>` for features
- `fix/issue-<number>-<description>` for bug fixes
- `docs/issue-<number>-<description>` for documentation

## Commit Messages

Use imperative mood with conventional prefixes:

- `feat: add vote delegation`
- `fix: correct quorum calculation`
- `docs: update architecture diagram`
- `test: add governor edge cases`
- `chore: update dependencies`

## Pull Request Process

1. Fork the repo and create a branch from `main`
2. Make your changes with tests for new features
3. Ensure all CI checks pass (see below)
4. Update docs if you changed any public API
5. Open a PR referencing the issue: `Closes #<number>`
6. Wait for maintainer review

**Reviewers** are automatically assigned based on our [CODEOWNERS](.github/CODEOWNERS) configuration:

| Area            | Reviewers                     |
| --------------- | ----------------------------- |
| `contracts/`    | `@nebgov/contracts-team`      |
| `sdk/`          | `@nebgov/sdk-team`            |
| `app/`          | `@nebgov/frontend-team`       |
| `.github/`      | `@nebgov/devops-team`         |

**Approval requirements:**

- **General changes:** 1 approval minimum
- **Smart contract changes:** 2 approvals minimum (enforced via branch protection)

**Required CI checks:** All of the following must pass before merging:

- `cargo test --workspace` — Rust contract tests
- `cargo clippy -- -D warnings` — Rust lint (zero warnings)
- `cargo scout-audit` — Security vulnerability scan
- `pnpm test:sdk` — SDK unit tests
- `pnpm test:app` — Frontend unit tests
- `tsc --noEmit` — TypeScript type checking
- `pnpm audit --audit-level=high` — JS dependency audit
- `cargo-audit` — Rust dependency audit

**Review timeline:** Maintainers aim to provide initial feedback within 2–3 business days. If your PR is ready for review but hasn't received attention, ping the relevant team in the PR comments.

**Responding to feedback:** Push additional commits to your branch to address review comments. Do not force-push during review — it breaks comment threads. Re-request review once changes are made.

For more details on branch protection rules, see [Branch Protection](docs/contributing/branch-protection.md).

## Security Issues

If you find a security vulnerability, do not open a public issue. Follow the private reporting process in [SECURITY.md](./SECURITY.md) instead.

## Code Standards

### Rust (contracts)

- Format with `cargo fmt`
- No `unsafe` code
- All public functions must have doc comments
- Tests live in `#[cfg(test)]` modules
- Compiled WASM must be under **100KB** per contract (CI enforced — builds fail above this, warn above 80KB)

### TypeScript (SDK + frontend)

- Strict TypeScript, no `any` types
- Run `pnpm lint` before pushing
- Use named exports

### Coverage

- Target: **80% patch coverage** for new code
- Coverage is tracked via Codecov with separate flags for Rust and TypeScript
- Run `cargo llvm-cov --all-features --workspace` locally to generate a coverage report

## Issue Scope

Each issue is scoped to be completable in **under one week** by a single contributor. If you find an issue is larger than expected, comment on it so it can be split.

## Questions?

Open a discussion on GitHub or comment on the relevant issue.
