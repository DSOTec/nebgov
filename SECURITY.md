# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| latest  | ✅        |
| < 0.1.0 | ❌        |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Please report vulnerabilities privately via one of:

- **GitHub Security Advisories (preferred):** https://github.com/nebgov/nebgov/security/advisories/new
- **Email:** security@nebgov.io

Include in your report:

- Description of the vulnerability
- Steps to reproduce
- Affected contracts/components
- Potential impact assessment
- Suggested fix (optional)

We will **acknowledge your report within 48 hours** and provide a fix timeline within **7 days** of confirmation.

## Disclosure Policy

- We aim to release a fix within **14 days** of confirmation.
- We will coordinate disclosure timing with the reporter.
- Credit is given to reporters in release notes, if desired.
- We ask that you do not publicly disclose the vulnerability until a fix has been released.

## Bug Bounty

We do not currently operate a formal bug bounty program. Responsible disclosure is recognized in our release notes.

## Scope

**In scope:**

- `contracts/governor`
- `contracts/timelock`
- `contracts/token-votes`
- `contracts/token-votes-wrapper`
- `contracts/treasury`
- `contracts/governor-factory`

**Out of scope:**

- Frontend UI bugs with no security impact (open a regular issue)
- Third-party dependency vulnerabilities (report upstream)

## Known Issues

See [docs/security/threat-model.md](./docs/security/threat-model.md) for documented known risks.

## Security Scanning

### Automated Vulnerability Scanning

All JavaScript dependencies are automatically scanned for known vulnerabilities using `pnpm audit` in our CI pipeline on every pull request and push to `main`, covering:

- `sdk/` — TypeScript SDK
- `app/` — Next.js frontend
- `packages/indexer/` — Event indexer
- `backend/` — Backend services

### Rust Security Audits

All Rust dependencies are scanned using `cargo-audit` via the `rustsec/audit-check` action on every PR and push to `main`.

- **Database:** [RustSec Advisory Database](https://rustsec.org/advisories/)
- **Configuration:** `.cargo/audit.toml`

### Severity Levels

- **Critical/High:** Blocks CI and prevents merging
- **Moderate/Low:** Reported but does not block CI
