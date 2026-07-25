import { ruleMatchesEvent } from "../notifications/engine";
import { renderNotification } from "../notifications/templates";
import type { IndexerEvent, NotificationRule, TriggerType } from "../notifications/rules";

function makeRule(overrides: Partial<NotificationRule> = {}): NotificationRule {
  return {
    id: 1,
    user_id: 1,
    name: "Test rule",
    trigger_type: "proposal_created",
    trigger_config: {},
    channels: [{ type: "in_app" }],
    enabled: true,
    cooldown_seconds: 300,
    last_triggered_at: null,
    trigger_count: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeEvent(overrides: Partial<IndexerEvent> = {}): IndexerEvent {
  return {
    id: 1,
    event_type: "ProposalCreated",
    ledger: 100,
    transaction_hash: "abc",
    contract_address: "C123",
    payload: { topics: ["ProposalCreated", "GPROPOSER"], value: { proposal_id: "5" } },
    indexed_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("ruleMatchesEvent", () => {
  it("matches proposal_created with no proposer filter", () => {
    const rule = makeRule({ trigger_type: "proposal_created" });
    const event = makeEvent({ event_type: "ProposalCreated" });
    expect(ruleMatchesEvent(rule, event)).toBe(true);
  });

  it("filters proposal_created by proposer", () => {
    const rule = makeRule({
      trigger_type: "proposal_created",
      trigger_config: { proposer: "GOTHER" },
    });
    const event = makeEvent({
      event_type: "ProposalCreated",
      payload: { topics: ["ProposalCreated", "GPROPOSER"], value: { proposal_id: "5", proposer: "GPROPOSER" } },
    });
    expect(ruleMatchesEvent(rule, event)).toBe(false);
  });

  it("matches proposal_created when proposer filter matches", () => {
    const rule = makeRule({
      trigger_type: "proposal_created",
      trigger_config: { proposer: "GPROPOSER" },
    });
    const event = makeEvent({
      event_type: "ProposalCreated",
      payload: { topics: ["ProposalCreated", "GPROPOSER"], value: { proposal_id: "5", proposer: "GPROPOSER" } },
    });
    expect(ruleMatchesEvent(rule, event)).toBe(true);
  });

  it("matches proposal_state_changed only for the configured to_state", () => {
    const rule = makeRule({
      trigger_type: "proposal_state_changed",
      trigger_config: { to_state: "Executed" },
    });
    const queuedEvent = makeEvent({ event_type: "ProposalQueued", payload: { topics: ["ProposalQueued", "5"], value: undefined } });
    const executedEvent = makeEvent({ event_type: "ProposalExecuted", payload: { topics: ["ProposalExecuted", "5"], value: undefined } });

    expect(ruleMatchesEvent(rule, queuedEvent)).toBe(false);
    expect(ruleMatchesEvent(rule, executedEvent)).toBe(true);
  });

  it("filters vote_cast by proposal_id and voter", () => {
    const rule = makeRule({
      trigger_type: "vote_cast",
      trigger_config: { proposal_id: 5, voter: "GVOTER" },
    });
    const matching = makeEvent({
      event_type: "VoteCast",
      payload: { topics: ["VoteCast", "GVOTER"], value: ["5", 1, "1000"] },
    });
    const wrongVoter = makeEvent({
      event_type: "VoteCast",
      payload: { topics: ["VoteCast", "GSOMEONEELSE"], value: ["5", 1, "1000"] },
    });
    const wrongProposal = makeEvent({
      event_type: "VoteCast",
      payload: { topics: ["VoteCast", "GVOTER"], value: ["9", 1, "1000"] },
    });

    expect(ruleMatchesEvent(rule, matching)).toBe(true);
    expect(ruleMatchesEvent(rule, wrongVoter)).toBe(false);
    expect(ruleMatchesEvent(rule, wrongProposal)).toBe(false);
  });

  it("filters delegation_received by delegatee address", () => {
    const rule = makeRule({
      trigger_type: "delegation_received",
      trigger_config: { delegatee: "GDELEGATEE" },
    });
    const matching = makeEvent({
      event_type: "DelegationRegistered",
      payload: { topics: ["DelegationRegistered", "GDELEGATOR"], value: ["GDELEGATEE", "1000", 1] },
    });
    const nonMatching = makeEvent({
      event_type: "DelegationRegistered",
      payload: { topics: ["DelegationRegistered", "GDELEGATOR"], value: ["GOTHER", "1000", 1] },
    });

    expect(ruleMatchesEvent(rule, matching)).toBe(true);
    expect(ruleMatchesEvent(rule, nonMatching)).toBe(false);
  });

  it("matches proposal_ending_soon only within the configured ledger window", () => {
    const rule = makeRule({
      trigger_type: "proposal_ending_soon",
      trigger_config: { ledgers_remaining: 100 },
    });
    const soon = makeEvent({
      event_type: "proposal_ending_soon",
      payload: { topics: [], value: { proposal_id: "5", remaining_ledgers: 50 } },
    });
    const notSoon = makeEvent({
      event_type: "proposal_ending_soon",
      payload: { topics: [], value: { proposal_id: "5", remaining_ledgers: 500 } },
    });

    expect(ruleMatchesEvent(rule, soon)).toBe(true);
    expect(ruleMatchesEvent(rule, notSoon)).toBe(false);
  });
});

describe("renderNotification", () => {
  const triggerTypes: TriggerType[] = [
    "proposal_created",
    "proposal_state_changed",
    "proposal_vote_threshold",
    "proposal_ending_soon",
    "vote_cast",
    "guardian_veto",
    "treasury_stream_spend",
    "config_updated",
    "contract_paused",
    "contract_upgraded",
    "delegation_received",
    "delegation_lost",
    "quorum_reached",
  ];

  it.each(triggerTypes)("renders a non-empty subject and body for %s", (trigger) => {
    const event = makeEvent({
      payload: {
        topics: ["x", "GADDR"],
        value: { proposal_id: "5", delegatee: "GDELEGATEE" },
      },
    });
    const message = renderNotification(trigger, event);
    expect(message.subject.length).toBeGreaterThan(0);
    expect(message.body.length).toBeGreaterThan(0);
    expect(message.short.length).toBeGreaterThan(0);
  });

  it("includes an actionUrl for proposal-scoped triggers", () => {
    const event = makeEvent({ payload: { topics: ["x"], value: { proposal_id: "42" } } });
    const message = renderNotification("proposal_created", event);
    expect(message.actionUrl).toBe("/proposal/42");
  });
});
