"use client";

import { useState } from "react";
import { X } from "lucide-react";
import {
  useNotifications,
  type CreateRuleParams,
  type NotificationChannel,
  type TriggerConfig,
  type TriggerType,
} from "../hooks/useNotifications";

const TRIGGER_OPTIONS: { value: TriggerType; label: string; description: string }[] = [
  { value: "proposal_created", label: "Proposal created", description: "A new proposal is created (optionally by a specific proposer)." },
  { value: "proposal_state_changed", label: "Proposal state changed", description: "A proposal is queued, executed, or cancelled." },
  { value: "vote_cast", label: "Vote cast", description: "A vote is cast, optionally on a specific proposal or by a specific voter." },
  { value: "proposal_ending_soon", label: "Voting ending soon", description: "An active proposal is within N ledgers of its end." },
  { value: "delegation_received", label: "Delegation received", description: "Someone delegates their voting power to an address." },
  { value: "delegation_lost", label: "Delegation revoked", description: "A delegation is revoked from an address." },
  { value: "config_updated", label: "Governor config updated", description: "The governor's configuration parameters change." },
  { value: "contract_upgraded", label: "Governor upgraded", description: "The governor contract is upgraded." },
  { value: "guardian_veto", label: "Guardian veto", description: "A guardian vetoes a proposal. (Not yet emitted on-chain.)" },
  { value: "treasury_stream_spend", label: "Treasury stream spend", description: "A spend is made from a treasury stream. (Not yet emitted on-chain.)" },
  { value: "contract_paused", label: "Contract paused", description: "A governance contract is paused. (Not yet emitted on-chain.)" },
  { value: "proposal_vote_threshold", label: "Vote threshold reached", description: "A proposal reaches a % of quorum. (Not yet computable — see docs.)" },
  { value: "quorum_reached", label: "Quorum reached", description: "A proposal reaches quorum. (Not yet computable — see docs.)" },
];

const STEPS = ["Trigger", "Configure", "Channels", "Review"] as const;

interface Props {
  onClose: () => void;
  onCreated?: () => void;
}

export function NotificationRuleBuilder({ onClose, onCreated }: Props) {
  const { createRule } = useNotifications();
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [triggerType, setTriggerType] = useState<TriggerType>("proposal_created");
  const [config, setConfig] = useState<TriggerConfig>({});
  const [channels, setChannels] = useState<NotificationChannel[]>([{ type: "in_app" }]);
  const [cooldownSeconds, setCooldownSeconds] = useState(300);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleChannel(type: NotificationChannel["type"], enabled: boolean) {
    setChannels((prev) => {
      if (enabled) {
        if (prev.some((c) => c.type === type)) return prev;
        const next: NotificationChannel =
          type === "email"
            ? { type: "email", address: "" }
            : type === "webhook"
              ? { type: "webhook", url: "" }
              : type === "telegram"
                ? { type: "telegram", chat_id: "" }
                : { type: "in_app" };
        return [...prev, next];
      }
      return prev.filter((c) => c.type !== type);
    });
  }

  function updateChannelField(type: NotificationChannel["type"], field: string, value: string) {
    setChannels((prev) =>
      prev.map((c) => (c.type === type ? ({ ...c, [field]: value } as NotificationChannel) : c)),
    );
  }

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      const params: CreateRuleParams = {
        name: name.trim() || TRIGGER_OPTIONS.find((t) => t.value === triggerType)?.label || "Untitled rule",
        trigger_type: triggerType,
        trigger_config: config,
        channels,
        cooldown_seconds: cooldownSeconds,
        enabled: true,
      };
      await createRule(params);
      onCreated?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create rule");
    } finally {
      setSubmitting(false);
    }
  }

  const canProceedFromChannels = channels.every((c) => {
    if (c.type === "email") return c.address.trim().length > 0;
    if (c.type === "webhook") return c.url.trim().length > 0;
    if (c.type === "telegram") return c.chat_id.trim().length > 0;
    return true;
  }) && channels.length > 0;

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div className="relative w-full max-w-lg bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-100 dark:border-gray-800 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 dark:border-gray-800">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">New notification rule</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            <X className="w-5 h-5" aria-hidden />
          </button>
        </div>

        <div className="px-5 pt-4 flex items-center gap-2">
          {STEPS.map((label, i) => (
            <div key={label} className="flex-1">
              <div className={`h-1 rounded-full ${i <= step ? "bg-indigo-600" : "bg-gray-200 dark:bg-gray-700"}`} />
              <p className={`text-[11px] mt-1 ${i === step ? "text-indigo-600 font-medium" : "text-gray-400"}`}>
                {label}
              </p>
            </div>
          ))}
        </div>

        <div className="px-5 py-5 max-h-[60vh] overflow-y-auto">
          {step === 0 && (
            <div className="space-y-2">
              {TRIGGER_OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  className={`block p-3 rounded-xl border cursor-pointer transition-colors ${
                    triggerType === opt.value
                      ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-900/20"
                      : "border-gray-200 dark:border-gray-700 hover:border-gray-300"
                  }`}
                >
                  <input
                    type="radio"
                    name="trigger-type"
                    className="sr-only"
                    checked={triggerType === opt.value}
                    onChange={() => setTriggerType(opt.value)}
                  />
                  <span className="block text-sm font-medium text-gray-900 dark:text-white">{opt.label}</span>
                  <span className="block text-xs text-gray-500 dark:text-gray-400 mt-0.5">{opt.description}</span>
                </label>
              ))}
            </div>
          )}

          {step === 1 && (
            <TriggerConfigFields triggerType={triggerType} config={config} onChange={setConfig} />
          )}

          {step === 2 && (
            <div className="space-y-3">
              <ChannelRow
                label="In-app"
                checked={channels.some((c) => c.type === "in_app")}
                onToggle={(v) => toggleChannel("in_app", v)}
              />
              <ChannelRow
                label="Email"
                checked={channels.some((c) => c.type === "email")}
                onToggle={(v) => toggleChannel("email", v)}
              >
                {channels.find((c) => c.type === "email") && (
                  <input
                    type="email"
                    placeholder="you@example.com"
                    value={(channels.find((c) => c.type === "email") as { address: string }).address}
                    onChange={(e) => updateChannelField("email", "address", e.target.value)}
                    className="mt-2 w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent px-3 py-2 text-sm"
                  />
                )}
              </ChannelRow>
              <ChannelRow
                label="Webhook"
                checked={channels.some((c) => c.type === "webhook")}
                onToggle={(v) => toggleChannel("webhook", v)}
              >
                {channels.find((c) => c.type === "webhook") && (
                  <input
                    type="url"
                    placeholder="https://example.com/hooks/nebgov"
                    value={(channels.find((c) => c.type === "webhook") as { url: string }).url}
                    onChange={(e) => updateChannelField("webhook", "url", e.target.value)}
                    className="mt-2 w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent px-3 py-2 text-sm"
                  />
                )}
              </ChannelRow>
              <ChannelRow
                label="Telegram"
                checked={channels.some((c) => c.type === "telegram")}
                onToggle={(v) => toggleChannel("telegram", v)}
              >
                {channels.find((c) => c.type === "telegram") && (
                  <input
                    type="text"
                    placeholder="Chat ID"
                    value={(channels.find((c) => c.type === "telegram") as { chat_id: string }).chat_id}
                    onChange={(e) => updateChannelField("telegram", "chat_id", e.target.value)}
                    className="mt-2 w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent px-3 py-2 text-sm"
                  />
                )}
              </ChannelRow>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Rule name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={TRIGGER_OPTIONS.find((t) => t.value === triggerType)?.label}
                  className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">
                  Cooldown between notifications (seconds)
                </label>
                <input
                  type="number"
                  min={0}
                  value={cooldownSeconds}
                  onChange={(e) => setCooldownSeconds(Number(e.target.value))}
                  className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent px-3 py-2 text-sm"
                />
              </div>
              {error && <p className="text-sm text-rose-600">{error}</p>}
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t border-gray-100 dark:border-gray-800 flex items-center justify-between">
          <button
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={step === 0}
            className="text-sm font-medium text-gray-500 disabled:opacity-40"
          >
            Back
          </button>
          {step < STEPS.length - 1 ? (
            <button
              onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}
              disabled={step === 2 && !canProceedFromChannels}
              className="px-4 py-2 rounded-full bg-indigo-600 text-white text-sm font-semibold disabled:opacity-50"
            >
              Next
            </button>
          ) : (
            <button
              onClick={() => void handleSubmit()}
              disabled={submitting}
              className="px-4 py-2 rounded-full bg-indigo-600 text-white text-sm font-semibold disabled:opacity-50"
            >
              {submitting ? "Creating…" : "Create rule"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ChannelRow({
  label,
  checked,
  onToggle,
  children,
}: {
  label: string;
  checked: boolean;
  onToggle: (v: boolean) => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="p-3 rounded-xl border border-gray-200 dark:border-gray-700">
      <label className="flex items-center gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onToggle(e.target.checked)}
          className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
        />
        <span className="text-sm font-medium text-gray-900 dark:text-white">{label}</span>
      </label>
      {children}
    </div>
  );
}

function TriggerConfigFields({
  triggerType,
  config,
  onChange,
}: {
  triggerType: TriggerType;
  config: TriggerConfig;
  onChange: (config: TriggerConfig) => void;
}) {
  function set(field: keyof TriggerConfig, value: string) {
    onChange({ ...config, [field]: value === "" ? undefined : value });
  }

  const fields: React.ReactNode[] = [];

  if (triggerType === "proposal_created") {
    fields.push(
      <TextField key="proposer" label="Proposer address (optional)" value={config.proposer ?? ""} onChange={(v) => set("proposer", v)} />,
    );
  }
  if (triggerType === "proposal_state_changed") {
    fields.push(
      <div key="to_state">
        <label className="block text-xs font-medium text-gray-500 mb-1">New state</label>
        <select
          value={config.to_state ?? ""}
          onChange={(e) => set("to_state", e.target.value)}
          className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent px-3 py-2 text-sm"
        >
          <option value="">Any</option>
          <option value="Queued">Queued</option>
          <option value="Executed">Executed</option>
          <option value="Cancelled">Cancelled</option>
        </select>
      </div>,
    );
  }
  if (triggerType === "vote_cast") {
    fields.push(
      <TextField key="proposal_id" label="Proposal ID (optional)" value={config.proposal_id?.toString() ?? ""} onChange={(v) => set("proposal_id", v)} />,
      <TextField key="voter" label="Voter address (optional)" value={config.voter ?? ""} onChange={(v) => set("voter", v)} />,
    );
  }
  if (triggerType === "proposal_ending_soon") {
    fields.push(
      <TextField key="ledgers_remaining" label="Ledgers remaining threshold" value={config.ledgers_remaining?.toString() ?? "500"} onChange={(v) => set("ledgers_remaining", v)} />,
    );
  }
  if (triggerType === "proposal_vote_threshold") {
    fields.push(
      <TextField key="threshold_bps" label="Threshold (basis points of quorum)" value={config.threshold_bps?.toString() ?? "8000"} onChange={(v) => set("threshold_bps", v)} />,
    );
  }
  if (triggerType === "delegation_received" || triggerType === "delegation_lost") {
    fields.push(
      <TextField key="delegatee" label="Your delegatee address (optional — leave blank to match everyone)" value={config.delegatee ?? ""} onChange={(v) => set("delegatee", v)} />,
    );
  }

  if (fields.length === 0) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400">
        This trigger has no additional configuration — it fires for every matching event.
      </p>
    );
  }

  return <div className="space-y-4">{fields}</div>;
}

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-500 mb-1">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent px-3 py-2 text-sm"
      />
    </div>
  );
}
