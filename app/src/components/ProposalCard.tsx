import Link from "next/link";
import { ProposalState } from "@nebgov/sdk";
import { ProposalStateBadge } from "./ProposalStateBadge";

export interface ProposalCardProps {
  id: bigint;
  description: string;
  state: ProposalState;
  votesFor: bigint;
  votesAgainst: bigint;
}

export function ProposalCard({ id, description, state, votesFor, votesAgainst }: ProposalCardProps) {
  return (
    <Link
      href={`/proposal/${id}`}
      className="block bg-white border border-gray-200 rounded-xl p-6 hover:border-indigo-300 hover:shadow-sm transition-all"
    >
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <p className="text-xs text-gray-400 mb-1">Proposal #{id.toString()}</p>
          <h2 className="text-lg font-semibold text-gray-900 truncate">{description}</h2>
          <div className="mt-3 flex items-center gap-4 text-sm text-gray-500">
            <span>For: {(Number(votesFor) / 1e7).toLocaleString()}</span>
            <span>Against: {(Number(votesAgainst) / 1e7).toLocaleString()}</span>
          </div>
        </div>
        <ProposalStateBadge state={state} />
      </div>
    </Link>
  );
}
