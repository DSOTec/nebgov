import { Contract, rpc, TransactionBuilder, BASE_FEE, scValToNative } from "@stellar/stellar-sdk";
import { decodeCalldataArgs, governorContractId } from "./simulate";

/** Fields on `GovernorSettings` worth calling out in an update_config diff, in a stable, readable order. */
const SETTINGS_FIELDS: Array<{ key: string; label: string }> = [
  { key: "voting_delay", label: "voting delay" },
  { key: "voting_period", label: "voting period" },
  { key: "quorum_numerator", label: "quorum numerator" },
  { key: "proposal_threshold", label: "proposal threshold" },
  { key: "guardian", label: "guardian" },
  { key: "proposal_grace_period", label: "proposal grace period" },
  { key: "use_dynamic_quorum", label: "dynamic quorum" },
  { key: "reflector_oracle", label: "reflector oracle" },
  { key: "min_quorum_usd", label: "min quorum (USD)" },
  { key: "max_calldata_size", label: "max calldata size" },
  { key: "proposal_cooldown", label: "proposal cooldown" },
  { key: "max_proposals_per_period", label: "max proposals per period" },
  { key: "proposal_period_duration", label: "proposal period duration" },
  { key: "use_commit_reveal", label: "commit-reveal voting" },
  { key: "commit_phase_fraction", label: "commit phase fraction" },
];

function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return "unset";
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(String).join("/");
  return String(v);
}

async function readCurrentGovernorSettings(
  server: rpc.Server,
  simulationAccount: string,
  networkPassphrase: string,
): Promise<Record<string, unknown> | null> {
  try {
    const contract = new Contract(governorContractId());
    const account = await server.getAccount(simulationAccount);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(contract.call("get_settings"))
      .setTimeout(30)
      .build();
    const result = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(result)) return null;
    const raw = (result as rpc.Api.SimulateTransactionSuccessResponse).result
      ?.retval;
    if (!raw) return null;
    return scValToNative(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function decodeUpdateConfig(
  args: unknown[],
  currentSettings: Record<string, unknown> | null,
): string {
  const proposed = args[0] as Record<string, unknown> | undefined;
  if (!proposed || typeof proposed !== "object") {
    return "update_config: proposed settings are missing or malformed — this action cannot succeed";
  }
  if (!currentSettings) {
    return `update_config: sets ${SETTINGS_FIELDS.length} governor settings fields (current settings unavailable for a diff)`;
  }
  const changes = SETTINGS_FIELDS.filter(({ key }) => {
    const before = currentSettings[key];
    const after = proposed[key];
    const beforeStr = fmtValue(before);
    const afterStr = fmtValue(after);
    return beforeStr !== afterStr && after !== undefined;
  }).map(
    ({ key, label }) =>
      `${label}: ${fmtValue(currentSettings[key])} → ${fmtValue(proposed[key])}`,
  );
  if (changes.length === 0) {
    return "update_config: no effective changes to current settings";
  }
  return `update_config changes ${changes.length} setting${changes.length === 1 ? "" : "s"}: ${changes.join("; ")}`;
}

function decodeTreasurySubmit(args: unknown[]): string {
  const [, target, fnName, data] = args as [unknown, string, string, Buffer];
  if (typeof target !== "string" || typeof fnName !== "string") {
    return "treasury submit: malformed arguments";
  }
  const nestedArgs =
    data instanceof Uint8Array || Buffer.isBuffer(data)
      ? decodeCalldataArgs(Buffer.from(data))
      : [];
  const nestedNative = nestedArgs.map((v) => {
    try {
      return scValToNative(v);
    } catch {
      return "<undecodable>";
    }
  });
  return `Propose treasury transaction: call ${fnName}(${nestedNative.map(fmtValue).join(", ")}) on ${target}`;
}

function decodeBatchTransfer(args: unknown[]): string {
  const [, token, recipients] = args as [
    unknown,
    string,
    Array<{ recipient: string; amount: bigint | number | string }>,
  ];
  if (!Array.isArray(recipients)) return "batch_transfer: malformed recipients";
  const total = recipients.reduce(
    (sum, r) => sum + BigInt(r.amount ?? 0),
    0n,
  );
  return `Batch transfer ${total.toString()} units of ${token} to ${recipients.length} recipient${recipients.length === 1 ? "" : "s"} (${recipients
    .slice(0, 3)
    .map((r) => `${r.recipient}: ${fmtValue(r.amount)}`)
    .join(", ")}${recipients.length > 3 ? ", ..." : ""})`;
}

function decodeCreateStream(args: unknown[]): string {
  const [, name, owner, token, totalAllocated] = args as [
    unknown,
    string,
    string,
    string,
    bigint | number | string,
  ];
  return `Create stream "${fmtValue(name)}" paying ${fmtValue(totalAllocated)} units of ${token} to ${owner}`;
}

function decodeDelegate(args: unknown[]): string {
  const [delegator, delegatee] = args as [string, string];
  return `Delegate ${delegator}'s voting power to ${delegatee}`;
}

/**
 * Best-effort human-readable decoding of a proposal action. Known
 * target/fn_name pairs get a plain-English description; everything else
 * falls back to the raw decoded args rather than failing the whole preview.
 */
export async function decodeAction(
  server: rpc.Server,
  simulationAccount: string,
  networkPassphrase: string,
  target: string,
  fnName: string,
  args: unknown[],
  treasuryAddress: string | undefined,
): Promise<string> {
  // GOVERNOR_CONTRACT_ID may legitimately be unset in contexts that only
  // preview draft actions targeting other contracts — this decoder must
  // degrade to the generic fallback below rather than throw, per its
  // "best-effort" contract.
  const governorAddress = process.env.GOVERNOR_CONTRACT_ID;
  if (governorAddress && target === governorAddress && fnName === "update_config") {
    const current = await readCurrentGovernorSettings(
      server,
      simulationAccount,
      networkPassphrase,
    );
    return decodeUpdateConfig(args, current);
  }

  if (treasuryAddress && target === treasuryAddress) {
    if (fnName === "submit" || fnName === "submit_with_limit") {
      return decodeTreasurySubmit(args);
    }
    if (fnName === "batch_transfer") return decodeBatchTransfer(args);
    if (fnName === "create_stream") return decodeCreateStream(args);
  }

  if (fnName === "delegate" || fnName === "delegate_batch") {
    return decodeDelegate(args);
  }

  return `${fnName}(${args.map(fmtValue).join(", ")}) on ${target}`;
}
