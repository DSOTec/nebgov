import { ledgerToEstimatedDate, formatCountdown, getProposalTimeInfo } from "../ledgerTime";

describe("ledgerToEstimatedDate", () => {
  it("estimates future date correctly for positive delta", () => {
    const now = Date.now();
    const currentLedger = 1000;
    const targetLedger = 1010;
    const expectedDelta = 10 * 5.5 * 1000;

    const result = ledgerToEstimatedDate(targetLedger, currentLedger);
    const actualDelta = result.getTime() - now;

    expect(actualDelta).toBeGreaterThanOrEqual(expectedDelta - 100);
    expect(actualDelta).toBeLessThanOrEqual(expectedDelta + 100);
  });

  it("estimates past date for negative delta", () => {
    const now = Date.now();
    const currentLedger = 1010;
    const targetLedger = 1000;
    const expectedDelta = -10 * 5.5 * 1000;

    const result = ledgerToEstimatedDate(targetLedger, currentLedger);
    const actualDelta = result.getTime() - now;

    expect(actualDelta).toBeGreaterThanOrEqual(expectedDelta - 100);
    expect(actualDelta).toBeLessThanOrEqual(expectedDelta + 100);
  });

  it("returns current time for same ledger", () => {
    const now = Date.now();
    const result = ledgerToEstimatedDate(1000, 1000);
    expect(Math.abs(result.getTime() - now)).toBeLessThan(100);
  });
});

describe("formatCountdown", () => {
  it("formats days, hours, and minutes", () => {
    const future = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000 + 14 * 60 * 60 * 1000 + 32 * 60 * 1000);
    const result = formatCountdown(future);
    expect(result).toBe("2d 14h 32m");
  });

  it("formats hours and minutes when less than a day", () => {
    const future = new Date(Date.now() + 4 * 60 * 60 * 1000 + 12 * 60 * 1000);
    const result = formatCountdown(future);
    expect(result).toBe("4h 12m");
  });

  it("formats minutes only when less than an hour", () => {
    const future = new Date(Date.now() + 45 * 60 * 1000);
    const result = formatCountdown(future);
    expect(result).toBe("45m");
  });

  it("returns Now for past date", () => {
    const past = new Date(Date.now() - 1000);
    expect(formatCountdown(past)).toBe("Now");
  });
});

describe("getProposalTimeInfo", () => {
  it("returns voting start info for Pending state", () => {
    const result = getProposalTimeInfo("Pending", 1100, 1200, 1000);
    expect(result).not.toBeNull();
    expect(result?.label).toBe("Voting starts in");
    expect(result?.targetLedger).toBe(1100);
  });

  it("returns voting end info for Active state", () => {
    const result = getProposalTimeInfo("Active", 1000, 1200, 1100);
    expect(result).not.toBeNull();
    expect(result?.label).toBe("Voting ends in");
    expect(result?.targetLedger).toBe(1200);
  });

  it("returns veto window info for Queued state when window is open", () => {
    const result = getProposalTimeInfo("Queued", 1000, 1200, 1100, 1300);
    expect(result).not.toBeNull();
    expect(result?.label).toBe("Veto window closes in");
    expect(result?.targetLedger).toBe(1300);
  });

  it("returns null for Queued state when veto window is closed", () => {
    const result = getProposalTimeInfo("Queued", 1000, 1200, 1300, 1200);
    expect(result).toBeNull();
  });

  it("returns null for Queued state without vetoWindowCloseLedger", () => {
    const result = getProposalTimeInfo("Queued", 1000, 1200, 1100);
    expect(result).toBeNull();
  });

  it("returns queue deadline info for Succeeded state when deadline is in the future", () => {
    const result = getProposalTimeInfo("Succeeded", 1000, 1200, 1100, undefined, 1400);
    expect(result).not.toBeNull();
    expect(result?.label).toBe("Queue deadline");
    expect(result?.targetLedger).toBe(1400);
  });

  it("returns null for Succeeded state when deadline is passed", () => {
    const result = getProposalTimeInfo("Succeeded", 1000, 1200, 1500, undefined, 1400);
    expect(result).toBeNull();
  });

  it("returns null for non-time-sensitive states", () => {
    expect(getProposalTimeInfo("Defeated", 1000, 1200, 1300)).toBeNull();
    expect(getProposalTimeInfo("Executed", 1000, 1200, 1300)).toBeNull();
  });

  it("returns null when currentLedger is 0", () => {
    expect(getProposalTimeInfo("Active", 1000, 1200, 0)).toBeNull();
  });
});
