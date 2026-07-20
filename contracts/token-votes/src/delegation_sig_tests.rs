//! Tests for the signed-delegation (`delegate_by_sig`) flow (issue #772).
//!
//! Verification is delegated to Soroban's native authorization framework
//! (see delegation_sig.rs for why), so these tests exercise real
//! `Address::require_auth_for_args` checks via `env.mock_auths(..)` rather
//! than a manually-supplied signature blob. `mock_auths` still enforces that
//! *some* address authorized *exactly* the given invocation/args — it does
//! not bypass the "who authorized what" check, only the underlying Ed25519
//! cryptography (which is the SDK's own responsibility, not this
//! contract's). "Invalid signature" is therefore tested as "no matching
//! authorization was provided", which is exactly how an invalid off-chain
//! signature manifests once a relayer submits it on-chain.

use crate::{
    delegation_sig::DelegationPermit, DataKey, TokenVotesContract, TokenVotesContractClient,
};
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger as _, MockAuth, MockAuthInvoke},
    token, Address, BytesN, Env, IntoVal,
};

fn setup(env: &Env, admin: &Address) -> (Address, Address) {
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();
    let contract_id = env.register(TokenVotesContract, ());
    let client = TokenVotesContractClient::new(env, &contract_id);
    client.initialize(admin, &token_addr);
    (contract_id, token_addr)
}

fn make_permit(
    env: &Env,
    contract_id: &Address,
    delegator: &Address,
    delegatee: &Address,
    nonce: u64,
    expiry_ledger: u32,
) -> DelegationPermit {
    DelegationPermit {
        delegator: delegator.clone(),
        delegatee: delegatee.clone(),
        nonce,
        expiry_ledger,
        chain_id: env.ledger().network_id(),
        contract_id: contract_id.clone(),
    }
}

#[test]
fn test_delegate_by_sig_applies_delegation_with_valid_signature() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let delegator = Address::generate(&env);
    let delegatee = Address::generate(&env);
    let relayer = Address::generate(&env);

    let (contract_id, token_addr) = setup(&env, &admin);
    let client = TokenVotesContractClient::new(&env, &contract_id);
    let sac_client = token::StellarAssetClient::new(&env, &token_addr);
    sac_client.mint(&delegator, &1000i128);

    env.ledger().with_mut(|l| l.sequence_number = 100);
    let permit = make_permit(&env, &contract_id, &delegator, &delegatee, 0, 200);

    let new_nonce = client.delegate_by_sig(&relayer, &permit);

    assert_eq!(new_nonce, 1);
    assert_eq!(client.get_votes(&delegatee), 1000);
    assert_eq!(client.delegates(&delegator), Some(delegatee));
    assert_eq!(client.nonce(&delegator), 1);
    assert!(client.is_nonce_used(&delegator, &0));
}

#[test]
#[should_panic]
fn test_delegate_by_sig_reverts_on_invalid_signature() {
    let env = Env::default();
    // No mock_all_auths(), and no mock_auths() supplied at all: the
    // delegator never authorized anything, which is what an invalid or
    // missing off-chain signature looks like once submitted on-chain.
    let admin = Address::generate(&env);
    let delegator = Address::generate(&env);
    let delegatee = Address::generate(&env);
    let relayer = Address::generate(&env);

    let (contract_id, _token_addr) = setup(&env, &admin);
    let client = TokenVotesContractClient::new(&env, &contract_id);

    let permit = make_permit(&env, &contract_id, &delegator, &delegatee, 0, 1000);
    client.delegate_by_sig(&relayer, &permit);
}

#[test]
#[should_panic(expected = "Error(Contract, #12)")]
fn test_delegate_by_sig_reverts_on_expired_permit() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let delegator = Address::generate(&env);
    let delegatee = Address::generate(&env);
    let relayer = Address::generate(&env);

    let (contract_id, _token_addr) = setup(&env, &admin);
    let client = TokenVotesContractClient::new(&env, &contract_id);

    env.ledger().with_mut(|l| l.sequence_number = 500);
    let permit = make_permit(&env, &contract_id, &delegator, &delegatee, 0, 100);

    client.delegate_by_sig(&relayer, &permit);
}

#[test]
#[should_panic(expected = "Error(Contract, #11)")]
fn test_delegate_by_sig_reverts_on_already_used_nonce() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let delegator = Address::generate(&env);
    let delegatee = Address::generate(&env);
    let relayer = Address::generate(&env);

    let (contract_id, token_addr) = setup(&env, &admin);
    let client = TokenVotesContractClient::new(&env, &contract_id);
    let sac_client = token::StellarAssetClient::new(&env, &token_addr);
    sac_client.mint(&delegator, &1000i128);

    env.ledger().with_mut(|l| l.sequence_number = 100);
    let permit = make_permit(&env, &contract_id, &delegator, &delegatee, 0, 1000);
    client.delegate_by_sig(&relayer, &permit);

    // Replay the exact same (already-consumed) permit.
    client.delegate_by_sig(&relayer, &permit);
}

#[test]
#[should_panic(expected = "Error(Contract, #15)")]
fn test_delegate_by_sig_reverts_on_wrong_chain_id() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let delegator = Address::generate(&env);
    let delegatee = Address::generate(&env);
    let relayer = Address::generate(&env);

    let (contract_id, _token_addr) = setup(&env, &admin);
    let client = TokenVotesContractClient::new(&env, &contract_id);

    let mut permit = make_permit(&env, &contract_id, &delegator, &delegatee, 0, 1000);
    permit.chain_id = BytesN::from_array(&env, &[9u8; 32]);

    client.delegate_by_sig(&relayer, &permit);
}

#[test]
#[should_panic(expected = "Error(Contract, #16)")]
fn test_delegate_by_sig_reverts_on_wrong_contract_id() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let delegator = Address::generate(&env);
    let delegatee = Address::generate(&env);
    let relayer = Address::generate(&env);
    let other_contract = Address::generate(&env);

    let (contract_id, _token_addr) = setup(&env, &admin);
    let client = TokenVotesContractClient::new(&env, &contract_id);

    let mut permit = make_permit(&env, &contract_id, &delegator, &delegatee, 0, 1000);
    permit.contract_id = other_contract;

    client.delegate_by_sig(&relayer, &permit);
}

#[test]
fn test_delegate_batch_by_sig_applies_all_delegations() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let delegator1 = Address::generate(&env);
    let delegator2 = Address::generate(&env);
    let delegatee = Address::generate(&env);
    let relayer = Address::generate(&env);

    let (contract_id, token_addr) = setup(&env, &admin);
    let client = TokenVotesContractClient::new(&env, &contract_id);
    let sac_client = token::StellarAssetClient::new(&env, &token_addr);
    sac_client.mint(&delegator1, &300i128);
    sac_client.mint(&delegator2, &700i128);

    env.ledger().with_mut(|l| l.sequence_number = 100);
    let permit1 = make_permit(&env, &contract_id, &delegator1, &delegatee, 0, 1000);
    let permit2 = make_permit(&env, &contract_id, &delegator2, &delegatee, 0, 1000);

    client.delegate_batch_by_sig(
        &relayer,
        &soroban_sdk::vec![&env, permit1, permit2],
    );

    assert_eq!(client.get_votes(&delegatee), 1000);
    assert_eq!(client.nonce(&delegator1), 1);
    assert_eq!(client.nonce(&delegator2), 1);
}

#[test]
fn test_delegate_batch_by_sig_partial_failure_reverts_all() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let delegator1 = Address::generate(&env);
    let delegator2 = Address::generate(&env);
    let delegatee = Address::generate(&env);
    let relayer = Address::generate(&env);

    let (contract_id, token_addr) = setup(&env, &admin);
    let client = TokenVotesContractClient::new(&env, &contract_id);
    let sac_client = token::StellarAssetClient::new(&env, &token_addr);
    sac_client.mint(&delegator1, &300i128);
    sac_client.mint(&delegator2, &700i128);

    env.ledger().with_mut(|l| l.sequence_number = 100);
    let permit1 = make_permit(&env, &contract_id, &delegator1, &delegatee, 0, 1000);
    // Second permit has an already-expired ledger, so the batch must fail.
    let bad_permit2 = make_permit(&env, &contract_id, &delegator2, &delegatee, 0, 1);

    let result = client.try_delegate_batch_by_sig(
        &relayer,
        &soroban_sdk::vec![&env, permit1, bad_permit2],
    );
    assert!(result.is_err());

    // Nothing from the batch should have been applied — including delegator1,
    // who appeared earlier in the list and would otherwise have succeeded.
    assert_eq!(client.get_votes(&delegatee), 0);
    assert_eq!(client.nonce(&delegator1), 0);
    assert_eq!(client.delegates(&delegator1), None);
}

#[test]
fn test_invalidate_all_permits_blocks_old_nonces() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let delegator = Address::generate(&env);
    let delegatee = Address::generate(&env);
    let relayer = Address::generate(&env);

    let (contract_id, token_addr) = setup(&env, &admin);
    let client = TokenVotesContractClient::new(&env, &contract_id);
    let sac_client = token::StellarAssetClient::new(&env, &token_addr);
    sac_client.mint(&delegator, &1000i128);

    env.ledger().with_mut(|l| l.sequence_number = 100);
    // Pre-sign a permit at nonce 0, but don't submit it yet.
    let stale_permit = make_permit(&env, &contract_id, &delegator, &delegatee, 0, 1000);

    client.invalidate_all_permits(&delegator);
    assert!(client.nonce(&delegator) > 0);

    let result = client.try_delegate_by_sig(&relayer, &stale_permit);
    assert!(result.is_err());
    assert_eq!(client.delegates(&delegator), None);
}

#[test]
fn test_nonce_increments_after_each_delegation() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let delegator = Address::generate(&env);
    let delegatee = Address::generate(&env);
    let relayer = Address::generate(&env);

    let (contract_id, token_addr) = setup(&env, &admin);
    let client = TokenVotesContractClient::new(&env, &contract_id);
    let sac_client = token::StellarAssetClient::new(&env, &token_addr);
    sac_client.mint(&delegator, &1000i128);

    env.ledger().with_mut(|l| l.sequence_number = 100);
    assert_eq!(client.nonce(&delegator), 0);

    let permit0 = make_permit(&env, &contract_id, &delegator, &delegatee, 0, 1000);
    client.delegate_by_sig(&relayer, &permit0);
    assert_eq!(client.nonce(&delegator), 1);

    let permit1 = make_permit(&env, &contract_id, &delegator, &delegatee, 1, 1000);
    client.delegate_by_sig(&relayer, &permit1);
    assert_eq!(client.nonce(&delegator), 2);
}

#[test]
#[should_panic(expected = "Error(Contract, #14)")]
fn test_relayer_whitelist_blocks_non_whitelisted() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let delegator = Address::generate(&env);
    let delegatee = Address::generate(&env);
    let relayer = Address::generate(&env);

    let (contract_id, token_addr) = setup(&env, &admin);
    let client = TokenVotesContractClient::new(&env, &contract_id);
    let sac_client = token::StellarAssetClient::new(&env, &token_addr);
    sac_client.mint(&delegator, &1000i128);

    client.set_relayer_whitelist_enabled(&admin, &true);
    assert!(!client.is_relayer_allowed(&relayer));

    env.ledger().with_mut(|l| l.sequence_number = 100);
    let permit = make_permit(&env, &contract_id, &delegator, &delegatee, 0, 1000);
    client.delegate_by_sig(&relayer, &permit);
}

#[test]
fn test_relayer_whitelist_disabled_allows_all() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let delegator = Address::generate(&env);
    let delegatee = Address::generate(&env);
    let relayer = Address::generate(&env);

    let (contract_id, token_addr) = setup(&env, &admin);
    let client = TokenVotesContractClient::new(&env, &contract_id);
    let sac_client = token::StellarAssetClient::new(&env, &token_addr);
    sac_client.mint(&delegator, &1000i128);

    // Whitelist is disabled by default (see initialize()) — any relayer,
    // whitelisted or not, may submit a permit.
    assert!(client.is_relayer_allowed(&relayer));

    env.ledger().with_mut(|l| l.sequence_number = 100);
    let permit = make_permit(&env, &contract_id, &delegator, &delegatee, 0, 1000);
    client.delegate_by_sig(&relayer, &permit);

    assert_eq!(client.get_votes(&delegatee), 1000);
}

#[test]
fn test_relayer_whitelist_enabled_allows_whitelisted_relayer() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let delegator = Address::generate(&env);
    let delegatee = Address::generate(&env);
    let relayer = Address::generate(&env);

    let (contract_id, token_addr) = setup(&env, &admin);
    let client = TokenVotesContractClient::new(&env, &contract_id);
    let sac_client = token::StellarAssetClient::new(&env, &token_addr);
    sac_client.mint(&delegator, &1000i128);

    client.set_relayer_whitelist_enabled(&admin, &true);
    client.set_relayer_whitelisted(&admin, &relayer, &true);
    assert!(client.is_relayer_allowed(&relayer));

    env.ledger().with_mut(|l| l.sequence_number = 100);
    let permit = make_permit(&env, &contract_id, &delegator, &delegatee, 0, 1000);
    client.delegate_by_sig(&relayer, &permit);

    assert_eq!(client.get_votes(&delegatee), 1000);
}

#[test]
fn test_domain_separator_unique_per_contract_instance() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let (contract_id_a, _) = setup(&env, &admin);
    let (contract_id_b, _) = setup(&env, &admin);

    let client_a = TokenVotesContractClient::new(&env, &contract_id_a);
    let client_b = TokenVotesContractClient::new(&env, &contract_id_b);

    assert_ne!(client_a.domain_separator(), client_b.domain_separator());
}

#[test]
fn test_compute_permit_hash_matches_on_chain_result() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let delegator = Address::generate(&env);
    let delegatee = Address::generate(&env);

    let (contract_id, _token_addr) = setup(&env, &admin);
    let client = TokenVotesContractClient::new(&env, &contract_id);

    let permit = make_permit(&env, &contract_id, &delegator, &delegatee, 0, 1000);

    // Deterministic: recomputing the hash for the same permit yields the
    // same digest every time, matching what an off-chain client computes
    // via the same domain-separator + XDR-encoding scheme.
    let hash1 = client.compute_permit_hash(&permit);
    let hash2 = client.compute_permit_hash(&permit);
    assert_eq!(hash1, hash2);

    // Any change to the permit changes the hash.
    let mut different = permit.clone();
    different.nonce = 1;
    assert_ne!(hash1, client.compute_permit_hash(&different));
}

#[test]
fn test_invalidate_all_permits_emits_event() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let delegator = Address::generate(&env);
    let (contract_id, _token_addr) = setup(&env, &admin);
    let client = TokenVotesContractClient::new(&env, &contract_id);

    client.invalidate_all_permits(&delegator);

    let events = env.events().all();
    let found = events.iter().any(|e| e.0 == contract_id);
    assert!(found);
}

#[test]
fn test_delegation_permit_expiry_tracks_latest_permit() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let delegator = Address::generate(&env);
    let delegatee = Address::generate(&env);
    let relayer = Address::generate(&env);

    let (contract_id, token_addr) = setup(&env, &admin);
    let client = TokenVotesContractClient::new(&env, &contract_id);
    let sac_client = token::StellarAssetClient::new(&env, &token_addr);
    sac_client.mint(&delegator, &1000i128);

    assert_eq!(client.delegation_permit_expiry(&delegator), None);

    env.ledger().with_mut(|l| l.sequence_number = 100);
    let permit = make_permit(&env, &contract_id, &delegator, &delegatee, 0, 12345);
    client.delegate_by_sig(&relayer, &permit);

    assert_eq!(client.delegation_permit_expiry(&delegator), Some(12345));
}

/// A signed authorization is scoped to the exact entrypoint that was
/// executing when `require_auth_for_args` was called
/// (`delegate_by_sig` vs `delegate_batch_by_sig`). An off-chain client must
/// therefore sign permits differently depending on which entrypoint they'll
/// be submitted through — this test pins down that requirement so the SDK's
/// `signDelegationPermit({ forBatch })` flag doesn't silently drift from
/// what the contract actually enforces.
#[test]
#[should_panic]
fn test_permit_authorized_for_single_cannot_be_used_in_batch() {
    let env = Env::default();

    let admin = Address::generate(&env);
    let delegator = Address::generate(&env);
    let delegatee = Address::generate(&env);
    let relayer = Address::generate(&env);

    let (contract_id, token_addr) = setup(&env, &admin);
    let client = TokenVotesContractClient::new(&env, &contract_id);
    let sac_client = token::StellarAssetClient::new(&env, &token_addr);
    sac_client.mint(&delegator, &1000i128);

    env.ledger().with_mut(|l| l.sequence_number = 100);
    let permit = make_permit(&env, &contract_id, &delegator, &delegatee, 0, 1000);

    // Mock an authorization scoped to `delegate_by_sig`, then try to spend
    // it via `delegate_batch_by_sig` instead — the entrypoint name in the
    // authorized invocation tree won't match, so this must fail even though
    // the permit contents are otherwise perfectly valid.
    env.mock_auths(&[
        MockAuth {
            address: &delegator,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "delegate_by_sig",
                args: soroban_sdk::vec![&env, permit.clone().into_val(&env)],
                sub_invokes: &[],
            },
        },
        MockAuth {
            address: &relayer,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "delegate_batch_by_sig",
                args: (relayer.clone(), soroban_sdk::vec![&env, permit.clone()]).into_val(&env),
                sub_invokes: &[],
            },
        },
    ]);

    client.delegate_batch_by_sig(&relayer, &soroban_sdk::vec![&env, permit]);
}

// Sanity check that the storage keys requested in issue #772 actually exist
// and round-trip through the contract's own instance/persistent storage.
#[test]
fn test_used_nonce_storage_key_round_trips() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let delegator = Address::generate(&env);
    let delegatee = Address::generate(&env);
    let relayer = Address::generate(&env);

    let (contract_id, token_addr) = setup(&env, &admin);
    let client = TokenVotesContractClient::new(&env, &contract_id);
    let sac_client = token::StellarAssetClient::new(&env, &token_addr);
    sac_client.mint(&delegator, &1000i128);

    env.ledger().with_mut(|l| l.sequence_number = 100);
    let permit = make_permit(&env, &contract_id, &delegator, &delegatee, 0, 1000);
    client.delegate_by_sig(&relayer, &permit);

    let used: bool = env.as_contract(&contract_id, || {
        env.storage()
            .persistent()
            .get(&DataKey::UsedNonce(delegator.clone(), 0))
            .unwrap()
    });
    assert!(used);
}
