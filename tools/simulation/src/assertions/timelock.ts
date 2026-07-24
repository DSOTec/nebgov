import { TimelockClient } from "@nebgov/sdk";
import { AssertionError } from "./errors";

export async function assertOperationReady(client: TimelockClient, opId: string): Promise<void> {
  const ready = await client.isReady(opId);
  if (!ready) throw new AssertionError(`Operation ${opId}: expected to be ready for execution`);
}

/**
 * Best-effort: the real Timelock contract does not expose a direct
 * `is_executed` reader, only `is_ready`/`is_pending`. An operation that is
 * neither ready nor pending has either been executed or cancelled — callers
 * should only use this after independently confirming the operation wasn't
 * cancelled (e.g. via the owning proposal's state).
 */
export async function assertOperationExecuted(client: TimelockClient, opId: string): Promise<void> {
  const [ready, pending] = await Promise.all([client.isReady(opId), client.isPending(opId)]);
  if (ready || pending) {
    throw new AssertionError(`Operation ${opId}: expected to be executed (still ${ready ? "ready" : "pending"})`);
  }
}
