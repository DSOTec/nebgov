//! Drives a real governor/timelock/token-votes/treasury stack (registered
//! natively in an in-process [`Env`], not compiled to WASM) through a
//! [`Scenario`]'s steps, recording a [`SimulationReport`].
//!
//! Contract calls that are expected to fail (e.g. a double-vote, or a
//! proposal below quorum being queued) panic inside the Soroban test host
//! rather than returning a `Result` — the runner wraps each step in
//! `catch_unwind` to turn that into a `StepResult { success: false, .. }`
//! instead of aborting the whole simulation.

use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::time::Instant;

use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{token, Address, Bytes, Env, String as SorobanString, Symbol, Vec as SorobanVec};

use sorogov_governor::{
    GovernorContract, GovernorContractClient, GovernorSettings, ProposalState, VoteSupport,
    VoteType,
};
use sorogov_timelock::{TimelockContract, TimelockContractClient};
use sorogov_token_votes::{TokenVotesContract, TokenVotesContractClient};
use sorogov_treasury::{TreasuryContract, TreasuryContractClient};

use crate::report::{SimulationReport, StepResult};
use crate::scenario::{
    ActorRole, Scenario, SimGovernorSettings, SimProposalState, SimStep, SimVoteSupport,
    SimVoteType,
};

/// A no-op target contract used to resolve `SimStep::Propose` targets that
/// don't name a special contract (`"treasury"`, `"governor"`) — this tool's
/// job is to exercise the governor's proposal lifecycle and rate limits,
/// not to be a general arbitrary-calldata executor (that's already covered
/// by `contracts/governor/src/tests/integration.rs`). Scenario JSON should
/// use `fn_names: ["noop"]` when targeting an arbitrary/placeholder
/// contract.
#[soroban_sdk::contract]
pub struct SimTargetContract;

#[soroban_sdk::contractimpl]
impl SimTargetContract {
    pub fn noop(_env: Env) {}
}

/// Must match `GovernorContract::SECONDS_PER_LEDGER` in
/// `contracts/governor/src/lib.rs`.
const SECONDS_PER_LEDGER: u64 = 5;

pub struct SimulationRunner {
    env: Env,
    scenario: Scenario,
    governor: GovernorContractClient<'static>,
    #[allow(dead_code)]
    timelock: TimelockContractClient<'static>,
    token_votes: TokenVotesContractClient<'static>,
    #[allow(dead_code)]
    treasury: TreasuryContractClient<'static>,
    token: Address,
    target: Address,
    treasury_addr: Address,
    actors: HashMap<String, Address>,
    report: SimulationReport,
}

impl SimulationRunner {
    pub fn new(scenario: &Scenario) -> Self {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_sequence_number(1);

        // Pick the on-chain admin/pauser: prefer an actor explicitly cast as
        // Admin, then Pauser (initialize() makes admin the initial pauser),
        // else synthesize one not tied to any named actor.
        let admin_actor = scenario
            .actors
            .iter()
            .find(|a| a.role == ActorRole::Admin)
            .or_else(|| scenario.actors.iter().find(|a| a.role == ActorRole::Pauser));

        let mut actors: HashMap<String, Address> = HashMap::new();
        for actor in &scenario.actors {
            actors.insert(actor.name.clone(), Address::generate(&env));
        }
        let admin = admin_actor
            .map(|a| actors[&a.name].clone())
            .unwrap_or_else(|| Address::generate(&env));

        let guardian_actor = scenario.actors.iter().find(|a| a.role == ActorRole::Guardian);
        let guardian = guardian_actor
            .map(|a| actors[&a.name].clone())
            .unwrap_or_else(|| Address::generate(&env));

        let token = env.register_stellar_asset_contract_v2(admin.clone()).address();

        let token_votes_id = env.register(TokenVotesContract, ());
        let token_votes = TokenVotesContractClient::new(&env, &token_votes_id);
        token_votes.initialize(&admin, &token);

        let governor_id = env.register(GovernorContract, ());
        let timelock_id = env.register(TimelockContract, ());

        let timelock = TimelockContractClient::new(&env, &timelock_id);
        timelock.initialize(&admin, &governor_id, &1u64, &60u64);

        let governor = GovernorContractClient::new(&env, &governor_id);
        governor.initialize(
            &admin,
            &token_votes_id,
            &timelock_id,
            &scenario.governor_settings.voting_delay,
            &scenario.governor_settings.voting_period,
            &scenario.governor_settings.quorum_numerator,
            &scenario.governor_settings.proposal_threshold,
            &guardian,
            &sim_vote_type(scenario.governor_settings.vote_type),
            &scenario.governor_settings.proposal_grace_period,
        );
        governor.set_initial_config(
            &admin,
            &scenario.governor_settings.max_calldata_size,
            &scenario.governor_settings.proposal_cooldown,
            &scenario.governor_settings.max_proposals_per_period,
        );

        let treasury_owners = SorobanVec::from_array(&env, [admin.clone()]);
        let treasury_id = env.register(TreasuryContract, ());
        let treasury = TreasuryContractClient::new(&env, &treasury_id);
        treasury.initialize(&treasury_owners, &1u32, &governor_id);

        let target = env.register(SimTargetContract, ());

        let sac = token::StellarAssetClient::new(&env, &token);
        for actor in &scenario.actors {
            let addr = &actors[&actor.name];
            if actor.initial_balance > 0 {
                sac.mint(addr, &actor.initial_balance);
            }
            let delegatee = actor
                .delegate_to
                .as_ref()
                .map(|d| actors[d].clone())
                .unwrap_or_else(|| addr.clone());
            token_votes.delegate(addr, &delegatee);
        }

        let report = SimulationReport::new(scenario.name.clone());

        Self {
            env,
            scenario: scenario.clone(),
            governor,
            timelock,
            token_votes,
            treasury,
            token,
            target,
            treasury_addr: treasury_id,
            actors,
            report,
        }
    }

    pub fn get_actor(&self, name: &str) -> &Address {
        self.actors
            .get(name)
            .unwrap_or_else(|| panic!("unknown actor '{}'", name))
    }

    pub fn get_proposal_state(&self, proposal_id: u64) -> SimProposalState {
        from_proposal_state(self.governor.state(&proposal_id))
    }

    /// Advance both ledger sequence and timestamp to stay consistent with
    /// `SECONDS_PER_LEDGER` in `contracts/governor/src/lib.rs` — the
    /// timelock's readiness check is timestamp-based, so advancing sequence
    /// alone would leave queued proposals permanently un-executable.
    pub fn advance_to_ledger(&mut self, target: u32) {
        let current = self.env.ledger().sequence();
        if target > current {
            let delta_seconds = (target - current) as u64 * SECONDS_PER_LEDGER;
            self.env.ledger().set_sequence_number(target);
            self.env
                .ledger()
                .set_timestamp(self.env.ledger().timestamp() + delta_seconds);
        }
    }

    /// Resolve a `SimStep::Propose` target string to a real deployed
    /// address: `"treasury"` / `"governor"` name the corresponding
    /// contract, `"target"` (or any other unrecognized name) resolves to
    /// the harness's [`SimTargetContract`], and anything matching a
    /// declared actor resolves to that actor's address.
    fn resolve_target(&self, name: &str) -> Address {
        match name {
            "treasury" => self.treasury_addr.clone(),
            "governor" => self.governor.address.clone(),
            "target" => self.target.clone(),
            other => self.actors.get(other).cloned().unwrap_or_else(|| self.target.clone()),
        }
    }

    /// Run every step in the scenario in order, returning the final report.
    /// Individual step failures are recorded, not propagated — a scenario
    /// documenting an expected failure (via a following `ExpectError` step)
    /// should keep running.
    pub fn run(&mut self) -> SimulationReport {
        for i in 0..self.scenario.steps.len() {
            let step = self.scenario.steps[i].clone();
            let result = self.run_step_indexed(i, &step);
            self.report.record(result);
        }
        self.report.final_ledger = self.env.ledger().sequence();
        self.report.clone()
    }

    /// Run a single step outside of [`Self::run`]'s scenario loop — part of
    /// the granular step-by-step control surface (used by tests that need
    /// to assert on intermediate state between steps; `cargo clippy`'s
    /// non-test bin target can't see those `#[cfg(test)]` call sites).
    #[allow(dead_code)]
    pub fn run_step(&mut self, step: &crate::scenario::SimStep) -> StepResult {
        self.run_step_indexed(self.report.total_steps, step)
    }

    fn run_step_indexed(&mut self, index: usize, step: &SimStep) -> StepResult {
        self.env.cost_estimate().budget().reset_default();
        let start = Instant::now();

        let outcome: Result<(), String> = catch_unwind(AssertUnwindSafe(|| {
            self.dispatch(step);
        }))
        .map_err(panic_message);

        let duration_ms = start.elapsed().as_millis() as u64;
        let cpu_insns = self.env.cost_estimate().budget().cpu_instruction_cost();
        let mem_bytes = self.env.cost_estimate().budget().memory_bytes_cost();

        let success = outcome.is_ok();
        let error = outcome.err();

        StepResult {
            step_index: index,
            step_type: step.kind().to_string(),
            ledger: self.env.ledger().sequence(),
            success,
            error,
            cpu_insns,
            mem_bytes,
            // The soroban-sdk test host doesn't expose per-call storage
            // read/write counts directly; a rough per-step-kind estimate is
            // used here as a placeholder signal for storage_warnings rather
            // than a precise count.
            storage_entries_read: estimated_storage_touches(step).0,
            storage_entries_written: estimated_storage_touches(step).1,
            duration_ms,
            anticipated_failure: false,
        }
    }

    fn dispatch(&mut self, step: &SimStep) {
        match step {
            SimStep::AdvanceLedger { ledgers } => {
                let target = self.env.ledger().sequence() + ledgers;
                self.advance_to_ledger(target);
            }
            SimStep::Propose {
                actor,
                targets,
                fn_names,
                description,
            } => {
                let proposer = self.get_actor(actor).clone();
                let targets: SorobanVec<Address> = {
                    let mut v = SorobanVec::new(&self.env);
                    for t in targets {
                        v.push_back(self.resolve_target(t));
                    }
                    v
                };
                let fn_names_vec: SorobanVec<Symbol> = {
                    let mut v = SorobanVec::new(&self.env);
                    for f in fn_names {
                        v.push_back(Symbol::new(&self.env, f));
                    }
                    v
                };
                let mut calldatas: SorobanVec<Bytes> = SorobanVec::new(&self.env);
                for _ in 0..targets.len() {
                    calldatas.push_back(Bytes::new(&self.env));
                }
                let desc = SorobanString::from_str(&self.env, description);
                let desc_hash = self.env.crypto().sha256(&Bytes::new(&self.env)).into();
                let metadata_uri = SorobanString::from_str(&self.env, "");
                self.governor.propose(
                    &proposer,
                    &desc,
                    &desc_hash,
                    &metadata_uri,
                    &targets,
                    &fn_names_vec,
                    &calldatas,
                );
            }
            SimStep::Vote {
                actor,
                proposal_id,
                support,
            } => {
                let voter = self.get_actor(actor).clone();
                self.governor.cast_vote(&voter, proposal_id, &sim_vote_support(*support));
                self.report.total_votes_cast += 1;
            }
            SimStep::Queue { proposal_id, .. } => {
                self.governor.queue(proposal_id);
            }
            SimStep::Execute { proposal_id, .. } => {
                self.governor.execute(proposal_id);
                self.report.proposals_executed += 1;
            }
            SimStep::Cancel { actor, proposal_id } => {
                let caller = self.get_actor(actor).clone();
                self.governor.cancel(&caller, proposal_id);
            }
            SimStep::Delegate { actor, delegatee } => {
                let delegator = self.get_actor(actor).clone();
                let delegatee_addr = self.get_actor(delegatee).clone();
                self.token_votes.delegate(&delegator, &delegatee_addr);
            }
            SimStep::MintTokens { actor, amount } => {
                let addr = self.get_actor(actor).clone();
                token::StellarAssetClient::new(&self.env, &self.token).mint(&addr, amount);
                let balance = token::TokenClient::new(&self.env, &self.token).balance(&addr);
                self.token_votes.checkpoint(&addr, &balance);
            }
            SimStep::BurnTokens { actor, amount } => {
                let addr = self.get_actor(actor).clone();
                token::StellarAssetClient::new(&self.env, &self.token).clawback(&addr, amount);
                let balance = token::TokenClient::new(&self.env, &self.token).balance(&addr);
                self.token_votes.checkpoint(&addr, &balance);
            }
            SimStep::UpdateConfig { settings, .. } => {
                // `update_config` requires `env.current_contract_address().require_auth()`
                // — satisfied automatically by `env.mock_all_auths()` from setup.
                let current = self.governor.get_settings();
                let new_settings = merge_settings(&current, settings);
                self.governor.update_config(&new_settings);
            }
            SimStep::PauseContract { actor } => {
                let caller = self.get_actor(actor).clone();
                self.governor.pause(&caller);
            }
            SimStep::UnpauseContract { actor } => {
                let caller = self.get_actor(actor).clone();
                self.governor.unpause(&caller);
            }
            SimStep::ExpectState {
                proposal_id,
                expected_state,
            } => {
                let actual = self.get_proposal_state(*proposal_id);
                if actual != *expected_state {
                    panic!(
                        "expected proposal #{} to be {:?}, was {:?}",
                        proposal_id, expected_state, actual
                    );
                }
            }
            SimStep::ExpectError { .. } => {
                // Evaluated post-hoc by the caller (see `check_expect_errors`)
                // against the recorded result of `step_index`, since it
                // needs to inspect a *different* step's outcome rather than
                // perform an action of its own.
            }
            SimStep::TakeAnalyticsSnapshot => {
                self.report.proposals_created = self.governor.proposal_count();
                // Exercises `proposals_count_by_state()`'s O(proposal_count)
                // iteration so its cost shows up in this step's recorded
                // cpu_insns — see `scenarios/compute_stress.json`.
                let counts = self.governor.proposals_count_by_state();
                self.report.proposals_executed = counts.executed;
                self.report.proposals_defeated = counts.defeated;
            }
            SimStep::AssertParticipation {
                proposal_id,
                min_bps,
            } => {
                let (for_v, against_v, abstain_v) = self.governor.proposal_votes(proposal_id);
                let total_cast = for_v + against_v + abstain_v;
                let proposal = self.governor.get_proposal(proposal_id);
                let supply = self
                    .token_votes
                    .get_past_total_supply(&proposal.start_ledger);
                let bps = if supply > 0 {
                    (total_cast.saturating_mul(10_000) / supply) as u32
                } else {
                    0
                };
                if bps < *min_bps {
                    panic!(
                        "participation {}bps below minimum {}bps for proposal #{}",
                        bps, min_bps, proposal_id
                    );
                }
            }
            SimStep::AssertQuorumReached { proposal_id } => {
                if !self.governor.is_quorum_reached(proposal_id) {
                    panic!("quorum not reached for proposal #{}", proposal_id);
                }
            }
        }
    }

    /// Post-process `ExpectError` steps against already-recorded results —
    /// they assert on a *prior* step's outcome, so they can't be resolved
    /// during `dispatch` (which only sees the current step).
    pub fn check_expect_errors(&mut self) {
        let checks: std::vec::Vec<(usize, usize, String)> = self
            .scenario
            .steps
            .iter()
            .enumerate()
            .filter_map(|(i, s)| match s {
                SimStep::ExpectError {
                    step_index,
                    expected_error,
                } => Some((i, *step_index, expected_error.clone())),
                _ => None,
            })
            .collect();

        for (check_step_idx, target_step_idx, expected) in checks {
            let Some(target_result) = self.report.step_results.get(target_step_idx) else {
                continue;
            };
            let target_error = target_result.error.clone();
            let target_was_failure = !target_result.success;
            let matches = target_error
                .as_ref()
                .map(|e| e.contains(&expected))
                .unwrap_or(false);

            if matches && target_was_failure {
                // The target step's failure was anticipated and validated —
                // exclude it from the failure tally (its `success` field
                // stays false, since it factually did fail).
                if let Some(target) = self.report.step_results.get_mut(target_step_idx) {
                    if !target.anticipated_failure {
                        target.anticipated_failure = true;
                        self.report.failed_steps = self.report.failed_steps.saturating_sub(1);
                        self.report.passed_steps += 1;
                    }
                }
            }

            if let Some(check_result) = self.report.step_results.get_mut(check_step_idx) {
                if !matches {
                    check_result.success = false;
                    check_result.error = Some(format!(
                        "expected step {} to fail with an error containing '{}', got {:?}",
                        target_step_idx, expected, target_error
                    ));
                    self.report.failed_steps += 1;
                    self.report.passed_steps = self.report.passed_steps.saturating_sub(1);
                }
            }
        }
    }

    pub fn get_report(&self) -> &SimulationReport {
        &self.report
    }
}

fn panic_message(e: std::boxed::Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = e.downcast_ref::<&str>() {
        s.to_string()
    } else if let Some(s) = e.downcast_ref::<std::string::String>() {
        s.clone()
    } else {
        "unknown panic".to_string()
    }
}

fn sim_vote_type(t: SimVoteType) -> VoteType {
    match t {
        SimVoteType::Simple => VoteType::Simple,
        SimVoteType::Extended => VoteType::Extended,
        SimVoteType::Quadratic => VoteType::Quadratic,
    }
}

fn sim_vote_support(s: SimVoteSupport) -> VoteSupport {
    match s {
        SimVoteSupport::Against => VoteSupport::Against,
        SimVoteSupport::For => VoteSupport::For,
        SimVoteSupport::Abstain => VoteSupport::Abstain,
    }
}

fn from_proposal_state(s: ProposalState) -> SimProposalState {
    match s {
        ProposalState::Pending => SimProposalState::Pending,
        ProposalState::Active => SimProposalState::Active,
        ProposalState::Defeated => SimProposalState::Defeated,
        ProposalState::Succeeded => SimProposalState::Succeeded,
        ProposalState::Queued => SimProposalState::Queued,
        ProposalState::Executed => SimProposalState::Executed,
        ProposalState::Cancelled => SimProposalState::Cancelled,
        ProposalState::Expired => SimProposalState::Expired,
    }
}

fn merge_settings(current: &GovernorSettings, overrides: &SimGovernorSettings) -> GovernorSettings {
    GovernorSettings {
        voting_delay: overrides.voting_delay,
        voting_period: overrides.voting_period,
        quorum_numerator: overrides.quorum_numerator,
        proposal_threshold: overrides.proposal_threshold,
        guardian: current.guardian.clone(),
        vote_type: sim_vote_type(overrides.vote_type),
        proposal_grace_period: overrides.proposal_grace_period,
        use_dynamic_quorum: current.use_dynamic_quorum,
        reflector_oracle: current.reflector_oracle.clone(),
        min_quorum_usd: current.min_quorum_usd,
        max_calldata_size: overrides.max_calldata_size,
        proposal_cooldown: overrides.proposal_cooldown,
        max_proposals_per_period: overrides.max_proposals_per_period,
        proposal_period_duration: overrides.proposal_period_duration,
        // Not modeled in the scenario DSL (no co-sponsorship concept in
        // SimGovernorSettings) — carried through unchanged from whatever's
        // currently configured, same treatment as `guardian`/`reflector_oracle`.
        co_sponsorship_registry: current.co_sponsorship_registry.clone(),
    }
}

fn estimated_storage_touches(step: &SimStep) -> (u32, u32) {
    match step {
        SimStep::Propose { targets, .. } => {
            let target_count = targets.len() as u32;
            let reads = 3;
            let writes = 5 + target_count;
            (reads, writes)
        }
        SimStep::Vote { .. } => (2, 2),
        SimStep::Queue { .. } | SimStep::Execute { .. } | SimStep::Cancel { .. } => (2, 2),
        SimStep::UpdateConfig { .. } => (1, 14),
        _ => (0, 0),
    }
}
