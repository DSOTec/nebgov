use soroban_sdk::{Address, Env, Symbol};

pub const GOVERNOR_DEPLOYED_TOPIC: &str = "GovernorDeployed";

/// Emitted after a successful `deploy()`, carrying the addresses of every
/// contract spun up for the new governor stack so off-chain indexers can
/// begin tracking it without polling factory storage.
#[derive(Clone)]
#[soroban_sdk::contracttype]
pub struct GovernorDeployedEvent {
    pub id: u64,
    pub governor: Address,
    pub timelock: Address,
    pub token_votes: Address,
    pub deployer: Address,
    pub timestamp: u64,
}

pub fn emit_governor_deployed(
    env: &Env,
    id: u64,
    governor: &Address,
    timelock: &Address,
    token_votes: &Address,
    deployer: &Address,
) {
    env.events().publish(
        (Symbol::new(env, GOVERNOR_DEPLOYED_TOPIC), deployer.clone()),
        GovernorDeployedEvent {
            id,
            governor: governor.clone(),
            timelock: timelock.clone(),
            token_votes: token_votes.clone(),
            deployer: deployer.clone(),
            timestamp: env.ledger().timestamp(),
        },
    );
}
