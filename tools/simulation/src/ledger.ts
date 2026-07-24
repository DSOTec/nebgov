/**
 * Deterministic ledger-sequence clock for the simulation harness.
 *
 * Mirrors the ledger/timestamp relationship the real network uses so that
 * ledger-based windows (voting delay/period) and timestamp-based windows
 * (timelock delay/execution window) advance in lockstep.
 */
export class LedgerClock {
  /** Approximate seconds per closed ledger on Stellar mainnet/testnet. */
  static readonly SECONDS_PER_LEDGER = 5;

  private current: number;
  private readonly genesisTimestamp: number;

  constructor(initialLedger: number, genesisTimestamp?: number) {
    this.current = initialLedger;
    this.genesisTimestamp = genesisTimestamp ?? Math.floor(Date.now() / 1000);
  }

  /** The current simulated ledger sequence number. */
  get sequence(): number {
    return this.current;
  }

  /** The wall-clock timestamp (unix seconds) implied by the current ledger. */
  get timestamp(): number {
    return this.toWallTime(this.genesisTimestamp).getTime() / 1000;
  }

  /** Advance the clock by an exact number of ledgers. */
  advance(ledgers: number): void {
    if (ledgers < 0) {
      throw new Error(`LedgerClock.advance: ledgers must be >= 0, got ${ledgers}`);
    }
    this.current += ledgers;
  }

  /** Advance until the clock is at or past `targetLedger`. No-op if already there. */
  advanceTo(targetLedger: number): void {
    if (targetLedger > this.current) {
      this.current = targetLedger;
    }
  }

  /** Convert a duration in seconds to the number of ledgers it spans, rounding up. */
  secondsToLedgers(seconds: number): number {
    return Math.ceil(seconds / LedgerClock.SECONDS_PER_LEDGER);
  }

  /** Convert a ledger count to the wall-clock seconds it spans. */
  ledgersToSeconds(ledgers: number): number {
    return ledgers * LedgerClock.SECONDS_PER_LEDGER;
  }

  /** The wall-clock time represented by the current ledger, given a genesis timestamp. */
  toWallTime(genesisTimestamp: number): Date {
    return new Date((genesisTimestamp + this.current * LedgerClock.SECONDS_PER_LEDGER) * 1000);
  }

  /** Take an immutable snapshot of the clock's position for later restore. */
  snapshot(): { current: number; genesisTimestamp: number } {
    return { current: this.current, genesisTimestamp: this.genesisTimestamp };
  }

  /** Restore a previously captured snapshot. */
  restore(snap: { current: number; genesisTimestamp: number }): void {
    this.current = snap.current;
  }
}
