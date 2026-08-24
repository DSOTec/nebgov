import {
  computeProportionalRewards,
  type EpochVoteRow,
} from "../voting-rewards/eligibility";

describe("voting rewards eligibility (issue #1011)", () => {
  const A = "GA3I6MVQC2EXERDKLVWNFGGYEHII5ZVWFS4ZUQGKAP3XRJWR7P5FUGQJ";
  const B = "GAKXV3A3HTPD6VG63VDC7YHEGXFUW64PGVOKPIOYMIXLZRAXLQMG22CN";
  const C = "GAS6QC6USQHIUKQH4EY6KC62IN7Q4NX3M73L3PI7YWQZYHDFQCTB4LZY";

  it("splits the budget in proportion to the voting power cast", () => {
    const votes: EpochVoteRow[] = [
      { voter: A, weight: 300n },
      { voter: B, weight: 100n },
    ];

    const { allocations, totalRewardAmount, totalWeight } = computeProportionalRewards(
      votes,
      1_000n,
    );

    expect(totalWeight).toBe(400n);
    expect(allocations).toEqual([
      { address: A, weight: 300n, amount: 750n },
      { address: B, weight: 100n, amount: 250n },
    ]);
    expect(totalRewardAmount).toBe(1_000n);
  });

  it("credits a voter once per proposal they voted on, rather than deduplicating them away", () => {
    // One address, three proposals in the same epoch. Their three rows must
    // sum, not collapse to a single vote's worth of weight.
    const votes: EpochVoteRow[] = [
      { voter: A, weight: 100n },
      { voter: A, weight: 100n },
      { voter: A, weight: 100n },
      { voter: B, weight: 100n },
    ];

    const { allocations, totalWeight, uniqueVoters } = computeProportionalRewards(votes, 400n);

    expect(totalWeight).toBe(400n);
    expect(uniqueVoters).toBe(2);
    expect(allocations).toEqual([
      { address: A, weight: 300n, amount: 300n },
      { address: B, weight: 100n, amount: 100n },
    ]);
  });

  it("returns an empty, valid result for a zero-participation epoch", () => {
    const result = computeProportionalRewards([], 1_000n);

    expect(result.allocations).toEqual([]);
    expect(result.totalRewardAmount).toBe(0n);
    expect(result.totalWeight).toBe(0n);
    expect(result.uniqueVoters).toBe(0);
  });

  it("returns an empty result rather than dividing by zero when every weight is non-positive", () => {
    const result = computeProportionalRewards(
      [
        { voter: A, weight: 0n },
        { voter: B, weight: -5n },
      ],
      1_000n,
    );

    expect(result.allocations).toEqual([]);
    expect(result.totalRewardAmount).toBe(0n);
  });

  it("floors each share and reports the real total, leaving the remainder in the pool", () => {
    // 10 / 3 each: three equal voters can only be paid 3 apiece.
    const votes: EpochVoteRow[] = [
      { voter: A, weight: 1n },
      { voter: B, weight: 1n },
      { voter: C, weight: 1n },
    ];

    const { allocations, totalRewardAmount } = computeProportionalRewards(votes, 10n);

    expect(allocations.map((a) => a.amount)).toEqual([3n, 3n, 3n]);
    // Published for what is actually claimable, not for the budget — the
    // stray unit stays available for the next epoch.
    expect(totalRewardAmount).toBe(9n);
  });

  it("drops a voter whose share floors to zero, since a zero claim is unclaimable", () => {
    const votes: EpochVoteRow[] = [
      { voter: A, weight: 1_000_000n },
      { voter: B, weight: 1n },
    ];

    const { allocations } = computeProportionalRewards(votes, 100n);

    // B's share is 100 * 1 / 1_000_001, which floors to 0 and is dropped;
    // A's is 100 * 1_000_000 / 1_000_001 = 99, so one unit stays in the pool.
    expect(allocations).toEqual([{ address: A, weight: 1_000_000n, amount: 99n }]);
  });

  it("returns an empty result for a non-positive budget", () => {
    const votes: EpochVoteRow[] = [{ voter: A, weight: 10n }];

    expect(computeProportionalRewards(votes, 0n).allocations).toEqual([]);
    expect(computeProportionalRewards(votes, -1n).allocations).toEqual([]);
  });

  it("orders allocations by address, so the tree never depends on row order", () => {
    const forward: EpochVoteRow[] = [
      { voter: C, weight: 1n },
      { voter: A, weight: 1n },
      { voter: B, weight: 1n },
    ];
    const reversed = [...forward].reverse();

    expect(computeProportionalRewards(forward, 300n)).toEqual(
      computeProportionalRewards(reversed, 300n),
    );
    expect(computeProportionalRewards(forward, 300n).allocations.map((a) => a.address)).toEqual([
      A,
      B,
      C,
    ]);
  });

  it("handles voting power large enough to overflow a double", () => {
    const huge = 2n ** 70n;
    const votes: EpochVoteRow[] = [
      { voter: A, weight: huge },
      { voter: B, weight: huge },
    ];

    const { allocations } = computeProportionalRewards(votes, 1_000n);

    expect(allocations.map((a) => a.amount)).toEqual([500n, 500n]);
  });
});
