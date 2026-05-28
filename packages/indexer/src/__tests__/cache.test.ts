import { cached, invalidate, invalidatePattern, getMetrics, resetMetrics } from "../cache";

beforeEach(() => {
  resetMetrics();
  // Clear cache between tests by invalidating known keys
  invalidatePattern("");
});

describe("cached()", () => {
  it("returns data from fn on cache miss", async () => {
    const fn = jest.fn().mockResolvedValue({ value: 42 });
    const result = await cached("test:key", 5000, fn);
    expect(result).toEqual({ value: 42 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("returns cached data on cache hit without calling fn again", async () => {
    const fn = jest.fn().mockResolvedValue({ value: 99 });
    await cached("test:hit", 5000, fn);
    const result = await cached("test:hit", 5000, fn);
    expect(result).toEqual({ value: 99 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("calls fn again after TTL expires", async () => {
    const fn = jest.fn().mockResolvedValue({ value: 1 });
    await cached("test:ttl", 1, fn); // 1ms TTL
    await new Promise((r) => setTimeout(r, 5));
    await cached("test:ttl", 1, fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("tracks hit/miss metrics", async () => {
    const fn = jest.fn().mockResolvedValue("data");
    await cached("test:metrics", 5000, fn); // miss
    await cached("test:metrics", 5000, fn); // hit
    const metrics = getMetrics();
    expect(metrics.hits).toBe(1);
    expect(metrics.misses).toBe(1);
  });
});

describe("invalidate()", () => {
  it("removes a specific key so next call is a miss", async () => {
    const fn = jest.fn().mockResolvedValue("fresh");
    await cached("test:inv", 5000, fn);
    invalidate("test:inv");
    await cached("test:inv", 5000, fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("invalidatePattern()", () => {
  it("removes all keys matching a prefix", async () => {
    const fn = jest.fn().mockResolvedValue("x");
    await cached("proposals:0:20", 5000, fn);
    await cached("proposals:20:20", 5000, fn);
    await cached("delegates:10:0", 5000, fn);
    invalidatePattern("proposals:");
    await cached("proposals:0:20", 5000, fn);
    await cached("proposals:20:20", 5000, fn);
    await cached("delegates:10:0", 5000, fn); // should still be cached
    expect(fn).toHaveBeenCalledTimes(5); // 3 initial + 2 re-fetched proposals, delegates still cached
  });
});
