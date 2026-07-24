/**
 * Error thrown by a mock executor to model an on-chain `panic_with_error`.
 *
 * Formatted as `Error(Contract, #<code>)` so that `@nebgov/sdk`'s
 * `extractContractErrorCode`/`parseGovernorError` (and the Timelock/Votes
 * equivalents) can recover the same typed error a real deployment would
 * produce.
 */
export class MockContractError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "MockContractError";
  }

  toSorobanErrorString(): string {
    return `Error(Contract, #${this.code})`;
  }
}
