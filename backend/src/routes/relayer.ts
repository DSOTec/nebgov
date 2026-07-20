import { Router } from "express";
import { z } from "zod";
import {
  Contract,
  Keypair,
  Networks,
  BASE_FEE,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import pool from "../db/pool";
import { validate } from "../middleware/validate";
import { logger } from "../logger";

const router = Router();

// The backend already depends on @stellar/stellar-sdk ^15 (a different major
// version than the ^12 pinned by @nebgov/sdk for the browser app), so this
// route talks to Soroban directly instead of taking on a second, mismatched
// copy of the SDK. The permit-encoding logic below is intentionally kept in
// lockstep with sdk/src/delegation-sig.ts's `permitToScVal` — see the
// comment there for why field order matters.

// Matches both G... (account) and C... (contract) strkey addresses.
const STELLAR_ADDRESS_RE = /^[GC][A-Z2-7]{55}$/;

const RELAYER_DAILY_PERMIT_LIMIT = Number(
  process.env.RELAYER_DAILY_PERMIT_LIMIT ?? 5,
);

const SINGLE_FN = "delegate_by_sig";
const BATCH_FN = "delegate_batch_by_sig";

const NETWORK_PASSPHRASES: Record<string, string> = {
  mainnet: Networks.PUBLIC,
  public: Networks.PUBLIC,
  testnet: Networks.TESTNET,
  futurenet: Networks.FUTURENET,
};

// Mirrors sdk/src/errors.ts VOTES_MESSAGES for the on-chain codes relevant
// to this flow (contracts/token-votes/src/error.rs).
const CONTRACT_ERROR_MESSAGES: Record<number, string> = {
  10: "Invalid or missing delegation signature",
  11: "Permit nonce has already been used or invalidated",
  12: "Delegation permit has expired",
  13: "Delegation permit is malformed or out of order",
  14: "Relayer is not whitelisted to submit signed permits",
  15: "Permit was signed for a different network",
  16: "Permit was signed for a different contract",
};

function extractContractErrorMessage(err: unknown): string | null {
  const str = err instanceof Error ? err.message : String(err);
  const match = str.match(/Error\(Contract,\s*#(\d+)\)|ContractError\((\d+)\)/);
  if (!match) return null;
  const code = Number(match[1] ?? match[2]);
  return CONTRACT_ERROR_MESSAGES[code] ?? `Contract error #${code}`;
}

const permitSchema = z.object({
  delegator: z.string().regex(STELLAR_ADDRESS_RE, "invalid delegator address"),
  delegatee: z.string().regex(STELLAR_ADDRESS_RE, "invalid delegatee address"),
  nonce: z.coerce.bigint().nonnegative(),
  expiryLedger: z.coerce.number().int().positive(),
  /** base64-encoded 32 raw bytes (the network ID). */
  chainId: z.string().min(1),
  contractId: z.string().regex(STELLAR_ADDRESS_RE, "invalid contract address"),
});

type PermitInput = z.infer<typeof permitSchema>;

const delegateSchema = z.object({
  permit: permitSchema,
  /** base64 XDR of the delegator's signed SorobanAuthorizationEntry. */
  signature: z.string().min(1),
});

const batchDelegateSchema = z.object({
  permits: z.array(permitSchema).min(1).max(20),
  signatures: z.array(z.string().min(1)).min(1).max(20),
});

function networkPassphrase(): string {
  const key = (process.env.STELLAR_NETWORK ?? "testnet").toLowerCase();
  return NETWORK_PASSPHRASES[key] ?? Networks.TESTNET;
}

function rpcServer(): rpc.Server {
  const url = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
  return new rpc.Server(url, { allowHttp: false });
}

function votesContract(): Contract {
  const votesAddress = process.env.TOKEN_VOTES_CONTRACT_ID;
  if (!votesAddress) {
    throw new Error("TOKEN_VOTES_CONTRACT_ID is not configured");
  }
  return new Contract(votesAddress);
}

function getRelayerKeypair(): Keypair {
  const secret = process.env.RELAYER_SECRET_KEY;
  if (!secret) {
    throw new Error("RELAYER_SECRET_KEY is not configured");
  }
  return Keypair.fromSecret(secret);
}

/**
 * Struct fields are serialized as a map sorted alphabetically by field name
 * (soroban-sdk's `#[contracttype]` derive convention for structs) — this
 * exact key order (chain_id, contract_id, delegatee, delegator,
 * expiry_ledger, nonce) must match, or the resulting ScVal won't equal what
 * the contract expects.
 */
function permitToScVal(permit: PermitInput): xdr.ScVal {
  return nativeToScVal(
    {
      chain_id: Buffer.from(permit.chainId, "base64"),
      contract_id: permit.contractId,
      delegatee: permit.delegatee,
      delegator: permit.delegator,
      expiry_ledger: permit.expiryLedger,
      nonce: permit.nonce,
    },
    {
      type: {
        chain_id: ["symbol", "bytes"],
        contract_id: ["symbol", "address"],
        delegatee: ["symbol", "address"],
        delegator: ["symbol", "address"],
        expiry_ledger: ["symbol", "u32"],
        nonce: ["symbol", "u64"],
      },
    },
  );
}

/**
 * Off-chain structural check: does this parse as a well-formed
 * `SorobanAuthorizationEntry` with address credentials? This catches
 * garbage/malformed input before we spend an RPC round-trip on it. Full
 * cryptographic + business-rule validation (expiry, nonce, chain/contract
 * ID, and the signature itself) happens when the relayer simulates the
 * transaction, immediately before submission.
 */
function isWellFormedAuthEntry(base64Xdr: string): boolean {
  try {
    const entry = xdr.SorobanAuthorizationEntry.fromXDR(base64Xdr, "base64");
    return entry.credentials().switch().name === "sorobanCredentialsAddress";
  } catch {
    return false;
  }
}

/** Rolling 24h count of permits this relayer has already submitted for `delegator`. */
async function relayedPermitCountToday(delegator: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM relayer_permit_log
     WHERE delegator = $1 AND created_at > NOW() - INTERVAL '1 day'`,
    [delegator],
  );
  return Number(rows[0]?.count ?? 0);
}

async function logRelayedPermit(
  permit: PermitInput,
  txHash: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO relayer_permit_log (delegator, delegatee, nonce, tx_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (delegator, nonce) DO NOTHING`,
    [permit.delegator, permit.delegatee, permit.nonce.toString(), txHash],
  );
}

async function submitInvocation(
  fnName: string,
  args: xdr.ScVal[],
  auth: xdr.SorobanAuthorizationEntry[],
): Promise<string> {
  const relayer = getRelayerKeypair();
  const server = rpcServer();
  const contract = votesContract();
  const passphrase = networkPassphrase();

  const account = await server.getAccount(relayer.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: passphrase,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: contract.contractId(),
        function: fnName,
        args,
        auth,
      }),
    )
    .setTimeout(30)
    .build();

  const prepared = await server.prepareTransaction(tx);
  prepared.sign(relayer);
  const result = await server.sendTransaction(prepared);
  if (result.status === "ERROR") {
    throw new Error(
      `Transaction failed: ${JSON.stringify(result.errorResult ?? result)}`,
    );
  }
  return result.hash;
}

// POST /relayer/delegate — submit a single signed delegation permit.
router.post("/delegate", validate({ body: delegateSchema }), async (req, res) => {
  const { permit, signature } = req.body as z.infer<typeof delegateSchema>;

  try {
    if (!isWellFormedAuthEntry(signature)) {
      return res.status(400).json({ error: "Malformed authorization signature" });
    }

    const relayedToday = await relayedPermitCountToday(permit.delegator);
    if (relayedToday >= RELAYER_DAILY_PERMIT_LIMIT) {
      return res.status(429).json({
        error: "Relayer daily permit limit reached for this address",
      });
    }

    const relayer = getRelayerKeypair();
    const entry = xdr.SorobanAuthorizationEntry.fromXDR(signature, "base64");

    const txHash = await submitInvocation(
      SINGLE_FN,
      [nativeToScVal(relayer.publicKey(), { type: "address" }), permitToScVal(permit)],
      [entry],
    );
    await logRelayedPermit(permit, txHash);

    res.json({ txHash, nonce: Number(permit.nonce) + 1 });
  } catch (error) {
    logger.error({ err: error }, "Error in POST /relayer/delegate");
    const contractMessage = extractContractErrorMessage(error);
    if (contractMessage) {
      return res.status(400).json({ error: contractMessage });
    }
    res.status(500).json({ error: "Failed to submit delegation" });
  }
});

// POST /relayer/delegate-batch — submit multiple signed permits atomically.
router.post(
  "/delegate-batch",
  validate({ body: batchDelegateSchema }),
  async (req, res) => {
    const { permits, signatures } = req.body as z.infer<
      typeof batchDelegateSchema
    >;

    if (permits.length !== signatures.length) {
      return res
        .status(400)
        .json({ error: "permits and signatures must have the same length" });
    }

    try {
      if (!signatures.every(isWellFormedAuthEntry)) {
        return res.status(400).json({ error: "Malformed authorization signature" });
      }

      for (const permit of permits) {
        const relayedToday = await relayedPermitCountToday(permit.delegator);
        if (relayedToday >= RELAYER_DAILY_PERMIT_LIMIT) {
          return res.status(429).json({
            error: `Relayer daily permit limit reached for ${permit.delegator}`,
          });
        }
      }

      const relayer = getRelayerKeypair();
      const entries = signatures.map((s) =>
        xdr.SorobanAuthorizationEntry.fromXDR(s, "base64"),
      );
      const permitsScVal = nativeToScVal(permits.map((p) => permitToScVal(p)));

      const txHash = await submitInvocation(
        BATCH_FN,
        [nativeToScVal(relayer.publicKey(), { type: "address" }), permitsScVal],
        entries,
      );
      await Promise.all(permits.map((permit) => logRelayedPermit(permit, txHash)));

      res.json({
        txHash,
        nonces: permits.map((p) => Number(p.nonce) + 1),
      });
    } catch (error) {
      logger.error({ err: error }, "Error in POST /relayer/delegate-batch");
      const contractMessage = extractContractErrorMessage(error);
      if (contractMessage) {
        return res.status(400).json({ error: contractMessage });
      }
      res.status(500).json({ error: "Failed to submit batch delegation" });
    }
  },
);

export default router;
