import { z } from "zod";

/**
 * Trigger types the notification engine can evaluate.
 *
 * `guardian_veto` and `contract_paused` are
 * accepted here and stored on rules like any other trigger, but nothing
 * currently writes those event types into the indexer's `event_log` — the
 * governor contract has no guardian-veto event and there is no pause event
 * wired up yet. Rules using these triggers are valid and
 * persisted but will not fire until a future indexer change emits the
 * corresponding events, matching how `top_delegate_share_bps` was left at 0
 * in the analytics module rather than faked.
 */
export const TRIGGER_TYPES = [
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
] as const;

export type TriggerType = (typeof TRIGGER_TYPES)[number];

export const PROPOSAL_STATES = [
  "Pending",
  "Active",
  "Defeated",
  "Succeeded",
  "Queued",
  "Executed",
  "Cancelled",
  "Expired",
] as const;

export type ProposalState = (typeof PROPOSAL_STATES)[number];

export const CHANNEL_TYPES = ["in_app", "email", "webhook", "telegram"] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

const uintStringSchema = z
  .union([
    z.string().trim().regex(/^\d+$/),
    z.number().int().nonnegative().safe(),
  ])
  .transform(String);

export const triggerConfigSchema = z
  .object({
    proposer: z.string().trim().min(1).optional(),
    from_state: z.enum(PROPOSAL_STATES).optional(),
    to_state: z.enum(PROPOSAL_STATES).optional(),
    threshold_bps: z.coerce.number().int().min(1).max(10000).optional(),
    ledgers_remaining: z.coerce.number().int().min(1).optional(),
    proposal_id: z.coerce.number().int().min(0).optional(),
    voter: z.string().trim().min(1).optional(),
    stream_id: uintStringSchema.optional(),
    min_amount: uintStringSchema.optional(),
    delegatee: z.string().trim().min(1).optional(),
  })
  .strict();

export type TriggerConfig = z.infer<typeof triggerConfigSchema>;

export const channelSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("in_app") }),
  z.object({ type: z.literal("email"), address: z.string().trim().email() }),
  z.object({ type: z.literal("webhook"), url: z.string().trim().url() }),
  z.object({ type: z.literal("telegram"), chat_id: z.string().trim().min(1) }),
]);

export type NotificationChannel = z.infer<typeof channelSchema>;

export const createRuleSchema = z.object({
  name: z.string().trim().min(1).max(128),
  trigger_type: z.enum(TRIGGER_TYPES),
  trigger_config: triggerConfigSchema.optional().default({}),
  channels: z.array(channelSchema).min(1).max(10),
  enabled: z.boolean().optional().default(true),
  cooldown_seconds: z.coerce.number().int().min(0).max(86400).optional().default(300),
});

export const updateRuleSchema = z.object({
  name: z.string().trim().min(1).max(128).optional(),
  trigger_type: z.enum(TRIGGER_TYPES).optional(),
  trigger_config: triggerConfigSchema.optional(),
  channels: z.array(channelSchema).min(1).max(10).optional(),
  enabled: z.boolean().optional(),
  cooldown_seconds: z.coerce.number().int().min(0).max(86400).optional(),
});

export interface NotificationRule {
  id: number;
  user_id: number;
  name: string;
  trigger_type: TriggerType;
  trigger_config: TriggerConfig;
  channels: NotificationChannel[];
  enabled: boolean;
  cooldown_seconds: number;
  last_triggered_at: string | null;
  trigger_count: number;
  created_at: string;
  updated_at: string;
}

export interface IndexerEvent {
  id: number;
  event_type: string;
  ledger: number;
  transaction_hash: string | null;
  contract_address: string;
  payload: { topics: unknown[]; value: unknown; tx_hash?: string };
  indexed_at: string;
}

interface NotificationRuleRow {
  id: number;
  user_id: number;
  name: string;
  trigger_type: TriggerType;
  trigger_config: TriggerConfig | null;
  channels: NotificationChannel[] | null;
  enabled: boolean;
  cooldown_seconds: number;
  last_triggered_at: Date | string | null;
  trigger_count: number;
  created_at: Date | string;
  updated_at: Date | string;
}

export function rowToRule(row: NotificationRuleRow): NotificationRule {
  return {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    trigger_type: row.trigger_type,
    trigger_config: row.trigger_config ?? {},
    channels: row.channels ?? [],
    enabled: row.enabled,
    cooldown_seconds: row.cooldown_seconds,
    last_triggered_at: row.last_triggered_at ? new Date(row.last_triggered_at).toISOString() : null,
    trigger_count: row.trigger_count,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

/**
 * Maps a raw indexer `event_log.event_type` to the trigger type(s) a rule
 * could match on. `proposal_state_changed` is matched separately by the
 * engine (it also needs `to_state`), so it isn't listed here.
 */
export const EVENT_TYPE_TO_TRIGGER: Record<string, TriggerType[]> = {
  ProposalCreated: ["proposal_created"],
  VoteCast: ["vote_cast"],
  VoteCastWithReason: ["vote_cast"],
  ConfigUpdated: ["config_updated"],
  GovernorUpgraded: ["contract_upgraded"],
  DelegationRegistered: ["delegation_received"],
  DelegationRevoked: ["delegation_lost"],
  stream_spend: ["treasury_stream_spend"],
  stream_batch: ["treasury_stream_spend"],
};

export const STATE_CHANGE_EVENTS: Record<string, ProposalState> = {
  ProposalQueued: "Queued",
  ProposalExecuted: "Executed",
  ProposalCancelled: "Cancelled",
};
