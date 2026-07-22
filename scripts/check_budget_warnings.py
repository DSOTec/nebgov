#!/usr/bin/env python3
"""Check a tools/sim simulation report for compute/storage budget issues.

Usage: python3 scripts/check_budget_warnings.py <report.json> [...]

Exit codes:
  0 - no warnings, or only advisory warnings (utilization < 100%)
  1 - at least one step's recorded cpu_insns met or exceeded the reference
      CPU_INSN_BUDGET (tools/sim/src/report.rs) — i.e. it would actually
      fail on-chain, not just approach the limit
"""

import json
import sys


def check_report(path: str) -> bool:
    """Print a summary for one report file; return True if it's CI-clean."""
    with open(path) as f:
        report = json.load(f)

    scenario = report.get("scenario_name", path)
    budget_warnings = report.get("compute_budget_warnings", [])
    storage_warnings = report.get("storage_warnings", [])

    if not budget_warnings and not storage_warnings:
        print(f"[{scenario}] no budget warnings")
        return True

    ok = True
    for w in budget_warnings:
        pct = w["utilization_pct"]
        severity = "CRITICAL" if pct >= 100.0 else "warning"
        print(
            f"[{scenario}] {severity}: step {w['step_index']} used "
            f"{w['cpu_insns']}/{w['budget_limit']} cpu insns ({pct:.1f}%)"
        )
        if pct >= 100.0:
            ok = False

    for w in storage_warnings:
        print(
            f"[{scenario}] storage warning: step {w['step_index']} wrote "
            f"{w['entries_written']} storage entries ({w['utilization_pct']:.1f}% of threshold)"
        )

    return ok


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 1

    all_ok = True
    for path in sys.argv[1:]:
        try:
            if not check_report(path):
                all_ok = False
        except (OSError, json.JSONDecodeError) as e:
            print(f"error reading {path}: {e}", file=sys.stderr)
            all_ok = False

    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
