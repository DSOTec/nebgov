import { ProposalState } from "@nebgov/sdk";

const STATE_COLORS: Record<ProposalState, string> = {
  [ProposalState.Pending]: "bg-yellow-100 text-yellow-800",
  [ProposalState.Active]: "bg-blue-100 text-blue-800",
  [ProposalState.Succeeded]: "bg-green-100 text-green-800",
  [ProposalState.Defeated]: "bg-red-100 text-red-800",
  [ProposalState.Queued]: "bg-purple-100 text-purple-800",
  [ProposalState.Executed]: "bg-gray-100 text-gray-800",
  [ProposalState.Cancelled]: "bg-gray-100 text-gray-500",
  [ProposalState.Expired]: "bg-rose-100 text-rose-800",
};

interface Props {
  state: ProposalState;
}

export function ProposalStateBadge({ state }: Props) {
  return (
    <span className={`px-3 py-1 rounded-full text-xs font-medium ${STATE_COLORS[state]}`}>
      {state}
    </span>
  );
}
