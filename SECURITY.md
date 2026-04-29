# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| latest  | yes       |
| < 0.1.0 | no        |

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report vulnerabilities privately via one of:

- GitHub Security Advisories: https://github.com/nebgov/nebgov/security/advisories/new
- Email: security@nebgov.xyz

Include:

- Description of the vulnerability
- Steps to reproduce
- Affected contracts/components
- Potential impact

You will receive an acknowledgement within 48 hours.

## Disclosure Policy

- We aim to release a fix within 14 days of confirmation
- We will coordinate disclosure timing with the reporter
- Credit given to reporters in release notes, if desired

## Scope

In scope:

- governor
- timelock
- token-votes
- token-votes-wrapper
- treasury
- governor-factory contracts

Out of scope:

- frontend UI bugs (open a regular issue)
- third-party dependencies

## Known Issues

See [docs/security/threat-model.md](./docs/security/threat-model.md) for documented known risks.

## Security Scanning

### Automated Vulnerability Scanning

All JavaScript dependencies are automatically scanned for known vulnerabilities using `pnpm audit` in our CI pipeline. The scan runs on every pull request and push to main, covering all workspaces:

- `sdk/` - TypeScript SDK
- `app/` - Next.js frontend
- `packages/indexer/` - Event indexer API
- `backend/` - Backend services (if present)

### Rust Security Audits

All Rust dependencies are automatically scanned for known security vulnerabilities using `cargo-audit` via the `rustsec/audit-check` action.

- **Frequency**: Every PR and push to `main`.
- **Database**: [RustSec Advisory Database](https://rustsec.org/advisories/).
- **Reporting**: Vulnerabilities are posted as comments on pull requests.
- **Configuration**: Suppression of false positives or non-applicable advisories is handled in `.cargo/audit.toml`.

### Handling False Positives

If a vulnerability is flagged that doesn't apply to our usage or is a false positive, you can suppress it using one of these methods:

#### Method 1: Using .npmrc (Recommended)

Create or update `.npmrc` in the workspace root:

```
audit-level=high
```

#### Method 2: Package.json Overrides

Add to the root `package.json`:

```json
{
  "pnpm": {
    "auditConfig": {
      "ignoreCves": ["CVE-2023-XXXXX"]
    }
  }
}
```

#### Method 3: Temporary Bypass

For temporary issues during development:

```bash
pnpm audit --audit-level=high --ignore-registry-errors
```

### Severity Levels

- **Critical/High**: Blocks CI and prevents merging
- **Moderate/Low**: Reported but doesn't block CI
- **Info**: Logged for awareness only

When suppressing vulnerabilities, document the reasoning in the commit message and consider creating a GitHub issue to track the decision.
