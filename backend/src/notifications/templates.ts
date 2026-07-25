import type { IndexerEvent, ProposalState, TriggerType } from "./rules";

export interface NotificationMessage {
  subject: string;
  body: string;
  /** Short single-line form for in-app / Telegram delivery. */
  short: string;
  actionUrl?: string;
}

function proposalUrl(proposalId: unknown): string | undefined {
  if (proposalId === undefined || proposalId === null) return undefined;
  return `/proposal/${proposalId}`;
}

function extractProposalId(event: IndexerEvent): unknown {
  const value = event.payload.value;
  if (value && typeof value === "object" && "proposal_id" in (value as Record<string, unknown>)) {
    return (value as Record<string, unknown>).proposal_id;
  }
  if (Array.isArray(value)) return value[0];
  // ProposalQueued/ProposalExecuted carry the id only in topics[1], not value.
  return event.payload.topics?.[1];
}

function extractDelegateeAddress(event: IndexerEvent): string {
  const value = event.payload.value;
  return Array.isArray(value) ? String(value[0]) : "someone";
}

const TEMPLATES: Record<TriggerType, (event: IndexerEvent) => NotificationMessage> = {
  proposal_created: (event) => {
    const proposalId = extractProposalId(event);
    return {
      subject: `New proposal #${proposalId}`,
      body: `A new governance proposal (#${proposalId}) has been created and is now visible on the dashboard.`,
      short: `New proposal #${proposalId} created`,
      actionUrl: proposalUrl(proposalId),
    };
  },
  proposal_state_changed: (event) => {
    const proposalId = extractProposalId(event);
    return {
      subject: `Proposal #${proposalId} update`,
      body: `Proposal #${proposalId} changed state.`,
      short: `Proposal #${proposalId} state changed`,
      actionUrl: proposalUrl(proposalId),
    };
  },
  proposal_vote_threshold: (event) => {
    const proposalId = extractProposalId(event);
    return {
      subject: `Proposal #${proposalId} nearing quorum`,
      body: `Proposal #${proposalId} has reached your configured vote threshold.`,
      short: `Proposal #${proposalId} hit vote threshold`,
      actionUrl: proposalUrl(proposalId),
    };
  },
  proposal_ending_soon: (event) => {
    const proposalId = extractProposalId(event);
    return {
      subject: `Voting closing soon: proposal #${proposalId}`,
      body: `Voting on proposal #${proposalId} is ending soon. Cast your vote before it closes.`,
      short: `Proposal #${proposalId} voting ends soon`,
      actionUrl: proposalUrl(proposalId),
    };
  },
  vote_cast: (event) => {
    const proposalId = extractProposalId(event);
    return {
      subject: `New vote on proposal #${proposalId}`,
      body: `A vote was cast on proposal #${proposalId}.`,
      short: `Vote cast on #${proposalId}`,
      actionUrl: proposalUrl(proposalId),
    };
  },
  guardian_veto: () => ({
    subject: "Guardian veto issued",
    body: "A guardian veto was issued on a proposal you're watching.",
    short: "Guardian veto issued",
  }),
  treasury_stream_spend: () => ({
    subject: "Treasury stream spend",
    body: "A spend was made from a treasury stream you own.",
    short: "Treasury stream spend",
  }),
  config_updated: () => ({
    subject: "Governor configuration updated",
    body: "The governor's configuration parameters were updated.",
    short: "Governor config updated",
  }),
  contract_paused: () => ({
    subject: "Contract paused",
    body: "A governance contract was paused.",
    short: "Contract paused",
  }),
  contract_upgraded: () => ({
    subject: "Governor upgraded",
    body: "The governor contract was upgraded to a new implementation.",
    short: "Governor upgraded",
  }),
  delegation_received: (event) => {
    const delegator = String(event.payload.topics?.[1] ?? "someone");
    return {
      subject: "New delegation received",
      body: `${delegator} delegated their voting power to ${extractDelegateeAddress(event)}.`,
      short: "New delegation received",
    };
  },
  delegation_lost: (event) => {
    const delegator = String(event.payload.topics?.[1] ?? "A delegator");
    return {
      subject: "Delegation revoked",
      body: `${delegator} revoked their delegation to ${extractDelegateeAddress(event)}.`,
      short: "Delegation revoked",
    };
  },
  quorum_reached: (event) => {
    const proposalId = extractProposalId(event);
    return {
      subject: `Proposal #${proposalId} reached quorum`,
      body: `Proposal #${proposalId} has reached quorum.`,
      short: `Proposal #${proposalId} reached quorum`,
      actionUrl: proposalUrl(proposalId),
    };
  },
};

export function renderNotification(
  triggerType: TriggerType,
  event: IndexerEvent,
): NotificationMessage {
  return TEMPLATES[triggerType](event);
}

export function proposalStateLabel(state: ProposalState): string {
  return state;
}
