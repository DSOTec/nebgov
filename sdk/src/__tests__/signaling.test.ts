import { canonicalSignalPayload, sep53Digest } from "../signaling";

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("canonicalSignalPayload", () => {
  // Golden vector, cross-checked against
  // backend/src/__tests__/signaling-signature.test.ts's identical case —
  // both implementations (this one uses Web Crypto, the backend's uses
  // Node's crypto module) must agree on the exact digest for the same
  // inputs, or vote verification silently breaks for whichever side
  // (wallet-signing vs. raw-Keypair-signing) drifted. If you change the
  // canonical payload format in either package, update BOTH golden vectors
  // together and recompute the expected digest.
  it("matches the golden vector shared with the backend's implementation", async () => {
    const digest = await canonicalSignalPayload(
      42,
      1,
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      "abc123",
    );

    expect(digest).toBe("a1ca0be6da95546b57dc5ba5f6ca543e7df4cf7c0e077939e26c04d61b591d1f");
  });

  it("produces a different digest when any single field changes", async () => {
    const base = await canonicalSignalPayload(1, 0, "GVOTERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "nonce-1");

    expect(await canonicalSignalPayload(2, 0, "GVOTERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "nonce-1")).not.toBe(base);
    expect(await canonicalSignalPayload(1, 1, "GVOTERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "nonce-1")).not.toBe(base);
    expect(await canonicalSignalPayload(1, 0, "GOTHERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "nonce-1")).not.toBe(base);
    expect(await canonicalSignalPayload(1, 0, "GVOTERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "nonce-2")).not.toBe(base);
  });
});

describe("sep53Digest", () => {
  // Golden vector for the SEP-53 wrap itself (prefix + re-hash), cross-checked
  // against backend/src/__tests__/signaling-signature.test.ts's identical
  // case. This is what actually gets ed25519-signed for the raw-Keypair
  // castVote path, and what a SEP-53-compliant wallet's signMessage produces
  // internally for the castVoteWithSign path — a regression here is exactly
  // the "wallet signMessage prefixes the message" footgun this construction
  // exists to handle.
  it("matches the golden digest shared with the backend's implementation", async () => {
    const digestHex = "a1ca0be6da95546b57dc5ba5f6ca543e7df4cf7c0e077939e26c04d61b591d1f";

    const signed = await sep53Digest(digestHex);

    expect(toHex(signed)).toBe("e5e57e05abfaf71f04f847b94ea5e2ae791527fe39c9236ba42076647a23df01");
  });
});
