import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  Keypair,
  nativeToScVal,
  scValToNative,
} from "@stellar/stellar-sdk";
import {
  GovernorConfig,
  Network,
  SignalAnchorRecord,
  SignalingPoll,
  SignalingPollResults,
} from "./types";
import { SignalingError, SignalingErrorCode, parseSignalingError } from "./errors";
import { withRetry, isNetworkError } from "./utils";

const RPC_URLS: Record<Network, string> = {
  mainnet: "https://soroban-rpc.mainnet.stellar.gateway.fm",
  testnet: "https://soroban-testnet.stellar.org",
  futurenet: "https://rpc-futurenet.stellar.org",
};

const NETWORK_PASSPHRASES: Record<Network, string> = {
  mainnet: Networks.PUBLIC,
  testnet: Networks.TESTNET,
  futurenet: Networks.FUTURENET,
};

const DOMAIN_TAG = "nebgov-signal";

/**
 * Canonical, unambiguous hex digest for a signaling vote:
 * hex(SHA256("nebgov-signal" || poll_id || choice || voter_address ||
 * nonce)).
 *
 * Returned as a **hex string**, not raw digest bytes — a wallet extension's
 * SEP-43 `signMessage(message: string)` only accepts a string. This hex
 * string is the *message* both signing paths hand to the signing step, not
 * the final signed bytes — see {@link sep53Digest} for why a raw sign of
 * this string directly would silently reject every real wallet-signed vote.
 * Kept in lockstep with `backend/src/signaling/signature.ts`'s
 * `canonicalSignalPayload` — the two are separate implementations (the
 * backend never imports this browser-facing SDK) so a change to one without
 * the other silently breaks vote verification. Exported (rather than kept
 * module-private) so both packages can be pinned against the same golden
 * vector — see `sdk/src/__tests__/signaling.test.ts` and
 * `backend/src/__tests__/signaling-signature.test.ts`'s
 * "golden vector" tests, which must be updated together.
 */
export async function canonicalSignalPayload(
  pollId: number,
  choiceIndex: number,
  voterAddress: string,
  nonce: string,
): Promise<string> {
  const message = [DOMAIN_TAG, String(pollId), String(choiceIndex), voterAddress, nonce].join("|");
  return sha256Hex(new TextEncoder().encode(message));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new SignalingError(
      SignalingErrorCode.SimulationFailed,
      "Web Crypto (crypto.subtle) is not available in this environment",
    );
  }
  const digest = await subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const SEP53_PREFIX = "Stellar Signed Message:\n";

/**
 * SEP-53 ("Sign and Verify Messages") message-signing digest:
 * SHA256(utf8("Stellar Signed Message:\n") || utf8(message)).
 *
 * A wallet extension's SEP-43 `signMessage` doesn't sign a message's raw
 * bytes directly — per SEP-53 (which Freighter and other wallets implement
 * for `signMessage`), it prefixes the message with this fixed domain string
 * and hashes the result *before* the ed25519 signature is applied, to
 * prevent a signed message from being confused with a real transaction
 * signature. `@stellar/stellar-sdk`'s `Keypair` has no built-in
 * `signMessage`/`verifyMessage` helper (checked against the installed
 * ^12/^15 versions — neither ships one), so {@link SignalingClient.castVote}
 * (the raw-`Keypair` path) replicates this construction by hand
 * before calling `Keypair.sign`, matching what a real wallet's
 * `signMessage` does internally and what
 * `backend/src/signaling/signature.ts`'s `verifySignalVote` checks against.
 * {@link SignalingClient.castVoteWithSign} (the wallet-extension path) does
 * *not* apply this itself — it hands the plain `digestHex` string straight
 * to the wallet's `signMessage`, which is expected to wrap it internally.
 */
export async function sep53Digest(message: string): Promise<Uint8Array> {
  const prefixBytes = new TextEncoder().encode(SEP53_PREFIX);
  const messageBytes = new TextEncoder().encode(message);
  const payload = new Uint8Array(prefixBytes.length + messageBytes.length);
  payload.set(prefixBytes, 0);
  payload.set(messageBytes, prefixBytes.length);

  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new SignalingError(
      SignalingErrorCode.SimulationFailed,
      "Web Crypto (crypto.subtle) is not available in this environment",
    );
  }
  return new Uint8Array(await subtle.digest("SHA-256", payload));
}

function generateNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function mapPoll(raw: any): SignalingPoll {
  return {
    id: Number(raw.id),
    creatorAddress: raw.creatorAddress,
    title: raw.title,
    description: raw.description,
    choices: raw.choices,
    snapshotLedger: Number(raw.snapshotLedger),
    startTime: raw.startTime,
    endTime: raw.endTime,
    finalized: Boolean(raw.finalized),
    resultHash: raw.resultHash ?? null,
    anchoredTxHash: raw.anchoredTxHash ?? null,
    createdAt: raw.createdAt,
  };
}

function mapResults(raw: any): SignalingPollResults {
  return {
    finalized: Boolean(raw.finalized),
    choices: raw.choices,
    totals: (raw.totals ?? []).map((t: string) => BigInt(t)),
    totalVotes: Number(raw.totalVotes ?? 0),
    totalWeight: BigInt(raw.totalWeight ?? 0),
    resultHash: raw.resultHash ?? null,
    anchoredTxHash: raw.anchoredTxHash ?? null,
  };
}

/**
 * SignalingClient — create and vote in gasless off-chain signaling polls
 * ("temperature checks"), and independently verify a finalized poll's
 * published result against its optional on-chain anchor.
 *
 * Poll CRUD and vote casting talk to the **backend** (`config.backendUrl`),
 * not the indexer or Soroban RPC — signaling votes are never submitted as
 * transactions. Only {@link SignalingClient.getAnchor} reads on-chain state,
 * via `config.signalAnchorAddress`.
 *
 * @example
 * const client = new SignalingClient({
 *   governorAddress: "CABC...",
 *   timelockAddress: "CDEF...",
 *   votesAddress: "CGHI...",
 *   signalAnchorAddress: "CJKL...",
 *   backendUrl: "https://api.nebgov.dev",
 *   network: "testnet",
 * });
 *
 * const pollId = await client.createPoll(creator, "Fund grant #4?", "...", ["For", "Against"], 1000, new Date(), new Date(Date.now() + 86_400_000));
 * await client.castVote(voter, pollId, 0);
 * const results = await client.getResults(pollId);
 */
export class SignalingClient {
  private readonly config: GovernorConfig;
  private readonly server: SorobanRpc.Server;
  private readonly networkPassphrase: string;

  constructor(config: GovernorConfig) {
    this.config = config;
    const rpcUrl = config.rpcUrl ?? RPC_URLS[config.network];
    this.server = new SorobanRpc.Server(rpcUrl, { allowHttp: false });
    this.networkPassphrase = NETWORK_PASSPHRASES[config.network];
  }

  private async retry<T>(fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, {
      maxAttempts: this.config.maxAttempts,
      baseDelayMs: this.config.baseDelayMs,
      retryOn: isNetworkError,
    });
  }

  private async backendRequest<T>(path: string, init?: RequestInit): Promise<T> {
    if (!this.config.backendUrl) {
      throw new SignalingError(
        SignalingErrorCode.SimulationFailed,
        "SignalingClient requires config.backendUrl to be set",
      );
    }
    return this.retry(async () => {
      const resp = await fetch(`${this.config.backendUrl}${path}`, {
        ...init,
        headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      });
      if (!resp.ok) {
        const body = (await resp.json().catch(() => null)) as { error?: string } | null;
        throw new SignalingError(
          SignalingErrorCode.TransactionFailed,
          body?.error ?? `Backend request failed: ${resp.status}`,
        );
      }
      return resp.json() as Promise<T>;
    });
  }

  // ── Poll CRUD (backend-backed) ─────────────────────────────────────────────

  /**
   * Create a signaling poll. `creator` (a `Keypair` or a bare Stellar
   * address string, for wallet-extension flows where the SDK never sees a
   * private key) must currently hold at least the governor's
   * `proposal_threshold` in voting power — this is checked by the backend,
   * not by this method. Creation itself is unsigned: it's a public-record
   * bar check, not a fund-moving or vote-casting action.
   */
  async createPoll(
    creator: Keypair | string,
    title: string,
    description: string,
    choices: string[],
    snapshotLedger: number,
    startTime: Date,
    endTime: Date,
  ): Promise<number> {
    const creatorAddress = typeof creator === "string" ? creator : creator.publicKey();
    const raw = await this.backendRequest<any>("/signaling/polls", {
      method: "POST",
      body: JSON.stringify({
        creatorAddress,
        title,
        description,
        choices,
        snapshotLedger,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
      }),
    });
    return Number(raw.id);
  }

  /**
   * Cast a gasless signal: builds the canonical payload, SEP-53-signs it
   * with `voter` (see {@link sep53Digest} for why this isn't a raw sign of
   * the payload bytes), and POSTs it to the backend. No on-chain transaction
   * is submitted.
   */
  async castVote(voter: Keypair, pollId: number, choiceIndex: number): Promise<void> {
    const nonce = generateNonce();
    const digestHex = await canonicalSignalPayload(pollId, choiceIndex, voter.publicKey(), nonce);
    const signedDigest = await sep53Digest(digestHex);
    const signature = Buffer.from(voter.sign(Buffer.from(signedDigest))).toString("base64");

    await this.backendRequest(`/signaling/polls/${pollId}/vote`, {
      method: "POST",
      headers: { "X-Voter-Address": voter.publicKey() },
      body: JSON.stringify({ choiceIndex, nonce, signature }),
    });
  }

  /**
   * Same as {@link castVote}, but accepts a wallet-extension SEP-43
   * `signMessage` callback instead of a raw `Keypair` — for browser
   * dApps where the private key is never exposed to the SDK. `signMessage`
   * is expected to return a base64-encoded signature (see
   * `app/src/lib/wallet-context.tsx`'s `signMessage`).
   */
  async castVoteWithSign(
    voterPublicKey: string,
    signMessage: (message: string) => Promise<string>,
    pollId: number,
    choiceIndex: number,
  ): Promise<void> {
    const nonce = generateNonce();
    const digestHex = await canonicalSignalPayload(pollId, choiceIndex, voterPublicKey, nonce);
    const signature = await signMessage(digestHex);

    await this.backendRequest(`/signaling/polls/${pollId}/vote`, {
      method: "POST",
      headers: { "X-Voter-Address": voterPublicKey },
      body: JSON.stringify({ choiceIndex, nonce, signature }),
    });
  }

  async getPoll(pollId: number): Promise<SignalingPoll> {
    const raw = await this.backendRequest<any>(`/signaling/polls/${pollId}`);
    return mapPoll(raw);
  }

  async listPolls(status?: "active" | "closed"): Promise<SignalingPoll[]> {
    const params = status ? `?status=${status}` : "";
    const raw = await this.backendRequest<any[]>(`/signaling/polls${params}`);
    return raw.map(mapPoll);
  }

  async getResults(pollId: number): Promise<SignalingPollResults> {
    const raw = await this.backendRequest<any>(`/signaling/polls/${pollId}/results`);
    return mapResults(raw);
  }

  // ── On-chain read (signal-anchor contract) ─────────────────────────────────

  /**
   * Read the finalized on-chain anchor for `pollId`, for verifying a
   * finalized poll's published `resultHash` matches the anchor. Returns
   * `null` if the poll's result was never anchored (anchoring is optional
   * and off by default — see the backend's `SIGNAL_ANCHOR_ON_CHAIN` flag).
   */
  async getAnchor(pollId: number): Promise<SignalAnchorRecord | null> {
    if (!this.config.signalAnchorAddress) {
      throw new SignalingError(
        SignalingErrorCode.SimulationFailed,
        "SignalingClient.getAnchor requires config.signalAnchorAddress to be set",
      );
    }
    const contract = new Contract(this.config.signalAnchorAddress);
    const readAccount = this.config.simulationAccount ?? this.config.governorAddress;

    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(await this.server.getAccount(readAccount), {
          fee: BASE_FEE,
          networkPassphrase: this.networkPassphrase,
        })
          .addOperation(contract.call("get_anchor", nativeToScVal(pollId, { type: "u64" })))
          .setTimeout(30)
          .build(),
      );

      if (SorobanRpc.Api.isSimulationError(result)) {
        throw parseSignalingError({ status: "ERROR", error: result.error });
      }

      const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
      if (!raw) {
        throw new SignalingError(SignalingErrorCode.MissingReturnValue, "No return value from get_anchor");
      }
      const native = scValToNative(raw) as
        | { poll_id: bigint; result_hash: Uint8Array; anchored_ledger: number; anchorer: string }
        | undefined;
      if (!native) return null;

      return {
        pollId: BigInt(native.poll_id),
        resultHash: Buffer.from(native.result_hash).toString("hex"),
        anchoredLedger: Number(native.anchored_ledger),
        anchorer: native.anchorer,
      };
    });
  }
}
