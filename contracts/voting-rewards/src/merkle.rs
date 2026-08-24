//! Merkle-drop primitives shared by `claim` and the golden-vector test that
//! pins `backend/src/voting-rewards/merkle.ts` to this encoding.
//!
//! Both halves of the scheme are deliberately spelled out here rather than
//! pulled from a crate: the leaf preimage and the internal-node hashing rule
//! are a cross-language contract with the TypeScript epoch computation
//! service, so they need to be readable in one place and impossible to
//! change on one side only.

use soroban_sdk::{xdr::ToXdr, Address, Bytes, BytesN, Env, Vec};

/// `sha256(claimant || epoch_id || amount)`.
///
/// Encoding, which `merkle.ts` reproduces byte-for-byte:
/// - `claimant`: the XDR of its `ScVal::Address` (what `Address::to_xdr`
///   emits — same address encoding `contracts/timelock` and
///   `contracts/token-votes`' delegation permits already hash), so an
///   account address and a contract address can never collide.
/// - `epoch_id`: `u64` little-endian, matching the `to_le_bytes` convention
///   `contracts/governor`'s commit-reveal preimage established.
/// - `amount`: `i128` little-endian (16 bytes), two's complement.
///
/// The leaf preimage is variable-length and structured, and internal nodes
/// are always exactly 64 bytes of two concatenated digests, so a leaf can
/// never be reinterpreted as an internal node — the usual second-preimage
/// concern for Merkle drops does not apply here.
pub fn compute_leaf(env: &Env, claimant: &Address, epoch_id: u64, amount: i128) -> BytesN<32> {
    let mut preimage = Bytes::new(env);
    preimage.append(&claimant.clone().to_xdr(env));
    preimage.append(&Bytes::from_array(env, &epoch_id.to_le_bytes()));
    preimage.append(&Bytes::from_array(env, &amount.to_le_bytes()));
    env.crypto().sha256(&preimage).into()
}

/// Hash an internal node as `sha256(min(a, b) || max(a, b))`.
///
/// Sorting the pair makes a proof position-independent, which is why
/// `claim`'s `proof` is a bare `Vec<BytesN<32>>` with no direction flags —
/// the same convention every standard Merkle-drop implementation uses.
pub(crate) fn hash_pair(env: &Env, a: &BytesN<32>, b: &BytesN<32>) -> BytesN<32> {
    let (first, second) = if a.to_array() <= b.to_array() {
        (a, b)
    } else {
        (b, a)
    };
    let mut buf = Bytes::new(env);
    buf.append(&Bytes::from_array(env, &first.to_array()));
    buf.append(&Bytes::from_array(env, &second.to_array()));
    env.crypto().sha256(&buf).into()
}

/// Fold `leaf` up through `proof` and check the result against `root`.
pub fn verify_proof(
    env: &Env,
    root: &BytesN<32>,
    leaf: &BytesN<32>,
    proof: &Vec<BytesN<32>>,
) -> bool {
    let mut computed = leaf.clone();
    for sibling in proof.iter() {
        computed = hash_pair(env, &computed, &sibling);
    }
    computed == *root
}
