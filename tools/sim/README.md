# nebgov-sim: Governance Simulation Harness

A Rust simulation runner for NebGov's governance contracts. This tool exercises the full proposal lifecycle (propose - vote - queue - execute) without deploying to the Stellar network, tracking compute budget and storage write patterns as regression signals.

## Quick Start

Build the simulator:

```bash
cargo build --manifest-path tools/sim/Cargo.toml --release
```

Run a scenario:

```bash
cargo run --manifest-path tools/sim/Cargo.toml -- run --scenario tools/sim/src/scenarios/basic.json --output report.json
```

Run all scenarios:

```bash
cargo run --manifest-path tools/sim/Cargo.toml -- run-all
```

## CLI Subcommands

### `run`

Run a single scenario file and output a JSON report.

```bash
cargo run --manifest-path tools/sim/Cargo.toml -- run \
  --scenario <path.json> \
  [--output report.json] \
  [--verbose]
```

**Options:**
- `--scenario` (required): Path to a scenario JSON file
- `--output`: Path where the JSON report is written (default: `report.json`)
- `--verbose`: Print per-step details instead of just the summary

**Exit codes:**
- 0: All steps passed and no critical budget warnings (utilization >= 100%)
- 1: Any step failed or any budget warning reached the critical threshold

### `run-all`

Run every `*.json` scenario in a directory, writing reports for each.

```bash
cargo run --manifest-path tools/sim/Cargo.toml -- run-all \
  [--scenarios-dir tools/sim/src/scenarios] \
  [--output-dir tools/sim/reports]
```

**Options:**
- `--scenarios-dir`: Directory containing scenario files (default: `tools/sim/src/scenarios`)
- `--output-dir`: Directory where JSON reports are written (default: `tools/sim/reports`)

**Exit codes:**
- 0: All scenarios passed with no critical budget warnings
- 1: Any scenario failed or had a critical budget warning

### `validate`

Structurally validate a scenario file without running it.

```bash
cargo run --manifest-path tools/sim/Cargo.toml -- validate <scenario.json>
```

**Exit codes:**
- 0: Scenario is valid
- 1: Scenario structure is invalid

### `list-scenarios`

List all scenario files in a directory.

```bash
cargo run --manifest-path tools/sim/Cargo.toml -- list-scenarios \
  [--scenarios-dir tools/sim/src/scenarios]
```

## Scenario Schema

A scenario is a JSON file describing a sequence of governance steps to execute. See `tools/sim/src/scenarios/*.json` for examples.

### Structure

```json
{
  "name": "scenario_name",
  "description": "Human-readable description",
  "seed": 1,
  "governor_settings": { ... },
  "actors": [ ... ],
  "steps": [ ... ]
}
```

### Governor Settings

Configure governance parameters (voting delay, quorum, vote type, etc.). This is merged with contract initialization defaults — only override what your scenario needs.

### Actors

A list of participants with roles:

```json
{
  "name": "alice",
  "initial_balance": 1000,
  "delegate_to": null,
  "role": "Proposer"  // or "TokenHolder", "Guardian", "Pauser", "Admin"
}
```

### Steps

Each step is one action in the governance lifecycle:

**Propose**
```json
{
  "type": "Propose",
  "actor": "proposer_name",
  "targets": ["treasury", "target"],
  "fn_names": ["transfer", "noop"],
  "description": "Proposal description"
}
```

The `targets` list can be:
- `"treasury"`: The deployed treasury contract
- `"governor"`: The deployed governor contract
- `"target"`: A placeholder no-op contract for testing
- Any actor name: That actor's address

**Vote**
```json
{
  "type": "Vote",
  "actor": "voter_name",
  "proposal_id": 1,
  "support": "For"  // or "Against", "Abstain"
}
```

**Queue / Execute / Cancel**
```json
{
  "type": "Queue",
  "actor": "actor_name",
  "proposal_id": 1
}
```

**Delegate**
```json
{
  "type": "Delegate",
  "actor": "delegator_name",
  "delegatee": "delegatee_name"
}
```

**Mint / Burn Tokens**
```json
{
  "type": "MintTokens",
  "actor": "actor_name",
  "amount": 500
}
```

**Update Config**
```json
{
  "type": "UpdateConfig",
  "actor": "admin_name",
  "settings": { ... }
}
```

**Pause / Unpause Contract**
```json
{
  "type": "PauseContract",
  "actor": "pauser_name"
}
```

**Advance Ledger**
```json
{
  "type": "AdvanceLedger",
  "ledgers": 10
}
```

**Assert Proposal State**
```json
{
  "type": "ExpectState",
  "proposal_id": 1,
  "expected_state": "Active"  // or "Pending", "Defeated", "Succeeded", "Queued", "Executed", "Cancelled", "Expired"
}
```

**Expect Step Error**
```json
{
  "type": "ExpectError",
  "step_index": 5,
  "expected_error": "proposal below quorum"
}
```
When a step is expected to fail, mark it with an `ExpectError` that references its index. This prevents the failure from being counted against the scenario's success.

**Assert Participation**
```json
{
  "type": "AssertParticipation",
  "proposal_id": 1,
  "min_bps": 1000  // minimum basis points (1000 = 10%)
}
```

**Assert Quorum**
```json
{
  "type": "AssertQuorumReached",
  "proposal_id": 1
}
```

**Take Analytics Snapshot**
```json
{
  "type": "TakeAnalyticsSnapshot"
}
```
Records proposal counts by state in the report.

**Proposal Bonds**
```json
{ "type": "LockProposalBond", "actor": "alice", "description": "Proposal A" }
{ "type": "RefundProposalBond", "actor": "bob", "description": "Proposal A", "proposal_id": 1 }
{ "type": "ExpectBondState", "description": "Proposal A", "expected_state": "Refunded" }
```

`LockProposalBond` and `RefundProposalBond` correlate a bond with its governor
proposal by hashing the same description. To exercise the governance-only slash
path, create a follow-up proposal with `ProposeBondSlash`:

```json
{
  "type": "ProposeBondSlash",
  "actor": "bob",
  "bonded_description": "Proposal A",
  "recipient": "treasury",
  "description": "Slash Proposal A's bond"
}
```

After that proposal passes, queue and execute it normally, then assert
`"expected_state": "Slashed"` with `ExpectBondState`.

## Simulation Report

Each run produces a JSON report with per-step results and aggregate metrics:

```json
{
  "scenario_name": "basic",
  "total_steps": 15,
  "passed_steps": 14,
  "failed_steps": 1,
  "final_ledger": 50,
  "proposals_created": 1,
  "proposals_executed": 0,
  "proposals_defeated": 0,
  "total_votes_cast": 3,
  "step_results": [
    {
      "step_index": 0,
      "step_type": "Propose",
      "ledger": 1,
      "success": true,
      "error": null,
      "cpu_insns": 5_000_000,
      "mem_bytes": 200_000,
      "storage_entries_read": 3,
      "storage_entries_written": 5,
      "duration_ms": 42,
      "anticipated_failure": false
    }
    // ... more results
  ],
  "compute_budget_warnings": [
    {
      "step_index": 5,
      "cpu_insns": 100_000_000,
      "budget_limit": 100_000_000,
      "utilization_pct": 100.0
    }
  ],
  "storage_warnings": [
    {
      "step_index": 7,
      "entries_written": 75,
      "utilization_pct": 150.0
    }
  ]
}
```

### Budget Warnings

A `BudgetWarning` is emitted when a single step uses >= 80% of the CPU instruction budget (configured in `report.rs` as `BUDGET_WARNING_THRESHOLD_PCT = 80.0`). Critical warnings (>= 100%) indicate the step would fail on-chain.

### Storage Warnings

A `StorageWarning` is emitted when a single step writes >= 50 storage entries (configured as `STORAGE_WRITE_WARNING_THRESHOLD = 50`), a proxy for unbounded-growth patterns like `DraftList` or `ProposalList`.

The storage write count is estimated per step-kind based on the step's shape (see `runner.rs:estimated_storage_touches()`):
- `Propose`: 5 base writes + 1 per target
- `Vote`: 2 writes
- `Queue` / `Execute` / `Cancel`: 2 writes
- `UpdateConfig`: 14 writes
- All others: 0 writes

## CI Integration

The simulator is run as part of `.github/workflows/simulation.yml`:

1. `cargo run -- run-all` runs all scenarios and outputs reports
2. `python3 scripts/check_budget_warnings.py` reads the reports and fails the job if any scenario has a critical budget warning (>= 100% utilization)

The `scripts/simulate.ts` harness wraps the simulator for use in TypeScript/Node.js tooling and mirrors the Python script's budget check.

## Development

### Adding a New Scenario

1. Create `tools/sim/src/scenarios/my_scenario.json`
2. Define actors, governor settings, and steps
3. Run `cargo run --manifest-path tools/sim/Cargo.toml -- validate tools/sim/src/scenarios/my_scenario.json`
4. Test with `cargo run --manifest-path tools/sim/Cargo.toml -- run --scenario tools/sim/src/scenarios/my_scenario.json --verbose`

### Debugging

Use `--verbose` to see per-step CPU/memory/storage metrics:

```bash
cargo run --manifest-path tools/sim/Cargo.toml -- run \
  --scenario tools/sim/src/scenarios/my_scenario.json \
  --verbose
```

Read the JSON report with `jq`:

```bash
jq '.compute_budget_warnings' report.json
jq '.step_results[] | select(.success == false)' report.json
```

### Testing the Simulator

```bash
cargo test --manifest-path tools/sim/Cargo.toml
```
