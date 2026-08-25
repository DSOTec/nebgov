# Branch Protection Rules

For an open-source governance protocol where smart contract changes are high-stakes, strict branch protection rules are required. This document outlines the recommended settings for the NebGov repository and any forks or deployments.

## Recommended Settings for `main`

We recommend applying the following branch protection rules in GitHub:

1. **Require Pull Request reviews before merging**
   - **Minimum number of approvals**: Set to `1` generally, but `2` for smart contracts. (The `CODEOWNERS` file enforces that the appropriate team reviews specific areas).
   - **Require review from Code Owners**: Enable this to ensure that the correct teams (e.g., `@nebgov/contracts-team`, `@nebgov/security-team`) approve PRs touching their files.

2. **Require status checks to pass before merging**
   - Require branches to be up to date before merging.
   - Require the following checks to pass:
     - Tests (`cargo test --workspace`, `pnpm test:sdk`, `pnpm test:app`)
     - Linting and Formatting (e.g., `clippy`)
     - Security Audits (e.g., `cargo-scout-audit`)

3. **Restrict who can push to matching branches**
   - Only allow specific individuals or teams to push directly to `main` (typically just the automation bots or core maintainers).

4. **Require signed commits**
   - Ensure all commits are verified to prevent impersonation.

By adhering to these rules, we ensure that no untested, unreviewed, or insecure code is introduced into the governance framework.
