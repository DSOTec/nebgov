import {
  parseConfigUpdatedEvent,
  parseDelegationDepthLimitUpdatedEvent,
  parseDelegationRegisteredEvent,
  parseDelegationRevokedEvent,
  parseGovernorUpgradedEvent,
  parsePauseEvent,
  parseProposalCancelledEvent,
  parseProposalCreatedEvent,
  parseProposalExecutedEvent,
  parseProposalExpiredEvent,
  parseProposalQueuedEvent,
  parseUnpauseEvent,
  parseVoteCastEvent,
  SorobanEvent,
} from "../events";

describe("event parsers", () => {
  it("parses ProposalCreated", () => {
    const event: SorobanEvent = {
      ledger: 1,
      contractId: "C123",
      topic: ["ProposalCreated"],
      value: {
        proposal_id: "1",
        proposer: "GPROPOSER",
        description: "Upgrade config",
        targets: ["CTARGET"],
        fn_names: ["update_config"],
        calldatas: ["deadbeef"],
        start_ledger: 10,
        end_ledger: 20,
      },
    };

    expect(parseProposalCreatedEvent(event)).toEqual({
      proposalId: 1n,
      proposer: "GPROPOSER",
      description: "Upgrade config",
      descriptionHash: "",
      metadataUri: "",
      targets: ["CTARGET"],
      fnNames: ["update_config"],
      calldatas: ["deadbeef"],
      startLedger: 10,
      endLedger: 20,
    });
  });

  it("parses VoteCast", () => {
    const event: SorobanEvent = {
      ledger: 2,
      contractId: "C123",
      topic: ["VoteCast"],
      value: {
        proposal_id: "2",
        voter: "GVOTER",
        support: 1,
        weight: "1000",
      },
    };

    expect(parseVoteCastEvent(event)).toEqual({
      proposalId: 2n,
      voter: "GVOTER",
      support: 1,
      weight: 1000n,
    });
  });

  it("parses ProposalQueued", () => {
    const event: SorobanEvent = {
      ledger: 3,
      contractId: "C123",
      topic: ["ProposalQueued"],
      value: {
        proposal_id: "3",
        op_id: "op-123",
        eta: "999",
      },
    };

    expect(parseProposalQueuedEvent(event)).toEqual({
      proposalId: 3n,
      opId: "op-123",
      eta: 999n,
    });
  });

  it("parses ProposalExecuted", () => {
    const event: SorobanEvent = {
      ledger: 4,
      contractId: "C123",
      topic: ["ProposalExecuted"],
      value: {
        proposal_id: "4",
        caller: "GCALLER",
      },
    };

    expect(parseProposalExecutedEvent(event)).toEqual({
      proposalId: 4n,
      caller: "GCALLER",
    });
  });

  it("parses ProposalCancelled", () => {
    const event: SorobanEvent = {
      ledger: 5,
      contractId: "C123",
      topic: ["ProposalCancelled"],
      value: {
        proposal_id: "5",
        caller: "GCANCELLER",
      },
    };

    expect(parseProposalCancelledEvent(event)).toEqual({
      proposalId: 5n,
      caller: "GCANCELLER",
    });
  });

  it("parses ProposalExpired", () => {
    const event: SorobanEvent = {
      ledger: 6,
      contractId: "C123",
      topic: ["ProposalExpired"],
      value: {
        proposal_id: "6",
        expired_at_ledger: 123,
      },
    };

    expect(parseProposalExpiredEvent(event)).toEqual({
      proposalId: 6n,
      expiredAtLedger: 123,
    });
  });

  it("parses GovernorUpgraded", () => {
    const event: SorobanEvent = {
      ledger: 7,
      contractId: "C123",
      topic: ["GovernorUpgraded"],
      value: {
        old_hash: "old-hash",
        new_hash: "new-hash",
      },
    };

    expect(parseGovernorUpgradedEvent(event)).toEqual({
      oldHash: "old-hash",
      newHash: "new-hash",
    });
  });

  it("parses ConfigUpdated", () => {
    const event: SorobanEvent = {
      ledger: 8,
      contractId: "C123",
      topic: ["ConfigUpdated"],
      value: {
        old_settings: {
          voting_delay: 10,
          voting_period: 20,
          quorum_numerator: 4,
          proposal_threshold: "100",
          proposal_grace_period: 1000,
        },
        new_settings: {
          voting_delay: 15,
          voting_period: 25,
          quorum_numerator: 5,
          proposal_threshold: "200",
          proposal_grace_period: 2000,
        },
      },
    };

    expect(parseConfigUpdatedEvent(event)).toEqual({
      oldSettings: {
        votingDelay: 10,
        votingPeriod: 20,
        quorumNumerator: 4,
        proposalThreshold: 100n,
        guardian: "",
        voteType: "Extended",
        proposalGracePeriod: 1000,
        useDynamicQuorum: false,
        reflectorOracle: null,
        minQuorumUsd: 0n,
        maxCalldataSize: 10000,
        proposalCooldown: 100,
        maxProposalsPerPeriod: 5,
        proposalPeriodDuration: 10000,
      },
      newSettings: {
        votingDelay: 15,
        votingPeriod: 25,
        quorumNumerator: 5,
        proposalThreshold: 200n,
        guardian: "",
        voteType: "Extended",
        proposalGracePeriod: 2000,
        useDynamicQuorum: false,
        reflectorOracle: null,
        minQuorumUsd: 0n,
        maxCalldataSize: 10000,
        proposalCooldown: 100,
        maxProposalsPerPeriod: 5,
        proposalPeriodDuration: 10000,
      },
    });
  });

  it("parses Paused", () => {
    const event: SorobanEvent = {
      ledger: 9,
      contractId: "C123",
      topic: ["Paused", "GPAUSER"],
      value: {
        pauser: "GPAUSER",
        ledger: 9,
      },
    };

    expect(parsePauseEvent(event)).toEqual({
      pauser: "GPAUSER",
      ledger: 9,
    });
  });

  it("parsePauseEvent returns null for wrong topic", () => {
    const event: SorobanEvent = {
      ledger: 9,
      contractId: "C123",
      topic: ["SomethingElse"],
      value: { pauser: "GPAUSER", ledger: 9 },
    };
    expect(parsePauseEvent(event)).toBeNull();
  });

  it("parses Unpaused", () => {
    const event: SorobanEvent = {
      ledger: 10,
      contractId: "C123",
      topic: ["Unpaused"],
      value: {
        ledger: 10,
      },
    };

    expect(parseUnpauseEvent(event)).toEqual({ ledger: 10 });
  });

  it("parseUnpauseEvent returns null for wrong topic", () => {
    const event: SorobanEvent = {
      ledger: 10,
      contractId: "C123",
      topic: ["Paused"],
      value: { ledger: 10 },
    };
    expect(parseUnpauseEvent(event)).toBeNull();
  });

  it("parses DelegationRegistered", () => {
    const event: SorobanEvent = {
      ledger: 11,
      contractId: "C123",
      topic: ["DelegationRegistered", "GDELEGATOR"],
      value: ["GDELEGATEE", "1000", 2],
    };

    expect(parseDelegationRegisteredEvent(event)).toEqual({
      delegator: "GDELEGATOR",
      delegatee: "GDELEGATEE",
      power: 1000n,
      chainDepth: 2,
    });
  });

  it("parseDelegationRegisteredEvent returns null for wrong topic", () => {
    const event: SorobanEvent = {
      ledger: 11,
      contractId: "C123",
      topic: ["SomethingElse", "GDELEGATOR"],
      value: ["GDELEGATEE", "1000", 2],
    };
    expect(parseDelegationRegisteredEvent(event)).toBeNull();
  });

  it("parses DelegationRevoked", () => {
    const event: SorobanEvent = {
      ledger: 12,
      contractId: "C123",
      topic: ["DelegationRevoked", "GDELEGATOR"],
      value: ["GDELEGATEE", 12],
    };

    expect(parseDelegationRevokedEvent(event)).toEqual({
      delegator: "GDELEGATOR",
      previousDelegatee: "GDELEGATEE",
      atLedger: 12,
    });
  });

  it("parseDelegationRevokedEvent returns null for wrong topic", () => {
    const event: SorobanEvent = {
      ledger: 12,
      contractId: "C123",
      topic: ["SomethingElse", "GDELEGATOR"],
      value: ["GDELEGATEE", 12],
    };
    expect(parseDelegationRevokedEvent(event)).toBeNull();
  });

  it("parses DelegationDepthLimitUpdated", () => {
    const event: SorobanEvent = {
      ledger: 13,
      contractId: "C123",
      topic: ["DelegationDepthLimitUpdated"],
      value: [1, 3],
    };

    expect(parseDelegationDepthLimitUpdatedEvent(event)).toEqual({
      oldLimit: 1,
      newLimit: 3,
    });
  });

  it("parseDelegationDepthLimitUpdatedEvent returns null for wrong topic", () => {
    const event: SorobanEvent = {
      ledger: 13,
      contractId: "C123",
      topic: ["SomethingElse"],
      value: [1, 3],
    };
    expect(parseDelegationDepthLimitUpdatedEvent(event)).toBeNull();
  });
});
