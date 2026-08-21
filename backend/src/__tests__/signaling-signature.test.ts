import { Keypair } from "@stellar/stellar-sdk";
import {
  canonicalSignalPayload,
  sep53Digest,
  verifySignalVote,
  type SignalVotePayload,
} from "../signaling/signature";

// SEP-53-signs the canonical payload — matches what a real wallet's
// signMessage does internally (prefix + re-hash before ed25519 signing) and
// what verifySignalVote checks against. A plain `keypair.sign(digestHex)`
// would fail verification.
function sign(keypair: Keypair, payload: SignalVotePayload): string {
  const digestHex = canonicalSignalPayload(payload);
  return keypair.sign(sep53Digest(digestHex)).toString("base64");
}

describe("signaling signature verification", () => {
  it("accepts a valid signature from the claimed voter", () => {
    const voter = Keypair.random();
    const payload: SignalVotePayload = {
      pollId: 1,
      choiceIndex: 0,
      voterAddress: voter.publicKey(),
      nonce: "nonce-1",
    };

    const signature = sign(voter, payload);

    expect(verifySignalVote(payload, signature)).toBe(true);
  });

  it("rejects a tampered choiceIndex after signing", () => {
    const voter = Keypair.random();
    const original: SignalVotePayload = {
      pollId: 1,
      choiceIndex: 0,
      voterAddress: voter.publicKey(),
      nonce: "nonce-1",
    };
    const signature = sign(voter, original);

    const tampered: SignalVotePayload = { ...original, choiceIndex: 1 };

    expect(verifySignalVote(tampered, signature)).toBe(false);
  });

  it("rejects a signature from a different keypair than the claimed voter_address", () => {
    const voter = Keypair.random();
    const impostor = Keypair.random();
    const payload: SignalVotePayload = {
      pollId: 1,
      choiceIndex: 0,
      voterAddress: voter.publicKey(),
      nonce: "nonce-1",
    };

    const signature = sign(impostor, payload);

    expect(verifySignalVote(payload, signature)).toBe(false);
  });

  it("treats the same nonce as independently valid across two different polls", () => {
    const voter = Keypair.random();
    const payloadPollA: SignalVotePayload = {
      pollId: 1,
      choiceIndex: 0,
      voterAddress: voter.publicKey(),
      nonce: "shared-nonce",
    };
    const payloadPollB: SignalVotePayload = {
      pollId: 2,
      choiceIndex: 0,
      voterAddress: voter.publicKey(),
      nonce: "shared-nonce",
    };

    const signatureA = sign(voter, payloadPollA);
    const signatureB = sign(voter, payloadPollB);

    expect(verifySignalVote(payloadPollA, signatureA)).toBe(true);
    expect(verifySignalVote(payloadPollB, signatureB)).toBe(true);
    // A signature for one poll's payload must not verify against the other poll's payload.
    expect(verifySignalVote(payloadPollB, signatureA)).toBe(false);
  });

  it("rejects a malformed voter address without throwing", () => {
    const payload: SignalVotePayload = {
      pollId: 1,
      choiceIndex: 0,
      voterAddress: "not-a-valid-address",
      nonce: "nonce-1",
    };

    expect(() => verifySignalVote(payload, "AAAA")).not.toThrow();
    expect(verifySignalVote(payload, "AAAA")).toBe(false);
  });

  // Golden vector, cross-checked against sdk/src/__tests__/signaling.test.ts's
  // identical case — both implementations must agree on the exact digest for
  // the same inputs, or vote verification silently breaks for whichever
  // side (wallet-signing vs. raw-Keypair-signing) drifted. If you change the
  // canonical payload format in either package, update BOTH golden vectors
  // together and recompute the expected digest.
  it("matches the golden vector shared with the SDK's implementation", () => {
    const payload: SignalVotePayload = {
      pollId: 42,
      choiceIndex: 1,
      voterAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      nonce: "abc123",
    };

    expect(canonicalSignalPayload(payload)).toBe(
      "a1ca0be6da95546b57dc5ba5f6ca543e7df4cf7c0e077939e26c04d61b591d1f",
    );
  });

  // Golden vector for the SEP-53 wrap itself (prefix + re-hash), cross-checked
  // against sdk/src/__tests__/signaling.test.ts's identical case. This is
  // what actually gets ed25519-signed — a regression here is exactly the
  // "wallet signMessage prefixes the message" footgun this construction
  // exists to handle.
  it("matches the golden SEP-53 digest shared with the SDK's implementation", () => {
    const digestHex = "a1ca0be6da95546b57dc5ba5f6ca543e7df4cf7c0e077939e26c04d61b591d1f";

    expect(sep53Digest(digestHex).toString("hex")).toBe(
      "e5e57e05abfaf71f04f847b94ea5e2ae791527fe39c9236ba42076647a23df01",
    );
  });
});
