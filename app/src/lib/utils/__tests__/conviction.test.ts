import { convictionProgressPercent } from "../../conviction";

describe("convictionProgressPercent", () => {
  it("calculates progress from conviction and the required threshold", () => {
    expect(convictionProgressPercent(25n, 100n)).toBe(25);
    expect(convictionProgressPercent(999n, 1_000n)).toBe(99.9);
  });

  it("caps progress when conviction reaches or exceeds the threshold", () => {
    expect(convictionProgressPercent(100n, 100n)).toBe(100);
    expect(convictionProgressPercent(250n, 100n)).toBe(100);
  });

  it("returns zero until a valid threshold and conviction are available", () => {
    expect(convictionProgressPercent(50n, undefined)).toBe(0);
    expect(convictionProgressPercent(50n, 0n)).toBe(0);
    expect(convictionProgressPercent(0n, 100n)).toBe(0);
  });
});
