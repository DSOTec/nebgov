import { ProposerReputation } from "@nebgov/sdk";

type Tier = "elite" | "trusted" | "new" | "caution" | "penalized";

const TIER_CONFIG: Record<Tier, { color: string; icon: string; label: string }> = {
  elite: {
    color: "bg-purple-100 text-purple-800 border border-purple-200",
    icon: "🏆",
    label: "Elite",
  },
  trusted: {
    color: "bg-green-100 text-green-800 border border-green-200",
    icon: "✅",
    label: "Trusted",
  },
  new: {
    color: "bg-gray-100 text-gray-700 border border-gray-200",
    icon: "⚪",
    label: "New",
  },
  caution: {
    color: "bg-amber-100 text-amber-800 border border-amber-200",
    icon: "⚠️",
    label: "Caution",
  },
  penalized: {
    color: "bg-rose-100 text-rose-800 border border-rose-200",
    icon: "🚫",
    label: "Penalized",
  },
};

function tierFor(reputation: ProposerReputation): Tier {
  if (reputation.totalProposals === 0) return "new";
  if (reputation.reputationScore >= 500) return "elite";
  if (reputation.reputationScore > 0) return "trusted";
  if (reputation.reputationScore > -300) return "caution";
  return "penalized";
}

interface Props {
  reputation: ProposerReputation;
}

export function ReputationBadge({ reputation }: Props) {
  const tier = tierFor(reputation);
  const meta = TIER_CONFIG[tier];
  const streak =
    reputation.consecutiveSuccessful > 0
      ? `${reputation.consecutiveSuccessful} succeeded in a row`
      : reputation.consecutiveFailed > 0
        ? `${reputation.consecutiveFailed} failed in a row`
        : "no streak";

  const tooltip = `Score: ${reputation.reputationScore} | Proposals: ${reputation.totalProposals} | Streak: ${streak}`;

  return (
    <span
      className={`px-3 py-1 rounded-full text-xs font-medium ${meta.color}`}
      title={tooltip}
    >
      {meta.icon} {meta.label}
    </span>
  );
}
