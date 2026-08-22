import {
  Contract,
  rpc,
  TransactionBuilder,
  BASE_FEE,
  Networks,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

// The backend already depends on @stellar/stellar-sdk ^15 (a different major
// version than the ^12 pinned by @nebgov/sdk for the browser app), so this
// talks to Soroban directly rather than taking on a second, mismatched copy
// of the SDK — same reasoning as backend/src/routes/relayer.ts.

export interface ProposalAction {
  target: string;
  fnName: string;
  calldata: Buffer;
}

export interface ActionSimulationOutcome {
  success: boolean;
  args: unknown[];
  returnValue?: unknown;
  revertReason?: string;
}

const NETWORK_PASSPHRASES: Record<string, string> = {
  mainnet: Networks.PUBLIC,
  public: Networks.PUBLIC,
  testnet: Networks.TESTNET,
  futurenet: Networks.FUTURENET,
};

function networkPassphrase(): string {
  const key = (process.env.STELLAR_NETWORK ?? "testnet").toLowerCase();
  return NETWORK_PASSPHRASES[key] ?? Networks.TESTNET;
}

export function rpcServer(): rpc.Server {
  const url = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
  return new rpc.Server(url, { allowHttp: false });
}

function simulationSourceAccount(): string {
  const account = process.env.PROPOSAL_SIMULATION_ACCOUNT;
  if (!account) {
    throw new Error(
      "PROPOSAL_SIMULATION_ACCOUNT must be set to run proposal simulations",
    );
  }
  return account;
}

export function governorContractId(): string {
  const address = process.env.GOVERNOR_CONTRACT_ID;
  if (!address) throw new Error("GOVERNOR_CONTRACT_ID is not configured");
  return address;
}

function safeScValToNative(v: xdr.ScVal): unknown {
  try {
    return scValToNative(v);
  } catch {
    return undefined;
  }
}

/**
 * Decode calldata bytes into invocation args, mirroring the *exact* fallback
 * semantics of the on-chain decoder (contracts/timelock/src/lib.rs's
 * `decode_invocation_args`, contracts/governor/src/lib.rs's
 * `decode_calldata_args`): empty calldata decodes to zero args, and any
 * bytes that don't parse as a `Vec<Val>` XDR value *also* silently decode to
 * zero args rather than throwing. Simulating with this exact (surprising)
 * semantics — not a more lenient decode — is what lets this feature
 * correctly predict on-chain reverts caused by a malformed calldata
 * encoding, such as a proposal action whose calldata is a bare struct/map
 * instead of a one-element args vector.
 */
export function decodeCalldataArgs(calldata: Buffer | Uint8Array): xdr.ScVal[] {
  if (!calldata || calldata.length === 0) return [];
  try {
    const scVal = xdr.ScVal.fromXDR(Buffer.from(calldata));
    if (scVal.switch().name !== "scvVec") return [];
    return scVal.vec() ?? [];
  } catch {
    return [];
  }
}

export async function getLatestLedger(server: rpc.Server): Promise<number> {
  const { sequence } = await server.getLatestLedger();
  return sequence;
}

/**
 * Dry-run one action's target/fn_name/calldata against current ledger state
 * via Soroban RPC's read-only simulateTransaction — no transaction is ever
 * submitted, no state changes.
 */
export async function simulateAction(
  server: rpc.Server,
  action: ProposalAction,
): Promise<ActionSimulationOutcome> {
  const args = decodeCalldataArgs(action.calldata);
  const contract = new Contract(action.target);
  const account = await server.getAccount(simulationSourceAccount());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: networkPassphrase(),
  })
    .addOperation(contract.call(action.fnName, ...args))
    .setTimeout(30)
    .build();

  const result = await server.simulateTransaction(tx);
  const decodedArgs = args.map(safeScValToNative);

  if (rpc.Api.isSimulationError(result)) {
    return { success: false, args: decodedArgs, revertReason: result.error };
  }

  const success = result as rpc.Api.SimulateTransactionSuccessResponse;
  const retval = success.result?.retval;
  return {
    success: true,
    args: decodedArgs,
    returnValue: retval ? safeScValToNative(retval) : undefined,
  };
}

export async function simulateActions(
  server: rpc.Server,
  actions: ProposalAction[],
): Promise<ActionSimulationOutcome[]> {
  const results: ActionSimulationOutcome[] = [];
  for (const action of actions) {
    // Sequential, not Promise.all: each call reuses the same simulation
    // source account's `getAccount()` lookup, and RPC sequence-number
    // handling under concurrent requests for the same account is best
    // avoided rather than relied upon to be race-free.
    results.push(await simulateAction(server, action));
  }
  return results;
}

/**
 * Fetch an already-submitted proposal's targets/fn_names/calldatas directly
 * from the governor contract (`get_proposal`), for simulating a proposal
 * that already exists on-chain rather than a not-yet-submitted draft.
 */
export async function getProposalActions(
  server: rpc.Server,
  proposalId: bigint,
): Promise<{ targets: string[]; fnNames: string[]; calldatas: Buffer[] } | null> {
  const contract = new Contract(governorContractId());
  const account = await server.getAccount(simulationSourceAccount());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: networkPassphrase(),
  })
    .addOperation(
      contract.call("get_proposal", nativeToScVal(proposalId, { type: "u64" })),
    )
    .setTimeout(30)
    .build();

  const result = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(result)) {
    // Contract error #20 is GovernorError::ProposalNotFound
    // (contracts/governor/src/error.rs) — surfaced as `Error(Contract, #20)`
    // by the host, same extraction pattern as relayer.ts's
    // `extractContractErrorCode`.
    if (/Error\(Contract,\s*#20\)/.test(result.error)) return null;
    throw new Error(`Failed to fetch proposal ${proposalId}: ${result.error}`);
  }

  const raw = (result as rpc.Api.SimulateTransactionSuccessResponse).result
    ?.retval;
  if (!raw) return null;

  const proposal = scValToNative(raw) as {
    targets: string[];
    fn_names: string[];
    calldatas: Buffer[];
  };
  return {
    targets: proposal.targets,
    fnNames: proposal.fn_names,
    calldatas: proposal.calldatas.map((c) => Buffer.from(c)),
  };
}
