import { computeQuadraticWeight, withRetry } from "../utils";

describe("computeQuadraticWeight", () => {
  it("returns 0 for balance of 0", () => {
    expect(computeQuadraticWeight(0n)).toBe(0n);
  });

  it("returns 1 for balance of 1", () => {
    expect(computeQuadraticWeight(1n)).toBe(1n);
  });

  it("handles perfect squares", () => {
    expect(computeQuadraticWeight(4n)).toBe(2n);
    expect(computeQuadraticWeight(9n)).toBe(3n);
    expect(computeQuadraticWeight(100n)).toBe(10n);
    expect(computeQuadraticWeight(10000n)).toBe(100n);
    expect(computeQuadraticWeight(1_000_000n)).toBe(1000n);
  });

  it("floors non-perfect squares", () => {
    expect(computeQuadraticWeight(2n)).toBe(1n);
    expect(computeQuadraticWeight(3n)).toBe(1n);
    expect(computeQuadraticWeight(8n)).toBe(2n);
    expect(computeQuadraticWeight(99n)).toBe(9n);
    expect(computeQuadraticWeight(101n)).toBe(10n);
    expect(computeQuadraticWeight(9999n)).toBe(99n);
  });

  it("handles typical token balances with 7 decimal places", () => {
    // 10,000 tokens at 10^7 scale = 100_000_000_000
    const balance = 100_000_000_000n;
    const weight = computeQuadraticWeight(balance);
    expect(weight).toBe(316227n); // floor(sqrt(100_000_000_000))
  });

  it("throws for negative balance", () => {
    expect(() => computeQuadraticWeight(-1n)).toThrow();
  });
});

describe("withRetry — jitter and backoff", () => {
  it("succeeds on first attempt without any delay", async () => {
    const fn = jest.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, { baseDelayMs: 0 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries and eventually succeeds", async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValue("ok");

    const result = await withRetry(fn, { baseDelayMs: 0, maxAttempts: 3 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("applies jitter on top of exponential base (Math.random spy)", async () => {
    // With Math.random() = 0, jitter = 0 and delay = exponential base.
    // With Math.random() = 1, jitter = exponential * 0.3 (max jitter).
    jest.spyOn(Math, "random").mockReturnValue(0);

    const onRetry = jest.fn();
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error("fail1"))
      .mockRejectedValueOnce(new Error("fail2"))
      .mockResolvedValue("ok");

    const result = await withRetry(fn, {
      baseDelayMs: 0,
      maxDelayMs: 30000,
      maxAttempts: 3,
      onRetry,
    });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);

    jest.restoreAllMocks();
  });

  it("caps delay at maxDelayMs before jitter is added", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0);

    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValue("ok");

    // maxDelayMs=0 collapses exponential to 0, so execution is instant
    const result = await withRetry(fn, {
      baseDelayMs: 999_999,
      maxDelayMs: 0,
      maxAttempts: 2,
    });
    expect(result).toBe("ok");

    jest.restoreAllMocks();
  });

  it("throws after exhausting all attempts", async () => {
    let callCount = 0;
    const fn = jest.fn().mockImplementation(() => {
      callCount++;
      return Promise.reject(new Error("always fails"));
    });
    await expect(withRetry(fn, { baseDelayMs: 0, maxAttempts: 3 })).rejects.toThrow("always fails");
    expect(callCount).toBe(3);
  });

  it("calls onRetry callback with attempt number and error", async () => {
    const onRetry = jest.fn();
    const err = new Error("transient");
    const fn = jest
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValue("done");

    await withRetry(fn, { baseDelayMs: 0, maxAttempts: 3, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, err);
  });

  it("does not retry when retryOn returns false", async () => {
    const fn = jest.fn().mockRejectedValue(new Error("no retry"));
    await expect(
      withRetry(fn, { baseDelayMs: 0, maxAttempts: 3, retryOn: () => false })
    ).rejects.toThrow("no retry");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
