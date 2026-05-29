# Performance Benchmarks

## Contract Load Tests

### Governor: 1,000 Votes on Single Proposal

| Metric | Value | Threshold | Status |
|--------|-------|-----------|--------|
| Total time | — | < 5,000 ms | — |
| Avg time per vote | — | — | — |

**Test:** `load_test_1000_votes` in `contracts/governor/src/tests/load_tests.rs`

### Governor: 100 Votes Across 5 Proposals

| Metric | Value | Threshold | Status |
|--------|-------|-----------|--------|
| Total time | — | < 5,000 ms | — |
| Proposals remain Active | — | All Active | — |

**Test:** `load_test_concurrent_votes_round_robin` in `contracts/governor/src/tests/load_tests.rs`

## SDK Load Tests

### `getProposal()`: 500 Concurrent Calls

| Metric | Value | Threshold | Status |
|--------|-------|-----------|--------|
| Total time | — | < 10,000 ms | — |
| All requests succeed | — | 100% | — |

**Test:** `handles 500 concurrent getProposal() calls`

## Frontend Performance Tests

### Proposal List: 100 Proposals Render

| Metric | Value | Threshold | Status |
|--------|-------|-----------|--------|
| Render time | — | < 2,000 ms | — |

**Test:** `proposal list renders 100 proposals in < 2s`

---

## Running Benchmarks

### Contract Benchmarks

```bash
cd contracts
cargo test --test load_test_1000_votes -- --nocapture
cargo test --test load_test_concurrent_votes_round_robin -- --nocapture
```

### SDK Benchmarks

```bash
cd packages/sdk
pnpm test -- --testPathPattern="load"
```

### Frontend Benchmarks

```bash
cd app
pnpm test:e2e -- --grep "renders 100 proposals"
```

---

## Threshold Configuration

Thresholds are defined as constants in each test file:

- **Vote budget:** 5,000 ms (`VOTE_BUDGET_MS` in `load_tests.rs`)
- **SDK response budget:** 10,000 ms
- **Frontend render budget:** 2,000 ms

Override via environment variables:

```bash
VOTE_BUDGET_MS=3000 cargo test load_test_1000_votes
```
