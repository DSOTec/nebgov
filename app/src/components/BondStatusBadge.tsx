import { BondState } from "@nebgov/sdk";

const STATE_CONFIG: Record<BondState, { color: string; icon: string; label: string }> = {
  Locked: { color: "bg-blue-100 text-blue-800 border border-blue-200", icon: '🔒', label: 'Locked' },
  Refunded: { color: "bg-green-100 text-green-800 border border-green-200", icon: '✓', label: 'Refunded' },
  Slashed: { color: "bg-red-100 text-red-800 border border-red-200", icon: '✕', label: 'Slashed' },
};

interface Props {
  state: BondState;
}

export function BondStatusBadge({ state }: Props) {
  const meta = STATE_CONFIG[state];

  if (!meta) {
    return (
      <span className="px-3 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-700 border border-gray-200">
        Unknown
      </span>
    );
  }

  return (
    <span className={`px-3 py-1 rounded-full text-xs font-medium ${meta.color}`}>
      {meta.icon} {meta.label}
    </span>
  );
}
