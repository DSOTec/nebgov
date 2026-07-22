//! Structured output of a simulation run: per-step results plus aggregate
//! counters and budget/storage warnings, all serializable to JSON so CI can
//! diff reports across runs (see `scripts/check_budget_warnings.py`).

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct SimulationReport {
    pub scenario_name: String,
    pub total_steps: usize,
    pub passed_steps: usize,
    pub failed_steps: usize,
    pub final_ledger: u32,
    pub proposals_created: u64,
    pub proposals_executed: u64,
    pub proposals_defeated: u64,
    pub total_votes_cast: u64,
    pub step_results: Vec<StepResult>,
    pub compute_budget_warnings: Vec<BudgetWarning>,
    pub storage_warnings: Vec<StorageWarning>,
}

impl SimulationReport {
    pub fn new(scenario_name: String) -> Self {
        Self {
            scenario_name,
            total_steps: 0,
            passed_steps: 0,
            failed_steps: 0,
            final_ledger: 0,
            proposals_created: 0,
            proposals_executed: 0,
            proposals_defeated: 0,
            total_votes_cast: 0,
            step_results: Vec::new(),
            compute_budget_warnings: Vec::new(),
            storage_warnings: Vec::new(),
        }
    }

    pub fn record(&mut self, result: StepResult) {
        self.total_steps += 1;
        if result.success {
            self.passed_steps += 1;
        } else {
            self.failed_steps += 1;
        }

        let utilization_pct = 100.0 * result.cpu_insns as f64 / CPU_INSN_BUDGET as f64;
        if utilization_pct >= BUDGET_WARNING_THRESHOLD_PCT {
            self.compute_budget_warnings.push(BudgetWarning {
                step_index: result.step_index,
                cpu_insns: result.cpu_insns,
                budget_limit: CPU_INSN_BUDGET,
                utilization_pct,
            });
        }

        let storage_utilization_pct =
            100.0 * result.storage_entries_written as f64 / STORAGE_WRITE_WARNING_THRESHOLD as f64;
        if result.storage_entries_written >= STORAGE_WRITE_WARNING_THRESHOLD {
            self.storage_warnings.push(StorageWarning {
                step_index: result.step_index,
                entries_written: result.storage_entries_written,
                utilization_pct: storage_utilization_pct,
            });
        }

        self.step_results.push(result);
    }
}

/// Soroban Mainnet's per-transaction CPU instruction budget, used purely as
/// a reference ceiling for [`BudgetWarning`] utilization percentages — the
/// simulator runs off-chain and isn't actually metered against it.
pub const CPU_INSN_BUDGET: u64 = 100_000_000;
/// Emit a [`BudgetWarning`] once a step's estimated CPU usage crosses this
/// fraction of [`CPU_INSN_BUDGET`].
pub const BUDGET_WARNING_THRESHOLD_PCT: f64 = 80.0;
/// Emit a [`StorageWarning`] once a single step writes at least this many
/// storage entries (a proxy for unbounded-growth patterns like `DraftList`
/// or `ProposalList`).
pub const STORAGE_WRITE_WARNING_THRESHOLD: u32 = 50;

#[derive(Debug, Clone, Serialize)]
pub struct StepResult {
    pub step_index: usize,
    pub step_type: String,
    pub ledger: u32,
    pub success: bool,
    pub error: Option<String>,
    pub cpu_insns: u64,
    pub mem_bytes: u64,
    pub storage_entries_read: u32,
    pub storage_entries_written: u32,
    pub duration_ms: u64,
    /// Set post-hoc when a later `ExpectError` step confirms this step's
    /// failure was anticipated — such steps are excluded from
    /// `SimulationReport::failed_steps` since the scenario correctly
    /// predicted and validated them; `success` still faithfully records
    /// that the underlying contract call did fail.
    pub anticipated_failure: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct BudgetWarning {
    pub step_index: usize,
    pub cpu_insns: u64,
    pub budget_limit: u64,
    pub utilization_pct: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct StorageWarning {
    pub step_index: usize,
    pub entries_written: u32,
    pub utilization_pct: f64,
}
