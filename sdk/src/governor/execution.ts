import {
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
  SorobanRpc,
} from "@stellar/stellar-sdk";
import {
  ExecutionGasEstimate,
} from "../types";
import { GovernorClient, simulationCostValue, toBigInt } from "./governor-client";

/**
 * Simulate the governor's `estimate_execution_gas` view and return its cost hint.
 *
 * `sourceAccount` should be any funded account on the selected network. If it
 * is omitted, the client falls back to the configured governor address for
 * compatibility with existing SDK read methods.
 */
export async function estimateExecutionGas(
  client: GovernorClient,
  proposalId: bigint,
  sourceAccount?: string,
): Promise<ExecutionGasEstimate> {
  return client.retry(async () => {
    const account = await client.server.getAccount(client.readAccount(sourceAccount));
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: client.networkPassphrase,
    })
      .addOperation(
        client.contract.call(
          "estimate_execution_gas",
          nativeToScVal(proposalId, { type: "u64" }),
        ),
      )
      .setTimeout(30)
      .build();

    const result = await client.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(result)) {
      throw new Error(`Simulation error: ${result.error}`);
    }

    const success = result as SorobanRpc.Api.SimulateTransactionSuccessResponse & {
      cost?: Record<string, unknown>;
    };
    const raw = success.result?.retval;
    if (!raw) throw new Error("No return value");

    const native = scValToNative(raw) as Record<string, unknown>;
    return {
      proposalId: toBigInt(native.proposal_id ?? native.proposalId),
      actionCount: Number(native.action_count ?? native.actionCount ?? 0),
      calldataBytes: Number(native.calldata_bytes ?? native.calldataBytes ?? 0),
      estimatedCpuInsns: toBigInt(
        native.estimated_cpu_insns ?? native.estimatedCpuInsns,
      ),
      estimatedMemBytes: toBigInt(
        native.estimated_mem_bytes ?? native.estimatedMemBytes,
      ),
      estimatedFeeStroops: toBigInt(
        native.estimated_fee_stroops ?? native.estimatedFeeStroops,
      ),
      rpcCpuInsns: simulationCostValue(
        success.cost,
        "cpuInsns",
        "cpuInstructions",
      ),
      rpcMemBytes: simulationCostValue(success.cost, "memBytes", "memoryBytes"),
    };
  });
}