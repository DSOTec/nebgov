use super::*;
use soroban_sdk::testutils::storage::Persistent as _;
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::Env;

fn setup() -> (Env, SignalAnchorContractClient<'static>, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let contract_id = env.register(SignalAnchorContract, ());
    let client = SignalAnchorContractClient::new(&env, &contract_id);
    client.initialize(&admin);
    (env, client, admin, contract_id)
}

#[test]
fn anchor_result_succeeds_once() {
    let (env, client, admin, _contract_id) = setup();
    let hash = BytesN::from_array(&env, &[7u8; 32]);

    client.anchor_result(&admin, &1, &hash);

    let record = client.get_anchor(&1).unwrap();
    assert_eq!(record.poll_id, 1);
    assert_eq!(record.result_hash, hash);
    assert_eq!(record.anchorer, admin);
    assert_eq!(record.anchored_ledger, env.ledger().sequence());
}

#[test]
#[should_panic]
fn anchor_result_panics_on_second_call_for_same_poll_id() {
    let (env, client, admin, _contract_id) = setup();
    let hash_a = BytesN::from_array(&env, &[1u8; 32]);
    let hash_b = BytesN::from_array(&env, &[2u8; 32]);

    client.anchor_result(&admin, &1, &hash_a);
    client.anchor_result(&admin, &1, &hash_b);
}

#[test]
fn get_anchor_returns_none_for_unanchored_poll() {
    let (_env, client, _admin, _contract_id) = setup();
    assert_eq!(client.get_anchor(&42), None);
}

#[test]
fn admin_returns_configured_admin() {
    let (_env, client, admin, _contract_id) = setup();
    assert_eq!(client.admin(), admin);
}

#[test]
#[should_panic]
fn admin_panics_before_initialize() {
    let env = Env::default();
    let contract_id = env.register(SignalAnchorContract, ());
    let client = SignalAnchorContractClient::new(&env, &contract_id);
    client.admin();
}

#[test]
#[should_panic]
fn anchor_result_panics_for_non_admin_anchorer() {
    let (env, client, _admin, _contract_id) = setup();
    let stranger = Address::generate(&env);
    let hash = BytesN::from_array(&env, &[3u8; 32]);

    client.anchor_result(&stranger, &1, &hash);
}

#[test]
#[should_panic]
fn initialize_panics_on_second_call() {
    let (_env, client, admin, _contract_id) = setup();
    client.initialize(&admin);
}

#[test]
fn anchor_result_extends_ttl_on_write_and_read() {
    // Regression test for: AnchorRecord never had its persistent-storage TTL
    // extended, unlike every other contract in this repo — it would
    // eventually get archived and get_anchor() would start returning None,
    // contradicting the "can't be silently edited after publication"
    // guarantee this contract exists to provide.
    let (env, client, admin, contract_id) = setup();
    let hash = BytesN::from_array(&env, &[9u8; 32]);
    let key = DataKey::Anchor(1);

    client.anchor_result(&admin, &1, &hash);

    let ttl_after_write =
        env.as_contract(&contract_id, || env.storage().persistent().get_ttl(&key));
    assert_eq!(ttl_after_write, ANCHOR_TTL_LEDGERS);

    // Advance the ledger a small amount so the entry's remaining TTL has
    // visibly decreased, then read it — the read path should re-extend it
    // back to the full ANCHOR_TTL_LEDGERS. Deliberately not advancing
    // anywhere near ANCHOR_TTL_LEDGERS itself: the contract's own instance
    // storage (holding DataKey::Admin) has a separate, much shorter default
    // TTL that was never extended, and archiving it here would fail every
    // subsequent call with an unrelated "archived instance" error before
    // this test's actual assertion is reached.
    env.ledger().with_mut(|li| li.sequence_number += 1000);

    let record = client.get_anchor(&1);
    assert!(record.is_some());

    let ttl_after_read =
        env.as_contract(&contract_id, || env.storage().persistent().get_ttl(&key));
    assert_eq!(ttl_after_read, ANCHOR_TTL_LEDGERS);
}
