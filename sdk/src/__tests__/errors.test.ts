import {
  CoSponsorshipError,
  CoSponsorshipErrorCode,
  extractContractErrorCode,
  GovernorError,
  GovernorErrorCode,
  parseCoSponsorshipError,
  parseGovernorError,
  parseTimelockError,
  parseTreasuryError,
  parseVotesError,
  SorobanRpcError,
  TimelockError,
  TimelockErrorCode,
  TreasuryError,
  TreasuryErrorCode,
  VotesError,
  VotesErrorCode,
} from "../errors";

function numericEnumValues<T extends Record<string, string | number>>(
  value: T,
): number[] {
  return Object.values(value).filter(
    (entry): entry is number => typeof entry === "number",
  );
}

describe("extractContractErrorCode", () => {
  it("parses Error(Contract, #N) format", () => {
    expect(extractContractErrorCode("Error(Contract, #3)")).toBe(3);
    expect(extractContractErrorCode({ error: "Error(Contract, #27)" })).toBe(27);
  });

  it("parses ContractError(N) format", () => {
    expect(
      extractContractErrorCode({
        error: "HostError: Value(ContractError(3))",
      }),
    ).toBe(3);
  });

  it("parses legacy contract error format", () => {
    expect(extractContractErrorCode({ error: "contract error: #12" })).toBe(12);
  });

  it("returns null for non-contract errors", () => {
    expect(extractContractErrorCode("some random RPC error")).toBeNull();
    expect(extractContractErrorCode({ error: "ledger not found" })).toBeNull();
  });

  it("returns null for network errors", () => {
    expect(extractContractErrorCode({ error: "fetch failed" })).toBeNull();
    expect(extractContractErrorCode({ status: "ERROR", error: "ECONNRESET" })).toBeNull();
  });

  it("returns null for nullish, empty, and non-string inputs", () => {
    expect(extractContractErrorCode(null)).toBeNull();
    expect(extractContractErrorCode(undefined)).toBeNull();
    expect(extractContractErrorCode("")).toBeNull();
    expect(extractContractErrorCode({})).toBeNull();
    expect(
      extractContractErrorCode({ error: 123 as unknown as string }),
    ).toBeNull();
  });
});

describe("GovernorError", () => {
  it("preserves name, code, cause, and Error inheritance", () => {
    const cause = new Error("root cause");
    const err = new GovernorError(
      GovernorErrorCode.UnauthorizedCancel,
      "Unauthorized",
      cause,
    );

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(GovernorError);
    expect(err.name).toBe("GovernorError");
    expect(err.code).toBe(GovernorErrorCode.UnauthorizedCancel);
    expect(err.cause).toBe(cause);
  });

  it.each(
    numericEnumValues(GovernorErrorCode),
  )("covers GovernorErrorCode value %i", (code) => {
    const err = new GovernorError(code as GovernorErrorCode, `message-${code}`);
    expect(err.code).toBe(code);
    expect(err.message).toBe(`message-${code}`);
  });
});

describe("parseCoSponsorshipError", () => {
  it("maps finalize_draft governor failures to a generic nested-governor message", () => {
    const err = parseCoSponsorshipError(
      { error: "Error(Contract, #6)" },
      undefined,
      "finalize_draft",
    );

    expect(err).toBeInstanceOf(CoSponsorshipError);
    expect(err.code).toBe(CoSponsorshipErrorCode.TransactionFailed);
    expect(err.message).toContain("Governor rejected the underlying proposal");
    expect(err.message).toContain("rate-limited");
  });
});

describe("parseGovernorError", () => {
  const contractCodes = numericEnumValues(GovernorErrorCode).filter(
    (code) => code < 100,
  );

  it("returns typed GovernorError for known codes", () => {
    const err = parseGovernorError({ error: "Error(Contract, #1)" });
    expect(err).toBeInstanceOf(GovernorError);
    expect(err.code).toBe(GovernorErrorCode.UnauthorizedCancel);
    expect(err.message).toContain("proposer or guardian");
  });

  it.each(contractCodes)("handles GovernorErrorCode contract value %i", (code) => {
    const err = parseGovernorError({ error: `Error(Contract, #${code})` });
    expect(err).toBeInstanceOf(GovernorError);
    expect(err.code).toBe(code);
    expect(err.message.length).toBeGreaterThan(0);
  });

  it("does not throw for unknown codes", () => {
    expect(() =>
      parseGovernorError({ error: "Error(Contract, #999)" }),
    ).not.toThrow();

    const err = parseGovernorError({ error: "Error(Contract, #999)" });
    expect(err).toBeInstanceOf(GovernorError);
    expect(err.code).toBe(999 as GovernorErrorCode);
    expect(err.message).toBe("Governor contract error #999");
  });

  it("maps transport failures to TransactionFailed", () => {
    const err = parseGovernorError({
      status: "ERROR",
      error: "network timeout",
    });
    expect(err.code).toBe(GovernorErrorCode.TransactionFailed);
    expect(err.message).toContain("Transaction failed");
    expect(err.message).toContain("network timeout");
  });

  it("maps other failures to SimulationFailed", () => {
    const err = parseGovernorError({
      error: "simulate failed",
    });
    expect(err.code).toBe(GovernorErrorCode.SimulationFailed);
    expect(err.message).toContain("Simulation failed");
  });

  it("handles nullish and malformed inputs without throwing", () => {
    expect(parseGovernorError(null).code).toBe(
      GovernorErrorCode.SimulationFailed,
    );
    expect(parseGovernorError(undefined).code).toBe(
      GovernorErrorCode.SimulationFailed,
    );
    expect(
      parseGovernorError({ error: 42 as unknown as string }).code,
    ).toBe(GovernorErrorCode.SimulationFailed);
  });
});

describe("TimelockError", () => {
  it("preserves name and Error inheritance", () => {
    const err = new TimelockError(
      TimelockErrorCode.OperationExpired,
      "expired",
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(TimelockError);
    expect(err.name).toBe("TimelockError");
  });

  it.each(
    numericEnumValues(TimelockErrorCode),
  )("covers TimelockErrorCode value %i", (code) => {
    const err = new TimelockError(code as TimelockErrorCode, `message-${code}`);
    expect(err.code).toBe(code);
  });
});

describe("parseTimelockError", () => {
  const contractCodes = numericEnumValues(TimelockErrorCode).filter(
    (code) => code < 100,
  );

  it.each(contractCodes)("handles TimelockErrorCode contract value %i", (code) => {
    const err = parseTimelockError({ error: `Error(Contract, #${code})` });
    expect(err).toBeInstanceOf(TimelockError);
    expect(err.code).toBe(code);
    expect(err.message.length).toBeGreaterThan(0);
  });

  it("maps transaction failures", () => {
    const err = parseTimelockError({ status: "ERROR", error: "rejected" });
    expect(err.code).toBe(TimelockErrorCode.TransactionFailed);
    expect(err.message).toContain("Transaction failed");
  });

  it("maps simulation failures", () => {
    const err = parseTimelockError({ error: "simulation rejected" });
    expect(err.code).toBe(TimelockErrorCode.SimulationFailed);
  });
});

describe("TreasuryError", () => {
  it("preserves name and Error inheritance", () => {
    const err = new TreasuryError(
      TreasuryErrorCode.SingleTransferExceeded,
      "too much",
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(TreasuryError);
    expect(err.name).toBe("TreasuryError");
  });

  it.each(
    numericEnumValues(TreasuryErrorCode),
  )("covers TreasuryErrorCode value %i", (code) => {
    const err = new TreasuryError(code as TreasuryErrorCode, `message-${code}`);
    expect(err.code).toBe(code);
  });
});

describe("parseTreasuryError", () => {
  const contractCodes = numericEnumValues(TreasuryErrorCode).filter(
    (code) => code < 100,
  );

  it.each(contractCodes)("handles TreasuryErrorCode contract value %i", (code) => {
    const err = parseTreasuryError({ error: `ContractError(${code})` });
    expect(err).toBeInstanceOf(TreasuryError);
    expect(err.code).toBe(code);
    expect(err.message.length).toBeGreaterThan(0);
  });

  it("maps unknown treasury contract codes without throwing", () => {
    const err = parseTreasuryError({ error: "Error(Contract, #999)" });
    expect(err.code).toBe(999 as TreasuryErrorCode);
    expect(err.message).toBe("Treasury contract error #999");
  });

  it("maps transaction and simulation failures", () => {
    expect(
      parseTreasuryError({ status: "ERROR", error: "submit rejected" }).code,
    ).toBe(TreasuryErrorCode.TransactionFailed);
    expect(parseTreasuryError({ error: "simulate rejected" }).code).toBe(
      TreasuryErrorCode.SimulationFailed,
    );
  });
});

describe("VotesError", () => {
  it("preserves name, cause, and Error inheritance", () => {
    const cause = new Error("votes");
    const err = new VotesError(
      VotesErrorCode.DelegationFailed,
      "failed",
      cause,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(VotesError);
    expect(err.name).toBe("VotesError");
    expect(err.cause).toBe(cause);
  });

  it.each(
    numericEnumValues(VotesErrorCode),
  )("covers VotesErrorCode value %i", (code) => {
    const err = new VotesError(code as VotesErrorCode, `message-${code}`);
    expect(err.code).toBe(code);
  });
});

describe("parseVotesError", () => {
  const contractCodes = numericEnumValues(VotesErrorCode).filter(
    (code) => code < 100,
  );

  it("returns typed VotesError for known codes", () => {
    const err = parseVotesError({ error: "Error(Contract, #10)" });
    expect(err).toBeInstanceOf(VotesError);
    expect(err.code).toBe(VotesErrorCode.InvalidSignature);
    expect(err.message).toContain("delegation signature");
  });

  it.each(contractCodes)("handles VotesErrorCode contract value %i", (code) => {
    const err = parseVotesError({ error: `Error(Contract, #${code})` });
    expect(err).toBeInstanceOf(VotesError);
    expect(err.code).toBe(code);
    expect(err.message.length).toBeGreaterThan(0);
  });

  it("does not drop the raw code for unrecognized codes", () => {
    expect(() =>
      parseVotesError({ error: "Error(Contract, #999)" }),
    ).not.toThrow();

    const err = parseVotesError({ error: "Error(Contract, #999)" });
    expect(err).toBeInstanceOf(VotesError);
    expect(err.code).toBe(999 as VotesErrorCode);
    expect(err.message).toBe("Votes contract error #999");
  });

  it("maps transaction failures", () => {
    const err = parseVotesError({
      status: "ERROR",
      error: "insufficient fee",
    });
    expect(err).toBeInstanceOf(VotesError);
    expect(err.code).toBe(VotesErrorCode.TransactionFailed);
    expect(err.message).toContain("insufficient fee");
  });

  it("maps simulation failures", () => {
    const err = parseVotesError({ error: "simulation failed" });
    expect(err.code).toBe(VotesErrorCode.SimulationFailed);
  });

  it("handles nullish input without throwing", () => {
    expect(parseVotesError(null).code).toBe(VotesErrorCode.SimulationFailed);
    expect(parseVotesError(undefined).code).toBe(
      VotesErrorCode.SimulationFailed,
    );
  });
});
