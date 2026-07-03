import {
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import {
  Proposal,
  ProposalState,
  VoteSupport,
} from "../types";
import { GovernorClient } from "./governor-client";
import { getProposal } from "./proposals";
import { getSettings, getLatestLedger, getProposalState } from "./queries";

/**
 * Get guardian activity by scanning ProposalCancelled events.
 */
export async function getGuardianActivity(
  client: GovernorClient,
  fromLedger?: number,
): Promise<{
  proposalId: bigint;
  canceller: string;
  ledger: number;
}[]> {
  const settings = await getSettings(client);
  const guardianAddress = settings.guardian;
  if (!guardianAddress) return [];

  const contractId = client.contract.contractId();
  const topicFilter = [xdr.ScVal.scvSymbol("ProposalCancelled")];
  const results: {
    proposalId: bigint;
    canceller: string;
    ledger: number;
  }[] = [];

  let cursor = fromLedger ?? 1;
  const latest = await getLatestLedger(client);

  while (cursor <= latest) {
    const response = await client.retry(async () => {
      return await client.server.getEvents({
        startLedger: cursor,
        filters: [
          {
            type: "contract",
            contractIds: [contractId],
            topics: [topicFilter.map((v) => v.toXDR("base64"))],
          },
        ],
        limit: 100,
      });
    });

    const events = response.events ?? [];
    if (events.length === 0) break;

    let maxLedger = cursor;
    for (const event of events) {
      try {
        const value = scValToNative(event.value) as Record<string, unknown>;
        const proposalIdValue = value.proposal_id;
        const caller = String(value.caller ?? "");
        const proposalId = BigInt(proposalIdValue as number | bigint | string);
        const ledger = event.ledger;
        if (caller === guardianAddress) {
          results.push({ proposalId, canceller: caller, ledger });
        }
      } catch {
        // ignore malformed event
      }
      if (event.ledger > maxLedger) maxLedger = event.ledger;
    }

    cursor = maxLedger + 1;
  }

  return results;
}

/**
 * List proposals created by a given address by scanning `ProposalCreated`
 * (and legacy `prop_crtd`) events and then fetching each proposal/state.
 *
 * Results are sorted newest first.
 */
export async function getProposalsForAddress(
  client: GovernorClient,
  proposer: string,
  opts?: { fromLedger?: number; limit?: number },
): Promise<Array<{ id: bigint; proposal: Proposal; state: ProposalState }>> {
  const limit = Math.max(1, Math.min(opts?.limit ?? 50, 200));
  const contractId = client.contract.contractId();
  const proposerTopic = nativeToScVal(proposer, { type: "address" }).toXDR(
    "base64",
  );

  const topicVectors = [
    [
      xdr.ScVal.scvSymbol("ProposalCreated").toXDR("base64"),
      proposerTopic,
    ],
    [xdr.ScVal.scvSymbol("prop_crtd").toXDR("base64"), proposerTopic],
  ];

  const latest = await getLatestLedger(client);
  let startLedger = opts?.fromLedger ?? 1;
  if (startLedger < 1) startLedger = 1;

  const proposalIds: Array<{ id: bigint; ledger: number }> = [];

  for (const topics of topicVectors) {
    let cursor = startLedger;
    while (cursor <= latest) {
      const response = await client.retry(async () => {
        return await client.server.getEvents({
          startLedger: cursor,
          filters: [
            {
              type: "contract",
              contractIds: [contractId],
              topics: [topics],
            },
          ],
          limit: 100,
        });
      }, client.isNetworkError.bind(client));

      const events = response.events ?? [];
      if (events.length === 0) break;

      let maxLedger = cursor;
      for (const event of events) {
        try {
          const symbol = scValToNative(event.topic[0]);
          const value = scValToNative(event.value) as any;
          const proposalIdRaw =
            symbol === "ProposalCreated"
              ? value?.proposal_id
              : Array.isArray(value)
                ? value[0]
                : undefined;

          const id = BigInt(proposalIdRaw as number | bigint | string);
          proposalIds.push({ id, ledger: event.ledger });
        } catch {
          // ignore malformed event
        }
        if (event.ledger > maxLedger) maxLedger = event.ledger;
      }

      cursor = maxLedger + 1;
    }
  }

  const uniq = new Map<string, { id: bigint; ledger: number }>();
  for (const entry of proposalIds) {
    const key = entry.id.toString();
    const prev = uniq.get(key);
    if (!prev || entry.ledger > prev.ledger) uniq.set(key, entry);
  }

  const newestFirst = Array.from(uniq.values())
    .sort((a, b) => b.ledger - a.ledger)
    .slice(0, limit);

  const hydrated = await Promise.all(
    newestFirst.map(async ({ id }) => {
      const [proposal, state] = await Promise.all([
        getProposal(client, id),
        getProposalState(client, id),
      ]);
      return { id, proposal, state };
    }),
  );

  return hydrated;
}
