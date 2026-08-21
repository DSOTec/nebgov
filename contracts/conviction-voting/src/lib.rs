#![no_std]

mod error;
mod events;

pub use error::ConvictionVotingError;

use soroban_sdk::{
    contract, contractclient, contractimpl, contracttype, xdr::FromXdr, Address, Bytes, Env,
    Symbol, Val, Vec,
};

const BPS: i128 = 10_000;

#[contractclient(name = "VotesClient")]
pub trait VotesTrait {
    fn get_votes(env: Env, account: Address) -> i128;
    fn get_past_total_supply(env: Env, ledger: u32) -> i128;
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ConvictionProposal {
    pub id: u64,
    pub proposer: Address,
    pub target: Address,
    pub fn_name: Symbol,
    pub calldata: Bytes,
    pub requested_amount: i128,
    pub created_ledger: u32,
    pub conviction: i128,
    pub last_updated_ledger: u32,
    pub executed: bool,
    pub cancelled: bool,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Stake {
    pub staker: Address,
    pub proposal_id: u64,
    pub amount: i128,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    VotesToken,
    NextProposalId,
    Proposal(u64),
    StakesByProposal(u64),
    StakeByStaker(Address),
    DecayBps,
    MaxRatioBps,
    MinThresholdConviction,
    WeightBps,
}

#[contract]
pub struct ConvictionVotingContract;

#[contractimpl]
impl ConvictionVotingContract {
    /// Configure the conviction voting track. May only be called once.
    pub fn initialize(
        env: Env,
        admin: Address,
        votes_token: Address,
        decay_bps: u32,
        max_ratio_bps: u32,
        min_threshold_conviction: i128,
        weight_bps: u32,
    ) {
        admin.require_auth();
        if env.storage().instance().has(&DataKey::Admin) {
            env.panic_with_error(ConvictionVotingError::AlreadyInitialized);
        }
        if decay_bps == 0
            || decay_bps >= BPS as u32
            || max_ratio_bps == 0
            || max_ratio_bps > BPS as u32
            || min_threshold_conviction <= 0
            || weight_bps == 0
            || weight_bps > BPS as u32
        {
            env.panic_with_error(ConvictionVotingError::InvalidConfiguration);
        }
        let storage = env.storage().instance();
        storage.set(&DataKey::Admin, &admin);
        storage.set(&DataKey::VotesToken, &votes_token);
        storage.set(&DataKey::NextProposalId, &1u64);
        storage.set(&DataKey::DecayBps, &decay_bps);
        storage.set(&DataKey::MaxRatioBps, &max_ratio_bps);
        storage.set(&DataKey::MinThresholdConviction, &min_threshold_conviction);
        storage.set(&DataKey::WeightBps, &weight_bps);
    }

    /// Create a continuously supported proposal.
    pub fn create_proposal(
        env: Env,
        proposer: Address,
        target: Address,
        fn_name: Symbol,
        calldata: Bytes,
        requested_amount: i128,
    ) -> u64 {
        proposer.require_auth();
        Self::require_initialized(&env);
        if requested_amount < 0 {
            env.panic_with_error(ConvictionVotingError::InvalidAmount);
        }
        if !calldata.is_empty() && Vec::<Val>::from_xdr(&env, &calldata).is_err() {
            env.panic_with_error(ConvictionVotingError::InvalidCalldata);
        }
        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextProposalId)
            .unwrap();
        let next = id
            .checked_add(1)
            .unwrap_or_else(|| env.panic_with_error(ConvictionVotingError::ArithmeticOverflow));
        let ledger = env.ledger().sequence();
        let proposal = ConvictionProposal {
            id,
            proposer: proposer.clone(),
            target: target.clone(),
            fn_name,
            calldata,
            requested_amount,
            created_ledger: ledger,
            conviction: 0,
            last_updated_ledger: ledger,
            executed: false,
            cancelled: false,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(id), &proposal);
        env.storage()
            .persistent()
            .set(&DataKey::StakesByProposal(id), &Vec::<Stake>::new(&env));
        env.storage()
            .instance()
            .set(&DataKey::NextProposalId, &next);
        events::emit_proposal_created(&env, id, &proposer, &target, requested_amount);
        id
    }

    /// Commit voting power, moving any existing stake to this proposal.
    pub fn stake(env: Env, staker: Address, proposal_id: u64, amount: i128) {
        staker.require_auth();
        if amount <= 0 {
            env.panic_with_error(ConvictionVotingError::InvalidAmount);
        }
        let votes = Self::votes_client(&env).get_votes(&staker);
        if votes < amount {
            env.panic_with_error(ConvictionVotingError::InsufficientVotingPower);
        }
        let target = Self::must_get_open_proposal(&env, proposal_id);
        Self::update_conviction(&env, target);

        if let Some(old_id) = env
            .storage()
            .persistent()
            .get::<_, u64>(&DataKey::StakeByStaker(staker.clone()))
        {
            if old_id != proposal_id {
                let old = Self::must_get_proposal(&env, old_id);
                Self::update_conviction(&env, old);
                Self::remove_stake(&env, &staker, old_id);
                events::emit_stake_updated(&env, &staker, old_id, 0);
            }
        }

        let mut stakes = Self::stakes(&env, proposal_id);
        let mut replaced = false;
        for index in 0..stakes.len() {
            let existing = stakes.get(index).unwrap();
            if existing.staker == staker {
                stakes.set(
                    index,
                    Stake {
                        staker: staker.clone(),
                        proposal_id,
                        amount,
                    },
                );
                replaced = true;
                break;
            }
        }
        if !replaced {
            stakes.push_back(Stake {
                staker: staker.clone(),
                proposal_id,
                amount,
            });
        }
        env.storage()
            .persistent()
            .set(&DataKey::StakesByProposal(proposal_id), &stakes);
        env.storage()
            .persistent()
            .set(&DataKey::StakeByStaker(staker.clone()), &proposal_id);
        events::emit_stake_updated(&env, &staker, proposal_id, amount);
    }

    /// Withdraw the caller's active stake.
    pub fn withdraw_stake(env: Env, staker: Address) {
        staker.require_auth();
        let proposal_id: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::StakeByStaker(staker.clone()))
            .unwrap_or_else(|| env.panic_with_error(ConvictionVotingError::StakeNotFound));
        let proposal = Self::must_get_proposal(&env, proposal_id);
        Self::update_conviction(&env, proposal);
        Self::remove_stake(&env, &staker, proposal_id);
        events::emit_stake_updated(&env, &staker, proposal_id, 0);
    }

    /// Accumulate conviction and execute once the dynamic threshold is met.
    pub fn checkpoint_conviction(env: Env, proposal_id: u64) -> i128 {
        let proposal = Self::must_get_proposal(&env, proposal_id);
        if proposal.executed || proposal.cancelled {
            return proposal.conviction;
        }
        let mut proposal = Self::update_conviction(&env, proposal);
        let threshold = Self::get_required_threshold(env.clone(), proposal.requested_amount);
        if proposal.conviction >= threshold {
            proposal.executed = true;
            env.storage()
                .persistent()
                .set(&DataKey::Proposal(proposal_id), &proposal);
            let args = if proposal.calldata.is_empty() {
                Vec::<Val>::new(&env)
            } else {
                Vec::<Val>::from_xdr(&env, &proposal.calldata).unwrap_or_else(|_| {
                    env.panic_with_error(ConvictionVotingError::InvalidCalldata)
                })
            };
            env.invoke_contract::<Val>(&proposal.target, &proposal.fn_name, args);
            events::emit_proposal_executed(&env, proposal_id);
        }
        proposal.conviction
    }

    /// Return a proposal by id.
    pub fn get_proposal(env: Env, proposal_id: u64) -> ConvictionProposal {
        Self::must_get_proposal(&env, proposal_id)
    }

    /// Return all current stakes for a proposal.
    pub fn get_stakes(env: Env, proposal_id: u64) -> Vec<Stake> {
        Self::must_get_proposal(&env, proposal_id);
        Self::stakes(&env, proposal_id)
    }

    /// Return the dynamic threshold for a requested token amount.
    pub fn get_required_threshold(env: Env, requested_amount: i128) -> i128 {
        Self::require_initialized(&env);
        if requested_amount < 0 {
            env.panic_with_error(ConvictionVotingError::InvalidAmount);
        }
        let minimum: i128 = env
            .storage()
            .instance()
            .get(&DataKey::MinThresholdConviction)
            .unwrap();
        if requested_amount == 0 {
            return minimum;
        }
        let supply = Self::votes_client(&env).get_past_total_supply(&env.ledger().sequence());
        if supply <= 0 {
            return i128::MAX;
        }
        let max_ratio: u32 = env.storage().instance().get(&DataKey::MaxRatioBps).unwrap();
        let ratio = requested_amount
            .checked_mul(BPS)
            .and_then(|v| v.checked_div(supply))
            .unwrap_or(i128::MAX);
        if ratio >= max_ratio as i128 {
            return i128::MAX;
        }
        let gap = max_ratio as i128 - ratio;
        minimum
            .checked_mul(max_ratio as i128)
            .and_then(|v| v.checked_mul(max_ratio as i128))
            .and_then(|v| v.checked_div(gap))
            .and_then(|v| v.checked_div(gap))
            .unwrap_or(i128::MAX)
    }

    /// Cancel an unexecuted proposal as its proposer or the module admin.
    pub fn cancel_proposal(env: Env, caller: Address, proposal_id: u64) {
        caller.require_auth();
        let mut proposal = Self::must_get_open_proposal(&env, proposal_id);
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if caller != proposal.proposer && caller != admin {
            env.panic_with_error(ConvictionVotingError::Unauthorized);
        }
        proposal.cancelled = true;
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        events::emit_proposal_cancelled(&env, proposal_id, &caller);
    }

    fn require_initialized(env: &Env) {
        if !env.storage().instance().has(&DataKey::Admin) {
            env.panic_with_error(ConvictionVotingError::NotInitialized);
        }
    }

    fn votes_client(env: &Env) -> VotesClient<'_> {
        let address: Address = env
            .storage()
            .instance()
            .get(&DataKey::VotesToken)
            .unwrap_or_else(|| env.panic_with_error(ConvictionVotingError::NotInitialized));
        VotesClient::new(env, &address)
    }

    fn must_get_proposal(env: &Env, id: u64) -> ConvictionProposal {
        env.storage()
            .persistent()
            .get(&DataKey::Proposal(id))
            .unwrap_or_else(|| env.panic_with_error(ConvictionVotingError::ProposalNotFound))
    }

    fn must_get_open_proposal(env: &Env, id: u64) -> ConvictionProposal {
        let proposal = Self::must_get_proposal(env, id);
        if proposal.executed || proposal.cancelled {
            env.panic_with_error(ConvictionVotingError::ProposalClosed);
        }
        proposal
    }

    fn stakes(env: &Env, id: u64) -> Vec<Stake> {
        env.storage()
            .persistent()
            .get(&DataKey::StakesByProposal(id))
            .unwrap_or(Vec::new(env))
    }

    fn remove_stake(env: &Env, staker: &Address, proposal_id: u64) {
        let stakes = Self::stakes(env, proposal_id);
        let mut retained = Vec::new(env);
        for stake in stakes.iter() {
            if stake.staker != *staker {
                retained.push_back(stake);
            }
        }
        env.storage()
            .persistent()
            .set(&DataKey::StakesByProposal(proposal_id), &retained);
        env.storage()
            .persistent()
            .remove(&DataKey::StakeByStaker(staker.clone()));
    }

    fn total_staked(env: &Env, proposal_id: u64) -> i128 {
        let mut total = 0i128;
        for stake in Self::stakes(env, proposal_id).iter() {
            total = total
                .checked_add(stake.amount)
                .unwrap_or_else(|| env.panic_with_error(ConvictionVotingError::ArithmeticOverflow));
        }
        total
    }

    fn update_conviction(env: &Env, mut proposal: ConvictionProposal) -> ConvictionProposal {
        let current = env.ledger().sequence();
        let elapsed = current.saturating_sub(proposal.last_updated_ledger);
        if elapsed == 0 || proposal.executed || proposal.cancelled {
            return proposal;
        }
        let decay_bps: u32 = env.storage().instance().get(&DataKey::DecayBps).unwrap();
        let weight_bps: u32 = env.storage().instance().get(&DataKey::WeightBps).unwrap();
        let decay = Self::pow_bps(decay_bps as i128, elapsed);
        let total = Self::total_staked(env, proposal.id);
        let steady = total
            .checked_mul(weight_bps as i128)
            .and_then(|v| v.checked_div((BPS - decay_bps as i128).max(1)))
            .unwrap_or_else(|| env.panic_with_error(ConvictionVotingError::ArithmeticOverflow));
        let retained = proposal
            .conviction
            .checked_mul(decay)
            .and_then(|v| v.checked_div(BPS));
        let accrued = steady
            .checked_mul(BPS - decay)
            .and_then(|v| v.checked_div(BPS));
        proposal.conviction = retained
            .and_then(|v| accrued.and_then(|a| v.checked_add(a)))
            .unwrap_or_else(|| env.panic_with_error(ConvictionVotingError::ArithmeticOverflow));
        proposal.last_updated_ledger = current;
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal.id), &proposal);
        events::emit_conviction_updated(env, proposal.id, proposal.conviction);
        proposal
    }

    // Exponentiation by squaring is bounded by the bit width of `elapsed`
    // (at most 32 iterations), independent of the number of idle ledgers.
    fn pow_bps(mut base: i128, mut exponent: u32) -> i128 {
        let mut result = BPS;
        while exponent > 0 {
            if exponent & 1 == 1 {
                result = result.saturating_mul(base) / BPS;
            }
            exponent >>= 1;
            if exponent > 0 {
                base = base.saturating_mul(base) / BPS;
            }
        }
        result
    }
}

#[cfg(test)]
mod tests;
