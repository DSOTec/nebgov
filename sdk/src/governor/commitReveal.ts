import {
  TransactionBuilder,
  BASE_FEE,
  Keypair,
  nativeToScVal,
  scValToNative,
  xdr,
  SorobanRpc,
} from "@stellar/stellar-sdk";
import {
  VoteSupport,
  CommitVoteParams,
  CommitmentResult,
  CommitRevealStatus,
} from "../types";
import { GovernorClient } from "./governor-client";
import { getLatestLedger } from "./queries";

const SUPPORT_TO_U8: Record<VoteSupport, number> = {
  [VoteSupport.Against]: 0,
  [VoteSupport.For]: 1,
  [VoteSupport.Abstain]: 2,
};

function randomBytes(length: number): Buffer {
  const nodeCrypto = require("crypto") as typeof import("crypto");
  return nodeCrypto.randomBytes(length);
}

const U128_MAX = (1n << 128n) - 1n;

function u128LeBuffer(value: bigint): Buffer {
  if (value < 0n || value > U128_MAX) {
    throw new RangeError("weightSeed must fit in an unsigned 128-bit integer");
  }
  const buf = Buffer.alloc(16);
  buf.writeBigUInt64LE(value & 0xffffffffffffffffn, 0);
  buf.writeBigUInt64LE(value >> 64n, 8);
  return buf;
}

function sha256(data: Buffer): Buffer {
  const nodeCrypto = require("crypto") as typeof import("crypto");
  return nodeCrypto.createHash("sha256").update(data).digest();
}

/**
 * Build the exact `sha256(proposal_id_le || support_u8 || weight_seed_le ||
 * salt)` preimage the governor contract's `reveal_vote` recomputes and
 * checks against the stored commitment (`compute_commitment` in
 * `contracts/governor/src/commit_reveal.rs`).
 *
 * `weightSeed`/`salt` are optional — when omitted, cryptographically random
 * values are generated and returned so the caller can persist them (e.g. to
 * `localStorage`) until the reveal phase.
 *
 * Node.js only, same limitation as {@link hashDescriptionSync} elsewhere in
 * this SDK — there is no synchronous SHA-256 in the Web Crypto API.
 */
export function generateCommitment(params: CommitVoteParams): CommitmentResult {
  const weightSeed = params.weightSeed ?? BigInt(`0x${randomBytes(16).toString("hex")}`);
  const salt = params.salt ?? randomBytes(32);
  if (salt.length !== 32) {
    throw new RangeError("salt must be exactly 32 bytes");
  }

  const proposalIdBuf = Buffer.alloc(8);
  proposalIdBuf.writeBigUInt64LE(params.proposalId, 0);

  const preimage = Buffer.concat([
    proposalIdBuf,
    Buffer.from([SUPPORT_TO_U8[params.support]]),
    u128LeBuffer(weightSeed),
    salt,
  ]);

  return { commitment: sha256(preimage), salt, weightSeed };
}

/**
 * Submit a hidden vote commitment during a proposal's commit phase.
 *
 * @returns The Stellar transaction hash.
 */
export async function commitVote(
  client: GovernorClient,
  signer: Keypair,
  proposalId: bigint,
  commitment: Buffer,
): Promise<string> {
  return client.retry(async () => {
    const account = await client.server.getAccount(signer.publicKey());

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: client.networkPassphrase,
    })
      .addOperation(
        client.contract.call(
          "commit_vote",
          nativeToScVal(signer.publicKey(), { type: "address" }),
          nativeToScVal(proposalId, { type: "u64" }),
          nativeToScVal(commitment, { type: "bytes" }),
        ),
      )
      .setTimeout(30)
      .build();

    const prepared = await client.server.prepareTransaction(tx);
    prepared.sign(signer);
    const result = await client.server.sendTransaction(prepared);
    if (result.status === "ERROR") {
      throw new Error(`commitVote failed: ${JSON.stringify(result)}`);
    }
    await client.pollForConfirmation(result.hash);
    return result.hash;
  }, (e) => client.isRetryableSubmissionError(e));
}

/**
 * Disclose a prior `commitVote` preimage during a proposal's reveal phase,
 * applying the vote to the tally once the commitment is verified on-chain.
 *
 * @returns The Stellar transaction hash.
 */
export async function revealVote(
  client: GovernorClient,
  signer: Keypair,
  params: { proposalId: bigint; support: VoteSupport; weightSeed: bigint; salt: Buffer },
): Promise<string> {
  return client.retry(async () => {
    const account = await client.server.getAccount(signer.publicKey());

    const supportScVal = xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol(VoteSupport[params.support]),
    ]);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: client.networkPassphrase,
    })
      .addOperation(
        client.contract.call(
          "reveal_vote",
          nativeToScVal(signer.publicKey(), { type: "address" }),
          nativeToScVal(params.proposalId, { type: "u64" }),
          supportScVal,
          nativeToScVal(params.weightSeed, { type: "u128" }),
          nativeToScVal(params.salt, { type: "bytes" }),
        ),
      )
      .setTimeout(30)
      .build();

    const prepared = await client.server.prepareTransaction(tx);
    prepared.sign(signer);
    const result = await client.server.sendTransaction(prepared);
    if (result.status === "ERROR") {
      throw new Error(`revealVote failed: ${JSON.stringify(result)}`);
    }
    await client.pollForConfirmation(result.hash);
    return result.hash;
  }, (e) => client.isRetryableSubmissionError(e));
}

/** Check whether an address has already committed a vote on a proposal. */
export async function hasCommitted(
  client: GovernorClient,
  proposalId: bigint,
  voter: string,
): Promise<boolean> {
  return client.retry(async () => {
    try {
      const result = await client.server.simulateTransaction(
        new TransactionBuilder(
          await client.server.getAccount(client.readAccount()),
          { fee: BASE_FEE, networkPassphrase: client.networkPassphrase },
        )
          .addOperation(
            client.contract.call(
              "has_committed",
              nativeToScVal(proposalId, { type: "u64" }),
              nativeToScVal(voter, { type: "address" }),
            ),
          )
          .setTimeout(30)
          .build(),
      );

      if (SorobanRpc.Api.isSimulationError(result)) return false;
      const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result?.retval;
      return raw ? Boolean(scValToNative(raw)) : false;
    } catch {
      return false;
    }
  });
}

/**
 * Read a proposal's commit-phase deadline (ledger sequence).
 * Throws if commit-reveal was never enabled for this proposal.
 */
export async function getCommitDeadline(
  client: GovernorClient,
  proposalId: bigint,
): Promise<number> {
  return client.retry(async () => {
    const result = await client.server.simulateTransaction(
      new TransactionBuilder(
        await client.server.getAccount(client.readAccount()),
        { fee: BASE_FEE, networkPassphrase: client.networkPassphrase },
      )
        .addOperation(
          client.contract.call(
            "get_commit_deadline",
            nativeToScVal(proposalId, { type: "u64" }),
          ),
        )
        .setTimeout(30)
        .build(),
    );

    if (SorobanRpc.Api.isSimulationError(result)) {
      throw new Error(`Simulation error: ${result.error}`);
    }
    const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
      .result?.retval;
    if (!raw) throw new Error("No return value");
    return Number(scValToNative(raw));
  });
}

/**
 * Read a proposal's reveal-phase deadline (ledger sequence).
 * Throws if commit-reveal was never enabled for this proposal.
 */
export async function getRevealDeadline(
  client: GovernorClient,
  proposalId: bigint,
): Promise<number> {
  return client.retry(async () => {
    const result = await client.server.simulateTransaction(
      new TransactionBuilder(
        await client.server.getAccount(client.readAccount()),
        { fee: BASE_FEE, networkPassphrase: client.networkPassphrase },
      )
        .addOperation(
          client.contract.call(
            "get_reveal_deadline",
            nativeToScVal(proposalId, { type: "u64" }),
          ),
        )
        .setTimeout(30)
        .build(),
    );

    if (SorobanRpc.Api.isSimulationError(result)) {
      throw new Error(`Simulation error: ${result.error}`);
    }
    const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
      .result?.retval;
    if (!raw) throw new Error("No return value");
    return Number(scValToNative(raw));
  });
}

/**
 * Combined commit-reveal status for a proposal: current phase plus both
 * deadlines. `commitCount`/`revealCount` come from the indexer (see
 * {@link CommitRevealStatus}) and are `0` without `config.indexerUrl`.
 */
export async function getCommitRevealStatus(
  client: GovernorClient,
  proposalId: bigint,
): Promise<CommitRevealStatus> {
  const [commitDeadline, revealDeadline, currentLedger] = await Promise.all([
    getCommitDeadline(client, proposalId),
    getRevealDeadline(client, proposalId),
    getLatestLedger(client),
  ]);

  const phase: CommitRevealStatus["phase"] =
    currentLedger <= commitDeadline
      ? "commit"
      : currentLedger <= revealDeadline
        ? "reveal"
        : "ended";

  let commitCount = 0;
  let revealCount = 0;
  if (client.config.indexerUrl) {
    try {
      const response = await fetch(
        `${client.config.indexerUrl}/governor/commit-reveal/${proposalId.toString()}`,
      );
      if (response.ok) {
        const data = (await response.json()) as {
          commit_count?: number;
          reveal_count?: number;
        };
        commitCount = Number(data.commit_count ?? 0);
        revealCount = Number(data.reveal_count ?? 0);
      }
    } catch {
      // Indexer unreachable — counts stay 0 rather than failing the whole status read.
    }
  }

  return { phase, commitDeadline, revealDeadline, commitCount, revealCount };
}
