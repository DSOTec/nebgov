interface Props {
  votesFor: bigint;
  votesAgainst: bigint;
  votesAbstain: bigint;
}

function fmt(n: bigint) {
  return (Number(n) / 1e7).toLocaleString();
}

export function VoteBar({ votesFor, votesAgainst, votesAbstain }: Props) {
  const total = votesFor + votesAgainst + votesAbstain;
  const pctFor = total > 0n ? Number((votesFor * 10000n) / total) / 100 : 0;
  const pctAgainst = total > 0n ? Number((votesAgainst * 10000n) / total) / 100 : 0;
  const pctAbstain = total > 0n ? Number((votesAbstain * 10000n) / total) / 100 : 0;

  return (
    <div className="space-y-2">
      <div className="flex h-2 rounded-full overflow-hidden bg-gray-100">
        <div className="bg-emerald-500" style={{ width: `${pctFor}%` }} />
        <div className="bg-rose-500" style={{ width: `${pctAgainst}%` }} />
        <div className="bg-slate-400" style={{ width: `${pctAbstain}%` }} />
      </div>
      <div className="grid grid-cols-3 gap-2 text-sm">
        <div>
          <span className="text-gray-500">For: </span>
          <span className="font-medium text-emerald-600">{fmt(votesFor)}</span>
        </div>
        <div>
          <span className="text-gray-500">Against: </span>
          <span className="font-medium text-rose-600">{fmt(votesAgainst)}</span>
        </div>
        <div>
          <span className="text-gray-500">Abstain: </span>
          <span className="font-medium text-slate-500">{fmt(votesAbstain)}</span>
        </div>
      </div>
    </div>
  );
}
