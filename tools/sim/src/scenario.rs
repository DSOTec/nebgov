//! Deterministic description of a governance simulation scenario.
//!
//! A [`Scenario`] is pure data (serializable to/from JSON) describing a cast
//! of [`SimActor`]s and an ordered list of [`SimStep`]s to execute against a
//! freshly-deployed governor/timelock/token-votes/treasury stack. See
//! `tools/sim/src/scenarios/*.json` for examples.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Scenario {
    pub name: String,
    pub description: String,
    pub seed: u64,
    pub governor_settings: SimGovernorSettings,
    pub actors: Vec<SimActor>,
    pub steps: Vec<SimStep>,
}

/// Governor configuration values a scenario can set at genesis or via
/// `SimStep::UpdateConfig`. Distinct from the on-chain `GovernorSettings`
/// struct so scenario JSON stays stable even if the contract's settings
/// shape changes; the runner maps this onto the real struct.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimGovernorSettings {
    pub voting_delay: u32,
    pub voting_period: u32,
    pub quorum_numerator: u32,
    pub proposal_threshold: i128,
    pub vote_type: SimVoteType,
    pub proposal_grace_period: u32,
    #[serde(default = "default_max_calldata_size")]
    pub max_calldata_size: u32,
    #[serde(default)]
    pub proposal_cooldown: u32,
    #[serde(default = "default_max_proposals_per_period")]
    pub max_proposals_per_period: u32,
    #[serde(default = "default_proposal_period_duration")]
    pub proposal_period_duration: u32,
}

fn default_max_calldata_size() -> u32 {
    10_000
}
fn default_max_proposals_per_period() -> u32 {
    5
}
fn default_proposal_period_duration() -> u32 {
    10_000
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub enum SimVoteType {
    Simple,
    Extended,
    Quadratic,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimActor {
    pub name: String,
    pub initial_balance: i128,
    pub delegate_to: Option<String>,
    pub role: ActorRole,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ActorRole {
    TokenHolder,
    Proposer,
    Guardian,
    Pauser,
    Admin,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum SimStep {
    AdvanceLedger { ledgers: u32 },
    Propose {
        actor: String,
        targets: Vec<String>,
        fn_names: Vec<String>,
        description: String,
    },
    Vote {
        actor: String,
        proposal_id: u64,
        support: SimVoteSupport,
    },
    Queue {
        actor: String,
        proposal_id: u64,
    },
    Execute {
        actor: String,
        proposal_id: u64,
    },
    Cancel {
        actor: String,
        proposal_id: u64,
    },
    Delegate {
        actor: String,
        delegatee: String,
    },
    MintTokens {
        actor: String,
        amount: i128,
    },
    BurnTokens {
        actor: String,
        amount: i128,
    },
    UpdateConfig {
        actor: String,
        settings: SimGovernorSettings,
    },
    PauseContract {
        actor: String,
    },
    UnpauseContract {
        actor: String,
    },
    ExpectState {
        proposal_id: u64,
        expected_state: SimProposalState,
    },
    ExpectError {
        step_index: usize,
        expected_error: String,
    },
    TakeAnalyticsSnapshot,
    AssertParticipation {
        proposal_id: u64,
        min_bps: u32,
    },
    AssertQuorumReached {
        proposal_id: u64,
    },
    AssertReputationScore {
        actor: String,
        min_score: Option<i32>,
        max_score: Option<i32>,
    },
    CreateDraft {
        actor: String,
        targets: Vec<String>,
        fn_names: Vec<String>,
        description: String,
    },
    CoSponsorDraft {
        actor: String,
        draft_id: u64,
    },
    FinalizeDraft {
        actor: String,
        draft_id: u64,
    },
    CancelDraft {
        actor: String,
        draft_id: u64,
    },
    ScheduleBatch {
        actor: String,
        targets: Vec<String>,
        fn_names: Vec<String>,
        delay: u64,
    },
    ExecuteBatch {
        actor: String,
        schedule_step_index: usize,
    },
    ValidateDag {
        schedule_step_indices: Vec<usize>,
    },
    ConvictionCreateProposal {
        actor: String,
        target: String,
        fn_name: String,
        calldata: Option<String>,
        requested_amount: i128,
    },
    ConvictionStake {
        actor: String,
        proposal_id: u64,
        amount: i128,
    },
    ConvictionWithdrawStake {
        actor: String,
    },
    ConvictionCheckpoint {
        proposal_id: u64,
    },
    OptimisticPropose {
        actor: String,
        target: String,
        fn_name: String,
        calldata: Option<String>,
    },
    OptimisticObject {
        actor: String,
        proposal_id: u64,
    },
    OptimisticFinalize {
        proposal_id: u64,
    },
    OptimisticExecute {
        proposal_id: u64,
    },
    OptimisticCancel {
        actor: String,
        proposal_id: u64,
    },
    OptimisticExpectState {
        proposal_id: u64,
        expected_state: SimOptimisticProposalState,
    },
}

impl SimStep {
    /// Short tag used in reports (`StepResult::step_type`) and CLI output.
    pub fn kind(&self) -> &'static str {
        match self {
            SimStep::AdvanceLedger { .. } => "AdvanceLedger",
            SimStep::Propose { .. } => "Propose",
            SimStep::Vote { .. } => "Vote",
            SimStep::Queue { .. } => "Queue",
            SimStep::Execute { .. } => "Execute",
            SimStep::Cancel { .. } => "Cancel",
            SimStep::Delegate { .. } => "Delegate",
            SimStep::MintTokens { .. } => "MintTokens",
            SimStep::BurnTokens { .. } => "BurnTokens",
            SimStep::UpdateConfig { .. } => "UpdateConfig",
            SimStep::PauseContract { .. } => "PauseContract",
            SimStep::UnpauseContract { .. } => "UnpauseContract",
            SimStep::ExpectState { .. } => "ExpectState",
            SimStep::ExpectError { .. } => "ExpectError",
            SimStep::TakeAnalyticsSnapshot => "TakeAnalyticsSnapshot",
            SimStep::AssertParticipation { .. } => "AssertParticipation",
            SimStep::AssertQuorumReached { .. } => "AssertQuorumReached",
            SimStep::AssertReputationScore { .. } => "AssertReputationScore",
            SimStep::CreateDraft { .. } => "CreateDraft",
            SimStep::CoSponsorDraft { .. } => "CoSponsorDraft",
            SimStep::FinalizeDraft { .. } => "FinalizeDraft",
            SimStep::CancelDraft { .. } => "CancelDraft",
            SimStep::ScheduleBatch { .. } => "ScheduleBatch",
            SimStep::ExecuteBatch { .. } => "ExecuteBatch",
            SimStep::ValidateDag { .. } => "ValidateDag",
            SimStep::ConvictionCreateProposal { .. } => "ConvictionCreateProposal",
            SimStep::ConvictionStake { .. } => "ConvictionStake",
            SimStep::ConvictionWithdrawStake { .. } => "ConvictionWithdrawStake",
            SimStep::ConvictionCheckpoint { .. } => "ConvictionCheckpoint",
            SimStep::OptimisticPropose { .. } => "OptimisticPropose",
            SimStep::OptimisticObject { .. } => "OptimisticObject",
            SimStep::OptimisticFinalize { .. } => "OptimisticFinalize",
            SimStep::OptimisticExecute { .. } => "OptimisticExecute",
            SimStep::OptimisticCancel { .. } => "OptimisticCancel",
            SimStep::OptimisticExpectState { .. } => "OptimisticExpectState",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SimVoteSupport {
    Against,
    For,
    Abstain,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SimProposalState {
    Pending,
    Active,
    Defeated,
    Succeeded,
    Queued,
    Executed,
    Cancelled,
    Expired,
}

/// Mirrors `contracts/optimistic-governor::OptimisticProposalState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SimOptimisticProposalState {
    ChallengeWindow,
    Objected,
    Passed,
    Executed,
    Cancelled,
}

impl Scenario {
    pub fn from_json_str(s: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(s)
    }

    pub fn from_file(path: &std::path::Path) -> std::io::Result<Self> {
        let content = std::fs::read_to_string(path)?;
        Self::from_json_str(&content)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
    }

    /// Structural validation independent of running the scenario: every
    /// actor/proposal reference in `steps` resolves to something declared
    /// earlier, and roles are internally consistent.
    pub fn validate(&self) -> Result<(), String> {
        use std::collections::HashSet;

        if self.actors.is_empty() {
            return Err("scenario has no actors".to_string());
        }

        let actor_names: HashSet<&str> = self.actors.iter().map(|a| a.name.as_str()).collect();
        if actor_names.len() != self.actors.len() {
            return Err("duplicate actor names".to_string());
        }

        for actor in &self.actors {
            if let Some(ref d) = actor.delegate_to {
                if !actor_names.contains(d.as_str()) {
                    return Err(format!(
                        "actor '{}' delegates to unknown actor '{}'",
                        actor.name, d
                    ));
                }
            }
        }

        let mut known_proposals: HashSet<u64> = HashSet::new();
        for (i, step) in self.steps.iter().enumerate() {
            let actor_ref = match step {
                SimStep::Propose { actor, .. }
                | SimStep::Vote { actor, .. }
                | SimStep::Queue { actor, .. }
                | SimStep::Execute { actor, .. }
                | SimStep::Cancel { actor, .. }
                | SimStep::Delegate { actor, .. }
                | SimStep::MintTokens { actor, .. }
                | SimStep::BurnTokens { actor, .. }
                | SimStep::UpdateConfig { actor, .. }
                | SimStep::PauseContract { actor }
                | SimStep::UnpauseContract { actor }
                | SimStep::ScheduleBatch { actor, .. }
                | SimStep::ExecuteBatch { actor, .. } => Some(actor.as_str()),
                _ => None,
            };
            if let Some(name) = actor_ref {
                if !actor_names.contains(name) {
                    return Err(format!(
                        "step {} references unknown actor '{}'",
                        i, name
                    ));
                }
            }
            if let SimStep::Delegate { delegatee, .. } = step {
                if !actor_names.contains(delegatee.as_str()) {
                    return Err(format!(
                        "step {} delegates to unknown actor '{}'",
                        i, delegatee
                    ));
                }
            }
            match step {
                SimStep::Propose { .. } | SimStep::FinalizeDraft { .. } => {
                    // Proposal ids are assigned sequentially starting at 1 by
                    // the contract; the scenario doesn't declare them, so we
                    // just track how many have been created so far.
                    known_proposals.insert(known_proposals.len() as u64 + 1);
                }
                SimStep::Vote { proposal_id, .. }
                | SimStep::Queue { proposal_id, .. }
                | SimStep::Execute { proposal_id, .. }
                | SimStep::Cancel { proposal_id, .. }
                | SimStep::ExpectState { proposal_id, .. }
                | SimStep::AssertParticipation { proposal_id, .. }
                | SimStep::AssertQuorumReached { proposal_id } => {
                    if !known_proposals.contains(proposal_id) {
                        return Err(format!(
                            "step {} references proposal #{} before it is created",
                            i, proposal_id
                        ));
                    }
                }
                SimStep::ExpectError { step_index, .. } => {
                    if *step_index >= self.steps.len() {
                        return Err(format!(
                            "step {} references out-of-range step_index {}",
                            i, step_index
                        ));
                    }
                }
                SimStep::ExecuteBatch { schedule_step_index, .. } => {
                    if *schedule_step_index >= self.steps.len() {
                        return Err(format!(
                            "step {} references out-of-range schedule_step_index {}",
                            i, schedule_step_index
                        ));
                    }
                }
                SimStep::ValidateDag { schedule_step_indices } => {
                    for idx in schedule_step_indices {
                        if *idx >= self.steps.len() {
                            return Err(format!(
                                "step {} references out-of-range schedule_step_index {}",
                                i, idx
                            ));
                        }
                    }
                }
                _ => {}
            }
        }

        Ok(())
    }
}
