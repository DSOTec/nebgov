//! Signed vote delegation ("delegate_by_sig"), equivalent to Ethereum's
//! EIP-712 `delegateBySig`: a token holder signs a [`DelegationPermit`]
//! off-chain and a relayer submits it on-chain, paying the fee.
//!
//! ## Why this doesn't use `env.crypto().ed25519_verify()` directly
//!
//! `Address` in Soroban is intentionally opaque — it can represent a classic
//! Ed25519 account, a multisig account, or an arbitrary smart-wallet
//! contract, and none of those expose a raw Ed25519 public key to contract
//! code (there is no `Address` -> `BytesN<32>` conversion in the SDK). The
//! same limitation is documented on the pre-existing `delegate_by_sig` this
//! module replaces (see git history / ADR-005).
//!
//! Instead, verification is delegated to Soroban's native authorization
//! framework via [`Address::require_auth_for_args`]. A relayer collects a
//! `SorobanAuthorizationEntry` that the delegator signed off-chain (offline,
//! without needing a submitted transaction — see `sdk/src/delegation-sig.ts`)
//! and attaches it to the transaction that invokes `delegate_by_sig`. This is
//! audited, host-verified crypto that also transparently supports multisig
//! and smart-wallet delegators, which manual `ed25519_verify` never could.
//!
//! The auth entry is bound to `(this contract, "delegate_by_sig", (permit,))`
//! — deliberately *not* including the `relayer` argument — so the same
//! signed permit is relayer-agnostic and can be submitted by any relayer.
//!
//! On top of Soroban's own (per-invocation, random-nonce) replay protection,
//! this module layers an explicit, sequential, application-level nonce
//! (reusing the existing `DataKey::Nonce`) so permits can be listed,
//! queried, and bulk-invalidated (`invalidate_all_permits`) the way an
//! EIP-712 permit's nonce can.
//!
//! `domain_separator` / `compute_permit_hash` are exposed for off-chain
//! tooling parity (e.g. relayer-side permit fingerprinting/deduplication)
//! and are *not* themselves part of the on-chain signature check.

use soroban_sdk::{contracttype, xdr::ToXdr, Address, BytesN, Env, IntoVal};

use crate::{error::TokenVotesError, DataKey};

/// Domain-separator prefix, mirrors the EIP-712-style string used by the
/// off-chain SDK when it recomputes `domain_separator()` for display/testing.
const DOMAIN_SEPARATOR_PREFIX: &[u8] = b"nebgov::DelegationPermit";

/// Large step applied to a delegator's nonce by `invalidate_all_permits`,
/// guaranteed to jump past any nonce a delegator could plausibly have
/// pre-signed and not yet submitted.
const INVALIDATE_ALL_STEP: u64 = 1_000_000;

/// An off-chain-signed instruction to delegate voting power.
///
/// `chain_id` and `contract_id` bind the permit to a specific network and
/// contract instance, preventing cross-network/cross-contract replay even
/// though Soroban's own auth-entry preimage already includes the network ID
/// and invoked contract — this is deliberate defense in depth, and lets the
/// contract fail with a specific, typed error instead of a generic host
/// auth trap when a permit is replayed against the wrong deployment.
#[contracttype]
#[derive(Clone, Debug)]
pub struct DelegationPermit {
    pub delegator: Address,
    pub delegatee: Address,
    pub nonce: u64,
    pub expiry_ledger: u32,
    pub chain_id: BytesN<32>,
    pub contract_id: Address,
}

/// Compute the domain separator for this contract instance:
/// `sha256("nebgov::DelegationPermit" || contract_id || network_id)`.
pub fn compute_domain_separator(env: &Env) -> BytesN<32> {
    let mut preimage = soroban_sdk::Bytes::from_slice(env, DOMAIN_SEPARATOR_PREFIX);
    preimage.append(&env.current_contract_address().to_xdr(env));
    preimage.append(env.ledger().network_id().as_ref());
    env.crypto().sha256(&preimage).into()
}

/// Read the domain separator cached at `initialize()`.
pub fn domain_separator(env: &Env) -> BytesN<32> {
    env.storage()
        .instance()
        .get(&DataKey::DomainSeparator)
        .unwrap_or_else(|| compute_domain_separator(env))
}

/// Cache the domain separator in instance storage. Called once from
/// `initialize()`.
pub fn init_domain_separator(env: &Env) {
    let separator = compute_domain_separator(env);
    env.storage()
        .instance()
        .set(&DataKey::DomainSeparator, &separator);
}

/// Compute the full signed-message hash for a permit:
/// `sha256(domain_separator || sha256(xdr_encode(permit)))`.
///
/// This mirrors the EIP-712-style digest an off-chain client can recompute
/// to double-check what it's about to sign. It is informational only — the
/// actual on-chain authorization check is performed by Soroban's native
/// auth framework (see [`verify_delegation_permit`]), not by comparing this
/// hash to a signature.
pub fn compute_permit_hash(env: &Env, permit: &DelegationPermit) -> BytesN<32> {
    let permit_xdr = permit.clone().to_xdr(env);
    let permit_hash: BytesN<32> = env.crypto().sha256(&permit_xdr).into();

    let mut preimage = soroban_sdk::Bytes::new(env);
    preimage.append(domain_separator(env).as_ref());
    preimage.append(permit_hash.as_ref());
    env.crypto().sha256(&preimage).into()
}

/// Current expected nonce for `delegator` (the next nonce a valid permit
/// must present).
pub fn current_nonce(env: &Env, delegator: &Address) -> u64 {
    env.storage()
        .persistent()
        .get(&DataKey::Nonce(delegator.clone()))
        .unwrap_or(0)
}

/// Whether `nonce` has ever been consumed by a permit from `delegator`.
pub fn is_nonce_used(env: &Env, delegator: &Address, nonce: u64) -> bool {
    env.storage()
        .persistent()
        .get(&DataKey::UsedNonce(delegator.clone(), nonce))
        .unwrap_or(false)
}

/// Bump `delegator`'s nonce far past anything they may have already signed,
/// invalidating every outstanding unsubmitted permit in one call. Returns
/// the new nonce.
pub fn invalidate_all_permits(env: &Env, delegator: &Address) -> u64 {
    let new_nonce = current_nonce(env, delegator) + INVALIDATE_ALL_STEP;
    env.storage()
        .persistent()
        .set(&DataKey::Nonce(delegator.clone()), &new_nonce);
    new_nonce
}

/// Whether the relayer whitelist is currently enforced.
pub fn relayer_whitelist_enabled(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::RelayerWhitelistEnabled)
        .unwrap_or(false)
}

/// Whether `relayer` may submit signed permits: always true while the
/// whitelist is disabled, otherwise reflects the stored whitelist entry.
pub fn is_relayer_allowed(env: &Env, relayer: &Address) -> bool {
    if !relayer_whitelist_enabled(env) {
        return true;
    }
    env.storage()
        .persistent()
        .get(&DataKey::RelayerWhitelist(relayer.clone()))
        .unwrap_or(false)
}

pub fn set_relayer_whitelist_enabled(env: &Env, enabled: bool) {
    env.storage()
        .instance()
        .set(&DataKey::RelayerWhitelistEnabled, &enabled);
}

pub fn set_relayer_whitelisted(env: &Env, relayer: &Address, whitelisted: bool) {
    env.storage()
        .persistent()
        .set(&DataKey::RelayerWhitelist(relayer.clone()), &whitelisted);
}

/// Latest `expiry_ledger` seen in a successfully-applied permit for
/// `delegator`, or `None` if they have never delegated by signature.
pub fn delegation_permit_expiry(env: &Env, delegator: &Address) -> Option<u32> {
    env.storage()
        .persistent()
        .get(&DataKey::DelegationPermitExpiry(delegator.clone()))
}

/// Validate a [`DelegationPermit`] and cryptographically authorize it via
/// Soroban's native auth framework, then mark its nonce as consumed.
///
/// # Panics
///
/// Panics with the corresponding [`TokenVotesError`] if the permit has
/// expired, targets the wrong network or contract, or presents a nonce other
/// than the delegator's current expected nonce. Panics with a host-level
/// auth error (not a [`TokenVotesError`]) if no valid authorization for
/// `permit.delegator` is attached to the transaction — see the module docs.
pub fn verify_delegation_permit(env: &Env, permit: &DelegationPermit) -> Address {
    if env.ledger().sequence() > permit.expiry_ledger {
        env.panic_with_error(TokenVotesError::PermitExpired);
    }

    if permit.chain_id != env.ledger().network_id() {
        env.panic_with_error(TokenVotesError::InvalidChainId);
    }

    if permit.contract_id != env.current_contract_address() {
        env.panic_with_error(TokenVotesError::InvalidContractId);
    }

    let expected_nonce = current_nonce(env, &permit.delegator);
    if permit.nonce < expected_nonce || is_nonce_used(env, &permit.delegator, permit.nonce) {
        env.panic_with_error(TokenVotesError::NonceAlreadyUsed);
    }
    if permit.nonce > expected_nonce {
        env.panic_with_error(TokenVotesError::InvalidDelegationPermit);
    }

    // Cryptographic verification: require a signed authorization entry from
    // the delegator, scoped to exactly this permit (and no relayer, so it's
    // relayer-agnostic — see module docs).
    let args = soroban_sdk::vec![env, permit.clone().into_val(env)];
    permit.delegator.require_auth_for_args(args);

    env.storage().persistent().set(
        &DataKey::UsedNonce(permit.delegator.clone(), permit.nonce),
        &true,
    );
    env.storage().persistent().set(
        &DataKey::Nonce(permit.delegator.clone()),
        &(permit.nonce + 1),
    );
    env.storage().persistent().set(
        &DataKey::DelegationPermitExpiry(permit.delegator.clone()),
        &permit.expiry_ledger,
    );

    permit.delegator.clone()
}
