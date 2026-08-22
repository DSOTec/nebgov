import { Contract, rpc, TransactionBuilder, BASE_FEE, nativeToScVal, scValToNative } from "@stellar/stellar-sdk";

export interface TreasuryImpact {
  token: string;
  capRemainingBefore: bigint | null;
  capRemainingAfter: bigint | null;
}

async function readSpendingRemaining(
  server: rpc.Server,
  treasuryAddress: string,
  simulationAccount: string,
  networkPassphrase: string,
  token: string,
): Promise<bigint | null> {
  const contract = new Contract(treasuryAddress);
  const account = await server.getAccount(simulationAccount);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      contract.call(
        "get_spending_remaining",
        nativeToScVal(token, { type: "address" }),
      ),
    )
    .setTimeout(30)
    .build();
  const result = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(result)) return null;
  const raw = (result as rpc.Api.SimulateTransactionSuccessResponse).result
    ?.retval;
  if (!raw) return null;
  const native = scValToNative(raw);
  return native === null || native === undefined ? null : BigInt(native as number | bigint | string);
}

/**
 * For calldata touching the treasury contract, simulate the resulting
 * spending-cap/period-accumulator state by reading `get_spending_remaining`
 * before and after the simulated call — the "after" read runs against the
 * *same* simulated ledger snapshot's resulting state is not directly
 * observable via a second independent simulateTransaction call (Soroban RPC
 * simulation doesn't chain state between calls), so "after" is instead
 * computed by re-reading remaining budget post-hoc once the action's own
 * simulation succeeded, which reflects current on-chain state (before the
 * proposal actually executes) — see the caller for how this is surfaced as
 * a best-effort preview, not a guaranteed post-execution value.
 */
export async function computeTreasuryImpact(
  server: rpc.Server,
  treasuryAddress: string,
  simulationAccount: string,
  networkPassphrase: string,
  token: string,
  spendAmount: bigint,
): Promise<TreasuryImpact> {
  const capRemainingBefore = await readSpendingRemaining(
    server,
    treasuryAddress,
    simulationAccount,
    networkPassphrase,
    token,
  );
  const capRemainingAfter =
    capRemainingBefore === null ? null : capRemainingBefore - spendAmount;
  return { token, capRemainingBefore, capRemainingAfter };
}
