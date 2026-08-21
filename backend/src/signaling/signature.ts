import crypto from "crypto";
import { Keypair } from "@stellar/stellar-sdk";

/**
 * A real cryptographic check, not merely trusting the submitted address —
 * see `backend/src/routes/auth.ts`'s `/login`, which accepts a bare
 * `wallet_address` with no signature verification at all. Signaling
 * integrity depends on this actually being checked.
 */
export interface SignalVotePayload {
  pollId: number;
  choiceIndex: number;
  voterAddress: string;
  nonce: string;
}

const DOMAIN_TAG = "nebgov-signal";

/**
 * Canonical, unambiguous hex digest for a signaling vote:
 * hex(SHA256("nebgov-signal" || poll_id || choice || voter_address ||
 * nonce)). Fields are joined with "|" separators so no field boundary can be
 * ambiguously reinterpreted (e.g. pollId=1,choice=23 vs pollId=12,choice=3).
 *
 * Returned as a **hex string**, not raw digest bytes — a wallet extension's
 * SEP-43 `signMessage(message: string)` only accepts a string. This hex
 * string is the *message* both signing paths hand to the signing step below
 * (`sep53Digest`), not the final signed bytes — see that function's comment
 * for why a raw sign of this string directly would silently reject every
 * real wallet-signed vote.
 */
export function canonicalSignalPayload(payload: SignalVotePayload): string {
  const message = [
    DOMAIN_TAG,
    String(payload.pollId),
    String(payload.choiceIndex),
    payload.voterAddress,
    payload.nonce,
  ].join("|");
  return crypto.createHash("sha256").update(message, "utf8").digest("hex");
}

const SEP53_PREFIX = "Stellar Signed Message:\n";

/**
 * SEP-53 ("Sign and Verify Messages") message-signing digest:
 * SHA256(utf8("Stellar Signed Message:\n") || utf8(message)).
 *
 * A wallet extension's SEP-43 `signMessage` doesn't sign the message's raw
 * bytes directly — per SEP-53 (which Freighter and other wallets implement
 * for `signMessage`), it prefixes the message with this fixed domain string
 * and hashes the result *before* the ed25519 signature is applied, to
 * prevent a signed message from being confused with a real transaction
 * signature. `@stellar/stellar-sdk`'s `Keypair` has no built-in
 * `signMessage`/`verifyMessage` helper (checked against the installed
 * ^12/^15 versions — neither ships one), so both signing paths replicate
 * this construction by hand: the raw-`Keypair` path
 * (`sdk/src/signaling.ts`'s `castVote`) must wrap+hash before calling
 * `Keypair.sign`, and this backend must wrap+hash the same way before
 * calling `Keypair.verify` — skipping this step (an earlier version of this
 * file did) would make every vote cast through a real wallet's
 * `signMessage` fail verification, since the wallet applies this wrapping
 * internally regardless of what the caller does. Exported so this and the
 * SDK's equivalent can both be pinned against the same golden vector — see
 * the "golden vector" tests in `backend/src/__tests__/signaling-signature.test.ts`
 * and `sdk/src/__tests__/signaling.test.ts`.
 */
export function sep53Digest(message: string): Buffer {
  const payload = Buffer.concat([Buffer.from(SEP53_PREFIX, "utf8"), Buffer.from(message, "utf8")]);
  return crypto.createHash("sha256").update(payload).digest();
}

/**
 * Verifies `signature` (base64) was produced by `payload.voterAddress`'s
 * Stellar keypair SEP-53-signing `canonicalSignalPayload(payload)`. Returns
 * false (never throws) for any malformed address, signature, or
 * verification failure, so callers can treat this as a simple boolean gate.
 */
export function verifySignalVote(payload: SignalVotePayload, signatureBase64: string): boolean {
  try {
    const digestHex = canonicalSignalPayload(payload);
    const signature = Buffer.from(signatureBase64, "base64");
    const keypair = Keypair.fromPublicKey(payload.voterAddress);
    return keypair.verify(sep53Digest(digestHex), signature);
  } catch {
    return false;
  }
}
