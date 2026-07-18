//! Multi-stream treasury budget allocation module.
//!
//! Allows governance to allocate per-department budget streams with
//! independent spending authority, cooldowns, and utilization tracking.

use crate::{DataKey, StreamDataKey, TreasuryError};
use soroban_sdk::{contracttype, token, Address, Env, IntoVal, String, Symbol, TryFromVal, Vec};

/// A budget stream allocated to a department owner.
#[contracttype]
#[derive(Clone, Debug)]
pub struct BudgetStream {
    pub id: u64,
    pub name: Symbol,
    pub owner: Address,
    pub token: Address,
    pub total_allocated: i128,
    pub total_spent: i128,
    pub start_ledger: u32,
    pub end_ledger: u32,
    pub is_active: bool,
    pub is_revoked: bool,
    pub revoked_at_ledger: Option<u32>,
    pub max_single_spend: i128,
    pub cooldown_ledgers: u32,
    pub last_spend_ledger: u32,
    pub spend_count: u32,
    pub created_by_proposal_id: u64,
}

/// A single spend from a budget stream.
#[contracttype]
#[derive(Clone, Debug)]
pub struct StreamSpend {
    pub stream_id: u64,
    pub spend_index: u32,
    pub recipient: Address,
    pub amount: i128,
    pub memo: String,
    pub executed_at_ledger: u32,
    pub executed_by: Address,
}

/// Budget utilization report for a single stream.
#[contracttype]
#[derive(Clone, Debug)]
pub struct StreamBudgetReport {
    pub stream_id: u64,
    pub name: Symbol,
    pub total_allocated: i128,
    pub total_spent: i128,
    pub remaining: i128,
    pub utilization_bps: u32,
    pub is_active: bool,
    pub days_remaining: u32,
    pub spend_count: u32,
    pub avg_spend: i128,
}

/// Treasury-wide budget summary across all streams.
#[contracttype]
#[derive(Clone, Debug)]
pub struct TreasuryBudgetSummary {
    pub total_streams: u32,
    pub active_streams: u32,
    pub total_allocated_by_token: Vec<(Address, i128)>,
    pub total_spent_by_token: Vec<(Address, i128)>,
    pub total_remaining_by_token: Vec<(Address, i128)>,
}

const STREAM_TTL_LEDGERS: u32 = 518_400;

// ── Event emission helpers ──────────────────────────────────────────────────

pub fn emit_stream_created(env: &Env, stream: &BudgetStream) {
    env.events().publish(
        (Symbol::new(env, "stream_created"),),
        (stream.id, stream.name.clone(), stream.owner.clone()),
    );
}

pub fn emit_stream_spend(env: &Env, stream_id: u64, spend: &StreamSpend) {
    env.events().publish(
        (Symbol::new(env, "stream_spend"),),
        (stream_id, spend.recipient.clone(), spend.amount),
    );
}

pub fn emit_stream_batch_spend(
    env: &Env,
    stream_id: u64,
    total_amount: i128,
    recipient_count: u32,
) {
    env.events().publish(
        (Symbol::new(env, "stream_batch"),),
        (stream_id, total_amount, recipient_count),
    );
}

pub fn emit_stream_revoked(env: &Env, stream_id: u64, caller: &Address, unspent_returned: i128) {
    env.events().publish(
        (Symbol::new(env, "stream_revoked"),),
        (stream_id, caller.clone(), unspent_returned),
    );
}

pub fn emit_stream_extended(env: &Env, stream_id: u64, old_end: u32, new_end: u32) {
    env.events().publish(
        (Symbol::new(env, "stream_extended"),),
        (stream_id, old_end, new_end),
    );
}

pub fn emit_stream_topped_up(env: &Env, stream_id: u64, additional: i128, new_total: i128) {
    env.events().publish(
        (Symbol::new(env, "stream_topped_up"),),
        (stream_id, additional, new_total),
    );
}

pub fn emit_stream_exhausted(env: &Env, stream_id: u64) {
    env.events()
        .publish((Symbol::new(env, "stream_exhausted"),), stream_id);
}

pub fn emit_stream_expired(env: &Env, stream_id: u64, unspent: i128) {
    env.events()
        .publish((Symbol::new(env, "stream_expired"),), (stream_id, unspent));
}

// ── Internal helpers ────────────────────────────────────────────────────────

fn get_stream_count(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&StreamDataKey::StreamCount)
        .unwrap_or(0)
}

fn set_stream_count(env: &Env, count: u64) {
    env.storage()
        .instance()
        .set(&StreamDataKey::StreamCount, &count);
}

fn get_stream_list(env: &Env) -> Vec<u64> {
    env.storage()
        .instance()
        .get(&StreamDataKey::StreamList)
        .unwrap_or(Vec::new(env))
}

fn push_to_stream_list(env: &Env, id: u64) {
    let mut list = get_stream_list(env);
    list.push_back(id);
    env.storage()
        .instance()
        .set(&StreamDataKey::StreamList, &list);
}

fn get_active_streams(env: &Env) -> Vec<u64> {
    env.storage()
        .instance()
        .get(&StreamDataKey::ActiveStreams)
        .unwrap_or(Vec::new(env))
}

fn add_active_stream(env: &Env, id: u64) {
    let mut list = get_active_streams(env);
    list.push_back(id);
    env.storage()
        .instance()
        .set(&StreamDataKey::ActiveStreams, &list);
}

fn remove_active_stream(env: &Env, id: u64) {
    let list = get_active_streams(env);
    let mut new_list = Vec::new(env);
    for i in 0..list.len() {
        let entry = list.get(i).unwrap();
        if entry != id {
            new_list.push_back(entry);
        }
    }
    env.storage()
        .instance()
        .set(&StreamDataKey::ActiveStreams, &new_list);
}

fn get_owner_stream_ids(env: &Env, owner: &Address) -> Vec<u64> {
    env.storage()
        .persistent()
        .get(&StreamDataKey::StreamsByOwner(owner.clone()))
        .unwrap_or(Vec::new(env))
}

fn add_stream_to_owner(env: &Env, owner: &Address, id: u64) {
    let mut list = get_owner_stream_ids(env, owner);
    list.push_back(id);
    env.storage()
        .persistent()
        .set(&StreamDataKey::StreamsByOwner(owner.clone()), &list);
}

fn get_streams_by_token(env: &Env, token: &Address) -> Vec<u64> {
    env.storage()
        .persistent()
        .get(&StreamDataKey::StreamsByToken(token.clone()))
        .unwrap_or(Vec::new(env))
}

fn add_stream_to_token(env: &Env, token: &Address, id: u64) {
    let mut list = get_streams_by_token(env, token);
    list.push_back(id);
    env.storage()
        .persistent()
        .set(&StreamDataKey::StreamsByToken(token.clone()), &list);
}

fn get_spends_raw(env: &Env, stream_id: u64) -> Vec<StreamSpend> {
    env.storage()
        .persistent()
        .get(&StreamDataKey::StreamSpends(stream_id))
        .unwrap_or(Vec::new(env))
}

fn get_stream_spend_count(env: &Env, stream_id: u64) -> u32 {
    env.storage()
        .persistent()
        .get(&StreamDataKey::StreamSpendCount(stream_id))
        .unwrap_or(0)
}

fn set_stream_spend_count(env: &Env, stream_id: u64, count: u32) {
    env.storage()
        .persistent()
        .set(&StreamDataKey::StreamSpendCount(stream_id), &count);
}

fn get_total_streamed_by_token(env: &Env, token: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&StreamDataKey::TotalStreamedByToken(token.clone()))
        .unwrap_or(0)
}

fn add_total_streamed_by_token(env: &Env, token: &Address, amount: i128) {
    let current = get_total_streamed_by_token(env, token);
    let new_total = current
        .checked_add(amount)
        .expect("total streamed overflow");
    env.storage().persistent().set(
        &StreamDataKey::TotalStreamedByToken(token.clone()),
        &new_total,
    );
}

fn require_governor(env: &Env, caller: &Address) {
    caller.require_auth();
    let governor: Address = env
        .storage()
        .instance()
        .get(&DataKey::Governor)
        .expect("not initialized");
    assert!(caller == &governor, "not authorized");
}

fn load_stream(env: &Env, stream_id: u64) -> BudgetStream {
    env.storage()
        .persistent()
        .get(&StreamDataKey::Stream(stream_id))
        .unwrap_or_else(|| env.panic_with_error(TreasuryError::StreamNotFound))
}

fn save_stream(env: &Env, stream: &BudgetStream) {
    env.storage()
        .persistent()
        .set(&StreamDataKey::Stream(stream.id), stream);
    env.storage().persistent().extend_ttl(
        &StreamDataKey::Stream(stream.id),
        STREAM_TTL_LEDGERS,
        STREAM_TTL_LEDGERS,
    );
}

fn paginate<T: Clone + TryFromVal<Env, soroban_sdk::Val> + IntoVal<Env, soroban_sdk::Val>>(
    env: &Env,
    list: Vec<T>,
    offset: u64,
    limit: u64,
) -> Vec<T> {
    let mut result = Vec::new(env);
    let len = list.len() as u64;
    let start = offset.min(len);
    let end = (start + limit).min(len);
    for i in start..end {
        result.push_back(list.get(i as u32).unwrap());
    }
    result
}

// ── Public stream functions ─────────────────────────────────────────────────

/// Governance-gated: allocate a new budget stream to a department owner.
pub fn create_stream(
    env: Env,
    caller: Address,
    name: Symbol,
    owner: Address,
    token: Address,
    total_allocated: i128,
    start_ledger: u32,
    end_ledger: u32,
    max_single_spend: i128,
    cooldown_ledgers: u32,
    proposal_id: u64,
) -> u64 {
    require_governor(&env, &caller);

    assert!(total_allocated > 0, "allocation must be positive");
    assert!(max_single_spend > 0, "max single spend must be positive");
    assert!(end_ledger > start_ledger, "end before start");

    let id = get_stream_count(&env) + 1;
    let stream = BudgetStream {
        id,
        name: name.clone(),
        owner: owner.clone(),
        token: token.clone(),
        total_allocated,
        total_spent: 0,
        start_ledger,
        end_ledger,
        is_active: true,
        is_revoked: false,
        revoked_at_ledger: None,
        max_single_spend,
        cooldown_ledgers,
        last_spend_ledger: 0,
        spend_count: 0,
        created_by_proposal_id: proposal_id,
    };

    save_stream(&env, &stream);
    set_stream_count(&env, id);
    push_to_stream_list(&env, id);
    add_active_stream(&env, id);
    add_stream_to_owner(&env, &owner, id);
    add_stream_to_token(&env, &token, id);
    add_total_streamed_by_token(&env, &token, total_allocated);

    emit_stream_created(&env, &stream);
    id
}

/// Stream owner: spend from an allocated stream.
pub fn stream_spend(
    env: Env,
    owner: Address,
    stream_id: u64,
    recipient: Address,
    amount: i128,
    memo: String,
) {
    owner.require_auth();

    let mut stream = load_stream(&env, stream_id);

    assert!(!stream.is_revoked, "stream revoked");
    assert!(stream.is_active, "stream not active");
    assert!(owner == stream.owner, "not stream owner");

    let current_ledger = env.ledger().sequence();
    assert!(current_ledger <= stream.end_ledger, "stream expired");

    assert!(amount > 0, "amount must be positive");
    assert!(
        amount <= stream.max_single_spend,
        "exceeds max single spend"
    );

    let remaining = stream.total_allocated - stream.total_spent;
    assert!(amount <= remaining, "budget exhausted");

    if stream.cooldown_ledgers > 0 && stream.spend_count > 0 {
        let elapsed = current_ledger - stream.last_spend_ledger;
        assert!(elapsed >= stream.cooldown_ledgers, "cooldown not elapsed");
    }

    // Transfer tokens from treasury to recipient
    let token_client = token::TokenClient::new(&env, &stream.token);
    let treasury = env.current_contract_address();
    token_client.transfer(&treasury, &recipient, &amount);

    // Update stream state
    stream.total_spent = stream
        .total_spent
        .checked_add(amount)
        .expect("spent overflow");
    stream.last_spend_ledger = current_ledger;
    stream.spend_count += 1;

    let spend_index = get_stream_spend_count(&env, stream_id);
    let spend = StreamSpend {
        stream_id,
        spend_index,
        recipient: recipient.clone(),
        amount,
        memo: memo.clone(),
        executed_at_ledger: current_ledger,
        executed_by: owner.clone(),
    };

    // Persist spend record
    let mut spends = get_spends_raw(&env, stream_id);
    spends.push_back(spend.clone());
    env.storage()
        .persistent()
        .set(&StreamDataKey::StreamSpends(stream_id), &spends);
    set_stream_spend_count(&env, stream_id, spend_index + 1);

    // Check if exhausted
    let new_remaining = stream.total_allocated - stream.total_spent;
    if new_remaining == 0 {
        stream.is_active = false;
        remove_active_stream(&env, stream_id);
        emit_stream_exhausted(&env, stream_id);
    }

    save_stream(&env, &stream);
    emit_stream_spend(&env, stream_id, &spend);
}

/// Batch spend from a stream to multiple recipients.
pub fn stream_batch_spend(
    env: Env,
    owner: Address,
    stream_id: u64,
    recipients: Vec<Address>,
    amounts: Vec<i128>,
    memo: String,
) {
    owner.require_auth();

    assert!(recipients.len() == amounts.len(), "length mismatch");
    assert!(!recipients.is_empty(), "empty batch");

    let mut stream = load_stream(&env, stream_id);
    assert!(!stream.is_revoked, "stream revoked");
    assert!(stream.is_active, "stream not active");
    assert!(owner == stream.owner, "not stream owner");

    let current_ledger = env.ledger().sequence();
    assert!(current_ledger <= stream.end_ledger, "stream expired");

    // Validate all amounts
    let mut total: i128 = 0;
    for i in 0..amounts.len() {
        let amt = amounts.get(i).unwrap();
        assert!(amt > 0, "amount must be positive");
        assert!(amt <= stream.max_single_spend, "exceeds max single spend");
        total = total.checked_add(amt).expect("batch total overflow");
    }

    let remaining = stream.total_allocated - stream.total_spent;
    assert!(total <= remaining, "budget exhausted");

    if stream.cooldown_ledgers > 0 && stream.spend_count > 0 {
        let elapsed = current_ledger - stream.last_spend_ledger;
        assert!(elapsed >= stream.cooldown_ledgers, "cooldown not elapsed");
    }

    // Execute transfers
    let token_client = token::TokenClient::new(&env, &stream.token);
    let treasury = env.current_contract_address();
    for i in 0..recipients.len() {
        let r = recipients.get(i).unwrap();
        let amt = amounts.get(i).unwrap();
        token_client.transfer(&treasury, &r, &amt);
    }

    // Update stream
    stream.total_spent = stream
        .total_spent
        .checked_add(total)
        .expect("spent overflow");
    stream.last_spend_ledger = current_ledger;
    stream.spend_count += recipients.len() as u32;

    // Record each spend
    let mut spends = get_spends_raw(&env, stream_id);
    let mut spend_index = get_stream_spend_count(&env, stream_id);
    for i in 0..recipients.len() {
        let r = recipients.get(i).unwrap();
        let amt = amounts.get(i).unwrap();
        let spend = StreamSpend {
            stream_id,
            spend_index,
            recipient: r,
            amount: amt,
            memo: memo.clone(),
            executed_at_ledger: current_ledger,
            executed_by: owner.clone(),
        };
        spends.push_back(spend);
        spend_index += 1;
    }
    env.storage()
        .persistent()
        .set(&StreamDataKey::StreamSpends(stream_id), &spends);
    set_stream_spend_count(&env, stream_id, spend_index);

    let new_remaining = stream.total_allocated - stream.total_spent;
    if new_remaining == 0 {
        stream.is_active = false;
        remove_active_stream(&env, stream_id);
        emit_stream_exhausted(&env, stream_id);
    }

    save_stream(&env, &stream);
    emit_stream_batch_spend(&env, stream_id, total, recipients.len() as u32);
}

/// Governance-gated: revoke an active stream and return unspent funds to treasury.
pub fn revoke_stream(env: Env, caller: Address, stream_id: u64) {
    require_governor(&env, &caller);

    let mut stream = load_stream(&env, stream_id);
    assert!(!stream.is_revoked, "already revoked");

    let unspent = stream.total_allocated - stream.total_spent;
    stream.is_revoked = true;
    stream.is_active = false;
    stream.revoked_at_ledger = Some(env.ledger().sequence());

    remove_active_stream(&env, stream_id);
    save_stream(&env, &stream);

    emit_stream_revoked(&env, stream_id, &caller, unspent);
}

/// Governance-gated: extend a stream's end_ledger.
pub fn extend_stream(env: Env, caller: Address, stream_id: u64, new_end_ledger: u32) {
    require_governor(&env, &caller);

    let mut stream = load_stream(&env, stream_id);
    assert!(!stream.is_revoked, "stream revoked");
    assert!(new_end_ledger > stream.end_ledger, "new end must be later");

    let old_end = stream.end_ledger;
    stream.end_ledger = new_end_ledger;
    save_stream(&env, &stream);

    emit_stream_extended(&env, stream_id, old_end, new_end_ledger);
}

/// Governance-gated: top up an existing stream's allocated budget.
pub fn top_up_stream(env: Env, caller: Address, stream_id: u64, additional_amount: i128) {
    require_governor(&env, &caller);

    assert!(additional_amount > 0, "additional must be positive");

    let mut stream = load_stream(&env, stream_id);
    assert!(!stream.is_revoked, "stream revoked");

    stream.total_allocated = stream
        .total_allocated
        .checked_add(additional_amount)
        .expect("allocation overflow");

    let new_total = stream.total_allocated;
    add_total_streamed_by_token(&env, &stream.token, additional_amount);

    save_stream(&env, &stream);
    emit_stream_topped_up(&env, stream_id, additional_amount, new_total);
}

/// Query: get a stream by ID.
pub fn get_stream(env: Env, stream_id: u64) -> BudgetStream {
    load_stream(&env, stream_id)
}

/// Query: get paginated list of streams.
pub fn get_streams(env: Env, offset: u64, limit: u64) -> Vec<BudgetStream> {
    let list = get_stream_list(&env);
    let mut result = Vec::new(&env);
    let len = list.len() as u64;
    let start = offset.min(len);
    let end = (start + limit).min(len);
    for i in start..end {
        let id = list.get(i as u32).unwrap();
        let stream = load_stream(&env, id);
        result.push_back(stream);
    }
    result
}

/// Query: get streams by owner (paginated).
pub fn get_streams_by_owner(
    env: Env,
    owner: Address,
    offset: u64,
    limit: u64,
) -> Vec<BudgetStream> {
    let ids = get_owner_stream_ids(&env, &owner);
    let mut result = Vec::new(&env);
    let len = ids.len() as u64;
    let start = offset.min(len);
    let end = (start + limit).min(len);
    for i in start..end {
        let id = ids.get(i as u32).unwrap();
        let stream = load_stream(&env, id);
        result.push_back(stream);
    }
    result
}

/// Query: get spend history for a stream (paginated).
pub fn get_stream_spends(env: Env, stream_id: u64, offset: u32, limit: u32) -> Vec<StreamSpend> {
    let spends = get_spends_raw(&env, stream_id);
    paginate(&env, spends, offset as u64, limit as u64)
}

/// Query: get budget report for a specific stream.
pub fn get_stream_report(env: Env, stream_id: u64) -> StreamBudgetReport {
    let stream = load_stream(&env, stream_id);
    let remaining = stream.total_allocated - stream.total_spent;
    let utilization_bps = if stream.total_allocated > 0 {
        ((stream.total_spent as u128 * 10_000) / stream.total_allocated as u128) as u32
    } else {
        0
    };
    let current_ledger = env.ledger().sequence();
    let days_remaining = if current_ledger < stream.end_ledger {
        (stream.end_ledger - current_ledger) / 17_280
    } else {
        0
    };
    let avg_spend = if stream.spend_count > 0 {
        stream.total_spent / (stream.spend_count as i128)
    } else {
        0
    };

    StreamBudgetReport {
        stream_id,
        name: stream.name,
        total_allocated: stream.total_allocated,
        total_spent: stream.total_spent,
        remaining,
        utilization_bps,
        is_active: stream.is_active,
        days_remaining,
        spend_count: stream.spend_count,
        avg_spend,
    }
}

/// Query: get treasury-wide budget summary.
pub fn get_budget_summary(env: Env) -> TreasuryBudgetSummary {
    let list = get_stream_list(&env);
    let total_streams = list.len();
    let active_ids = get_active_streams(&env);
    let active_streams = active_ids.len();

    let mut token_set: Vec<Address> = Vec::new(&env);
    let mut allocated_by_token: Vec<(Address, i128)> = Vec::new(&env);
    let mut spent_by_token: Vec<(Address, i128)> = Vec::new(&env);

    for i in 0..list.len() {
        let id = list.get(i).unwrap();
        let stream = load_stream(&env, id);

        // Find or add token to lists
        let mut found = false;
        for j in 0..token_set.len() {
            if token_set.get(j).unwrap() == stream.token {
                let (t, a) = allocated_by_token.get(j).unwrap();
                let (_, s) = spent_by_token.get(j).unwrap();
                allocated_by_token.set(j, (t.clone(), a + stream.total_allocated));
                spent_by_token.set(j, (t, s + stream.total_spent));
                found = true;
                break;
            }
        }
        if !found {
            token_set.push_back(stream.token.clone());
            allocated_by_token.push_back((stream.token.clone(), stream.total_allocated));
            spent_by_token.push_back((stream.token.clone(), stream.total_spent));
        }
    }

    let mut remaining_by_token: Vec<(Address, i128)> = Vec::new(&env);
    for i in 0..allocated_by_token.len() {
        let (t, a) = allocated_by_token.get(i).unwrap();
        let (_, s) = spent_by_token.get(i).unwrap();
        remaining_by_token.push_back((t, a - s));
    }

    TreasuryBudgetSummary {
        total_streams,
        active_streams,
        total_allocated_by_token: allocated_by_token,
        total_spent_by_token: spent_by_token,
        total_remaining_by_token: remaining_by_token,
    }
}

/// Query: compute remaining budget for a stream at the current ledger.
pub fn get_stream_remaining(env: Env, stream_id: u64) -> i128 {
    let stream = load_stream(&env, stream_id);
    stream.total_allocated - stream.total_spent
}
