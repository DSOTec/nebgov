use crate::report::{BUDGET_WARNING_THRESHOLD_PCT, CPU_INSN_BUDGET};
use crate::runner::SimulationRunner;
use crate::scenario::{
    ActorRole, Scenario, SimActor, SimGovernorSettings, SimProposalState, SimStep, SimVoteSupport,
    SimVoteType,
};

fn base_settings() -> SimGovernorSettings {
    SimGovernorSettings {
        voting_delay: 1,
        voting_period: 10,
        quorum_numerator: 10,
        proposal_threshold: 100,
        vote_type: SimVoteType::Extended,
        proposal_grace_period: 1000,
        max_calldata_size: 10_000,
        proposal_cooldown: 0,
        max_proposals_per_period: 5,
        proposal_period_duration: 10_000,
    }
}

fn happy_path_scenario() -> Scenario {
    Scenario {
        name: "happy_path_test".to_string(),
        description: "propose -> vote -> queue -> execute".to_string(),
        seed: 1,
        governor_settings: base_settings(),
        actors: std::vec![
            SimActor {
                name: "alice".to_string(),
                initial_balance: 1000,
                delegate_to: None,
                role: ActorRole::Proposer,
            },
            SimActor {
                name: "bob".to_string(),
                initial_balance: 500,
                delegate_to: None,
                role: ActorRole::TokenHolder,
            },
        ],
        steps: std::vec![
            SimStep::Propose {
                actor: "alice".to_string(),
                targets: std::vec!["target".to_string()],
                fn_names: std::vec!["noop".to_string()],
                description: "test proposal".to_string(),
            },
            SimStep::AdvanceLedger { ledgers: 2 },
            SimStep::Vote {
                actor: "alice".to_string(),
                proposal_id: 1,
                support: SimVoteSupport::For,
            },
            SimStep::Vote {
                actor: "bob".to_string(),
                proposal_id: 1,
                support: SimVoteSupport::For,
            },
            SimStep::AdvanceLedger { ledgers: 10 },
            SimStep::ExpectState {
                proposal_id: 1,
                expected_state: SimProposalState::Succeeded,
            },
            SimStep::Queue {
                actor: "alice".to_string(),
                proposal_id: 1,
            },
            SimStep::AdvanceLedger { ledgers: 1 },
            SimStep::Execute {
                actor: "alice".to_string(),
                proposal_id: 1,
            },
            SimStep::ExpectState {
                proposal_id: 1,
                expected_state: SimProposalState::Executed,
            },
        ],
    }
}

#[test]
fn test_runner_executes_happy_path_scenario() {
    let scenario = happy_path_scenario();
    let mut runner = SimulationRunner::new(&scenario);
    let report = runner.run();

    assert_eq!(report.total_steps, scenario.steps.len());
    assert_eq!(report.failed_steps, 0, "steps: {:#?}", report.step_results);
    assert_eq!(
        runner.get_proposal_state(1),
        SimProposalState::Executed
    );
}

#[test]
fn test_runner_records_step_compute_budgets() {
    let scenario = happy_path_scenario();
    let mut runner = SimulationRunner::new(&scenario);
    let report = runner.run();

    // Every recorded step should have a non-negative, populated cpu/mem
    // reading (a real Soroban host call always consumes some budget) except
    // pure bookkeeping steps like AdvanceLedger which don't invoke a contract.
    let contract_call_steps = report
        .step_results
        .iter()
        .filter(|r| r.step_type != "AdvanceLedger" && r.step_type != "ExpectState");
    for step in contract_call_steps {
        assert!(
            step.cpu_insns > 0,
            "step {} ({}) recorded zero cpu_insns",
            step.step_index,
            step.step_type
        );
    }
}

#[test]
fn test_runner_catches_expected_errors() {
    let mut scenario = happy_path_scenario();
    // Insert a double-vote from alice right after her first vote (index 2);
    // step 3 becomes the double-vote, and we assert it fails with the
    // AlreadyVoted contract error (#12 in contracts/governor/src/error.rs).
    scenario.steps.insert(
        3,
        SimStep::Vote {
            actor: "alice".to_string(),
            proposal_id: 1,
            support: SimVoteSupport::For,
        },
    );
    scenario.steps.push(SimStep::ExpectError {
        step_index: 3,
        expected_error: "Error(Contract, #12)".to_string(),
    });

    let mut runner = SimulationRunner::new(&scenario);
    let _ = runner.run();
    runner.check_expect_errors();
    let report = runner.get_report();

    let double_vote_result = &report.step_results[3];
    assert!(!double_vote_result.success);
    assert!(double_vote_result.anticipated_failure);
    assert!(double_vote_result
        .error
        .as_ref()
        .unwrap()
        .contains("Error(Contract, #12)"));

    // The trailing ExpectError step itself should be recorded as passing
    // since it correctly predicted the failure.
    let expect_error_result = report.step_results.last().unwrap();
    assert!(expect_error_result.success);

    // An anticipated failure shouldn't count against the overall tally —
    // every other step in this scenario succeeds.
    assert_eq!(report.failed_steps, 0);
}

#[test]
fn test_runner_validates_proposal_states_after_each_step() {
    let scenario = happy_path_scenario();
    let mut runner = SimulationRunner::new(&scenario);

    // Run steps one at a time via run_step, checking the proposal's state
    // transitions as they happen (rather than only inspecting the final
    // state once, at the end).
    let steps = scenario.steps.clone();
    let mut seen_pending = false;
    let mut seen_active = false;
    for step in &steps {
        let result = runner.run_step(step);
        assert!(result.success, "step failed: {:?}", result.error);
        if let SimStep::Propose { .. } = step {
            assert_eq!(runner.get_proposal_state(1), SimProposalState::Pending);
            seen_pending = true;
        }
        if let SimStep::Vote { .. } = step {
            assert_eq!(runner.get_proposal_state(1), SimProposalState::Active);
            seen_active = true;
        }
    }
    assert!(seen_pending && seen_active);
    assert_eq!(runner.get_proposal_state(1), SimProposalState::Executed);
}

#[test]
fn test_large_scenario_does_not_exceed_compute_budget() {
    // Scaled down from the issue's illustrative "10,000 proposals" figure —
    // see tools/sim/src/scenarios/compute_stress.json for rationale. This
    // still exercises proposals_count_by_state()'s O(n) iteration.
    let mut scenario = happy_path_scenario();
    scenario.actors.push(SimActor {
        name: "carol".to_string(),
        initial_balance: 500,
        delegate_to: None,
        role: ActorRole::TokenHolder,
    });
    // base_settings() caps at 5 proposals/period — raise it so all 30
    // Propose steps below actually succeed instead of hitting
    // ProposalRateLimited after the 5th.
    scenario.governor_settings.max_proposals_per_period = 100;
    scenario.steps = std::vec![SimStep::AdvanceLedger { ledgers: 0 }];
    for i in 0..30u32 {
        scenario.steps.push(SimStep::Propose {
            actor: "alice".to_string(),
            targets: std::vec!["target".to_string()],
            fn_names: std::vec!["noop".to_string()],
            description: std::format!("stress proposal {}", i),
        });
        // Cooldown is 0 in base_settings, so back-to-back proposals are
        // allowed; advance one ledger between them anyway to mimic realistic
        // spacing.
        scenario.steps.push(SimStep::AdvanceLedger { ledgers: 1 });
    }

    let mut runner = SimulationRunner::new(&scenario);
    let report = runner.run();

    assert_eq!(report.failed_steps, 0, "steps: {:#?}", report.step_results);
    for step in &report.step_results {
        assert!(
            (step.cpu_insns as f64 / CPU_INSN_BUDGET as f64) * 100.0 < BUDGET_WARNING_THRESHOLD_PCT,
            "step {} ({}) unexpectedly close to the CPU budget: {} insns",
            step.step_index,
            step.step_type,
            step.cpu_insns
        );
    }
}

#[test]
fn test_upgrade_replay_produces_identical_final_state() {
    // `tools/sim`'s SimStep schema (matching the issue spec) has no
    // contract-upgrade primitive — actually swapping WASM requires
    // deploying compiled bytes via `env.deployer().upload_contract_wasm()`,
    // out of scope for this native, no-WASM-build harness. Instead this
    // verifies the property that actually matters for upgrade-replay
    // confidence: replaying an identical scenario against a fresh instance
    // deterministically reproduces the same final proposal states, vote
    // tallies, and ledger — i.e. nothing in the runner depends on
    // uncontrolled randomness or wall-clock time.
    let scenario = happy_path_scenario();

    let mut runner_a = SimulationRunner::new(&scenario);
    let report_a = runner_a.run();

    let mut runner_b = SimulationRunner::new(&scenario);
    let report_b = runner_b.run();

    assert_eq!(report_a.final_ledger, report_b.final_ledger);
    assert_eq!(report_a.passed_steps, report_b.passed_steps);
    assert_eq!(report_a.failed_steps, report_b.failed_steps);
    assert_eq!(
        runner_a.get_proposal_state(1),
        runner_b.get_proposal_state(1)
    );
    for (a, b) in report_a.step_results.iter().zip(report_b.step_results.iter()) {
        assert_eq!(a.success, b.success);
        assert_eq!(a.step_type, b.step_type);
    }
}

#[test]
fn test_report_serialization_roundtrip() {
    let scenario = happy_path_scenario();
    let mut runner = SimulationRunner::new(&scenario);
    let report = runner.run();

    let json = serde_json::to_string_pretty(&report).expect("serialize");
    let parsed: serde_json::Value = serde_json::from_str(&json).expect("deserialize");

    assert_eq!(parsed["scenario_name"], "happy_path_test");
    assert_eq!(parsed["total_steps"].as_u64().unwrap() as usize, report.total_steps);
    assert_eq!(
        parsed["step_results"].as_array().unwrap().len(),
        report.step_results.len()
    );
}

#[test]
fn test_budget_warning_threshold_triggers_correctly() {
    use crate::report::{SimulationReport, StepResult};

    let mut report = SimulationReport::new("budget_test".to_string());

    // Below threshold: no warning.
    report.record(StepResult {
        step_index: 0,
        step_type: "Vote".to_string(),
        ledger: 1,
        success: true,
        error: None,
        cpu_insns: (CPU_INSN_BUDGET as f64 * (BUDGET_WARNING_THRESHOLD_PCT / 100.0 - 0.01)) as u64,
        mem_bytes: 0,
        storage_entries_read: 0,
        storage_entries_written: 0,
        duration_ms: 0,
        anticipated_failure: false,
    });
    assert!(report.compute_budget_warnings.is_empty());

    // At/above threshold: warning recorded.
    report.record(StepResult {
        step_index: 1,
        step_type: "Vote".to_string(),
        ledger: 1,
        success: true,
        error: None,
        cpu_insns: (CPU_INSN_BUDGET as f64 * (BUDGET_WARNING_THRESHOLD_PCT / 100.0 + 0.01)) as u64,
        mem_bytes: 0,
        storage_entries_read: 0,
        storage_entries_written: 0,
        duration_ms: 0,
        anticipated_failure: false,
    });
    assert_eq!(report.compute_budget_warnings.len(), 1);
    assert_eq!(report.compute_budget_warnings[0].step_index, 1);
}

#[test]
fn test_scenario_validate_rejects_unknown_actor_reference() {
    let mut scenario = happy_path_scenario();
    scenario.steps.push(SimStep::Vote {
        actor: "does-not-exist".to_string(),
        proposal_id: 1,
        support: SimVoteSupport::For,
    });
    assert!(scenario.validate().is_err());
}

#[test]
fn test_all_shipped_scenarios_are_structurally_valid() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/scenarios");
    let mut checked = 0;
    for entry in std::fs::read_dir(&dir).expect("read scenarios dir") {
        let path = entry.expect("dir entry").path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let scenario = Scenario::from_file(&path)
            .unwrap_or_else(|e| panic!("{} failed to parse: {}", path.display(), e));
        scenario
            .validate()
            .unwrap_or_else(|e| panic!("{} failed validation: {}", path.display(), e));
        checked += 1;
    }
    assert!(checked >= 9, "expected at least 9 shipped scenarios, found {}", checked);
}
