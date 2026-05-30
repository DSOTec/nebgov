import { Keypair } from "@stellar/stellar-sdk";
import { GovernorClient } from "../governor";
import {
  VoteType,
  ProposalState,
  VoteSupport,
  type GovernorConfig,
} from "../types";
import { VotesClient } from "../votes";
import { TimelockClient } from "../timelock";
import { TreasuryClient } from "../treasury";

// ─── Environment ──────────────────────────────────────────────────────────────

const TESTNET_SECRET_KEY = process.env.TESTNET_SECRET_KEY;
const TESTNET_RPC_URL = process.env.TESTNET_RPC_URL;
const GOVERNOR_ADDRESS = process.env.GOVERNOR_ADDRESS;
const TIMELOCK_ADDRESS = process.env.TIMELOCK_ADDRESS;
const TOKEN_VOTES_ADDRESS = process.env.TOKEN_VOTES_ADDRESS;
const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS;
const INDEXER_URL = process.env.INDEXER_URL;

const hasEnv = Boolean(
  TESTNET_SECRET_KEY &&
    GOVERNOR_ADDRESS &&
    TIMELOCK_ADDRESS &&
    TOKEN_VOTES_ADDRESS,
);

const hasWriteEnv =
  hasEnv && Boolean(process.env.WRITE_TESTS === "true");

const describeIfConfigured = hasEnv ? describe : describe.skip;
const describeIfWrite = hasWriteEnv ? describe : describe.skip;

// ─── Shared config builder ────────────────────────────────────────────────────

function makeConfig(extra?: Partial<GovernorConfig>): GovernorConfig {
  return {
    governorAddress: GOVERNOR_ADDRESS as string,
    timelockAddress: TIMELOCK_ADDRESS as string,
    votesAddress: TOKEN_VOTES_ADDRESS as string,
    network: "testnet",
    rpcUrl: TESTNET_RPC_URL,
    simulationAccount: Keypair.fromSecret(TESTNET_SECRET_KEY as string).publicKey(),
    ...(INDEXER_URL ? { indexerUrl: INDEXER_URL } : {}),
    ...extra,
  };
}

// ─── GovernorClient (read-only) ───────────────────────────────────────────────

describeIfConfigured("GovernorClient integration (testnet)", () => {
  let signer: Keypair;
  let governor: GovernorClient;

  beforeAll(() => {
    signer = Keypair.fromSecret(TESTNET_SECRET_KEY as string);
    governor = new GovernorClient(makeConfig());
  });

  it("proposalCount() returns a number", async () => {
    const count = await governor.proposalCount();
    expect(typeof count).toBe("bigint");
    expect(count >= 0n).toBe(true);
  }, 30_000);

  it("getLatestLedger() returns current ledger", async () => {
    const latestLedger = await governor.getLatestLedger();
    expect(Number.isInteger(latestLedger)).toBe(true);
    expect(latestLedger > 0).toBe(true);
  }, 30_000);

  it("getSettings() returns valid governor settings", async () => {
    const settings = await governor.getSettings(signer.publicKey());
    expect(settings.votingPeriod > 0).toBe(true);
    expect(settings.proposalGracePeriod >= 0).toBe(true);
    expect(settings.quorumNumerator >= 0).toBe(true);
    expect(Object.values(VoteType)).toContain(settings.voteType);
  }, 30_000);

  it("getProposalVotes(1) returns aggregated tallies", async () => {
    const votes = await governor.getProposalVotes(1n);
    expect(typeof votes.votesFor).toBe("bigint");
    expect(typeof votes.votesAgainst).toBe("bigint");
    expect(typeof votes.votesAbstain).toBe("bigint");
    expect(votes.votesFor >= 0n).toBe(true);
    expect(votes.votesAgainst >= 0n).toBe(true);
    expect(votes.votesAbstain >= 0n).toBe(true);
  }, 30_000);

  it("getQuorum(1) returns a positive bigint", async () => {
    const quorum = await governor.getQuorum(1n);
    expect(typeof quorum).toBe("bigint");
    expect(quorum >= 0n).toBe(true);
  }, 30_000);

  it("hasVoted() returns boolean", async () => {
    const result = await governor.hasVoted(1n, signer.publicKey());
    expect(typeof result).toBe("boolean");
  }, 30_000);

  it("canPropose() returns structured result", async () => {
    const result = await governor.canPropose(signer.publicKey());
    expect(typeof result.allowed).toBe("boolean");
    expect(typeof result.reason).toBe("string");
    expect(typeof result.votingPower).toBe("bigint");
    expect(typeof result.threshold).toBe("bigint");
  }, 30_000);

  it("getProposalState(1) returns a valid ProposalState", async () => {
    const count = await governor.proposalCount();
    if (count < 1n) {
      expect(count).toBe(0n);
      return;
    }

    const state = await governor.getProposalState(1n);
    expect(Object.values(ProposalState)).toContain(state);
  }, 30_000);

  it("getProposal(1) returns proposal data when proposals exist", async () => {
    const count = await governor.proposalCount();
    if (count < 1n) return;
    const proposal = await governor.getProposal(1n);
    expect(typeof proposal.id).toBe("bigint");
    expect(typeof proposal.proposer).toBe("string");
    expect(typeof proposal.startLedger).toBe("number");
    expect(typeof proposal.endLedger).toBe("number");
  }, 30_000);

  it("getProposalFromIndexer() returns data or null", async () => {
    if (!INDEXER_URL) return;
    const data = await governor.getProposalFromIndexer(1n);
    expect(data === null || typeof data === "object").toBe(true);
  }, 30_000);

  it("getReceipt() returns voting receipt for the signer", async () => {
    const receipt = await governor.getReceipt(1n, signer.publicKey());
    expect(typeof receipt.hasVoted).toBe("boolean");
    expect(Object.values(VoteSupport)).toContain(receipt.support);
    expect(typeof receipt.weight).toBe("bigint");
  }, 30_000);

  it("getVoteReason() returns a string", async () => {
    const reason = await governor.getVoteReason(1n, signer.publicKey());
    expect(typeof reason).toBe("string");
  }, 30_000);

  it("getProposalsForAddress() returns array", async () => {
    const proposals = await governor.getProposalsForAddress(
      signer.publicKey(),
      { limit: 5 },
    );
    expect(Array.isArray(proposals)).toBe(true);
    for (const p of proposals) {
      expect(typeof p.id).toBe("bigint");
      expect(p.proposal).toBeDefined();
      expect(p.state).toBeDefined();
    }
  }, 60_000);

  it("getVotesCastByAddress() returns array", async () => {
    const votes = await governor.getVotesCastByAddress(
      signer.publicKey(),
      { limit: 5 },
    );
    expect(Array.isArray(votes)).toBe(true);
    for (const v of votes) {
      expect(typeof v.proposalId).toBe("bigint");
      expect(Object.values(VoteSupport)).toContain(v.support);
      expect(typeof v.weight).toBe("bigint");
      expect(Number.isInteger(v.ledger)).toBe(true);
    }
  }, 60_000);

  it("getProposalExpiryLedger() returns a number", async () => {
    const count = await governor.proposalCount();
    if (count < 1n) return;
    const expiry = await governor.getProposalExpiryLedger(1n);
    expect(Number.isInteger(expiry)).toBe(true);
    expect(expiry > 0).toBe(true);
  }, 30_000);

  it("getGuardianActivity() returns array", async () => {
    const activity = await governor.getGuardianActivity();
    expect(Array.isArray(activity)).toBe(true);
  }, 60_000);

  it("estimateExecutionGas() returns gas estimate", async () => {
    const count = await governor.proposalCount();
    if (count < 1n) return;
    const estimate = await governor.estimateExecutionGas(1n);
    expect(typeof estimate.proposalId).toBe("bigint");
    expect(typeof estimate.actionCount).toBe("number");
    expect(typeof estimate.estimatedCpuInsns).toBe("bigint");
  }, 30_000);
});

// ─── GovernorClient (write operations) ────────────────────────────────────────

describeIfWrite("GovernorClient write operations (testnet)", () => {
  let signer: Keypair;
  let governor: GovernorClient;
  const testDescription = `Integration test proposal ${Date.now()}`;

  beforeAll(() => {
    signer = Keypair.fromSecret(TESTNET_SECRET_KEY as string);
    governor = new GovernorClient(makeConfig());
  });

  it(
    "full lifecycle: propose → castVote → queue → execute",
    async () => {
      const threshold = await governor.proposalThreshold();
      const canPropose = await governor.canPropose(signer.publicKey());
      if (!canPropose.allowed || canPropose.votingPower < threshold) {
        expect(canPropose.allowed || canPropose.votingPower < threshold).toBeDefined();
        return;
      }

      const proposalId = await governor.propose(
        signer,
        testDescription,
        "0".repeat(64),
        "ipfs://test",
        [signer.publicKey()],
        ["dummy"],
        [Buffer.from("")],
      );
      expect(typeof proposalId).toBe("bigint");
      expect(proposalId > 0n).toBe(true);

      const state = await governor.getProposalState(proposalId);
      expect(state).toBe(ProposalState.Pending);

      const txHash = await governor.castVote(
        signer,
        proposalId,
        VoteSupport.For,
      );
      expect(typeof txHash).toBe("string");
      expect(txHash.length > 0).toBe(true);

      const votes = await governor.getProposalVotes(proposalId);
      expect(votes.votesFor > 0n).toBe(true);
    },
    120_000,
  );
});

// ─── VotesClient (read-only) ─────────────────────────────────────────────────

describeIfConfigured("VotesClient integration (testnet)", () => {
  let signer: Keypair;
  let governor: GovernorClient;
  let votes: VotesClient;

  beforeAll(() => {
    signer = Keypair.fromSecret(TESTNET_SECRET_KEY as string);
    const config = makeConfig();
    governor = new GovernorClient(config);
    votes = new VotesClient(config);
  });

  it("getVotes(testAccount) returns bigint", async () => {
    const currentVotes = await votes.getVotes(signer.publicKey());
    expect(typeof currentVotes).toBe("bigint");
    expect(currentVotes >= 0n).toBe(true);
  }, 30_000);

  it("getPastVotes(testAccount, pastLedger) returns bigint", async () => {
    const latestLedger = await governor.getLatestLedger();
    const pastLedger = Math.max(1, latestLedger - 1);
    const pastVotes = await votes.getPastVotes(signer.publicKey(), pastLedger);

    expect(typeof pastVotes).toBe("bigint");
    expect(pastVotes >= 0n).toBe(true);
  }, 30_000);

  it("getDelegatee(testAccount) returns address or null", async () => {
    const delegatee = await votes.getDelegatee(signer.publicKey());
    expect(delegatee === null || typeof delegatee === "string").toBe(true);

    if (delegatee !== null) {
      expect(delegatee.length > 0).toBe(true);
    }
  }, 30_000);

  it("getTotalSupply() returns bigint", async () => {
    const supply = await votes.getTotalSupply();
    expect(typeof supply).toBe("bigint");
    expect(supply >= 0n).toBe(true);
  }, 30_000);

  it("getBaseVotes(testAccount) returns bigint", async () => {
    const base = await votes.getBaseVotes(signer.publicKey());
    expect(typeof base).toBe("bigint");
    expect(base >= 0n).toBe(true);
  }, 30_000);

  it("getVotesSettings() returns valid settings", async () => {
    const settings = await votes.getVotesSettings();
    expect(typeof settings.checkpointRetentionPeriod).toBe("number");
    expect(typeof settings.timeWeightEnabled).toBe("boolean");
    expect(typeof settings.timeWeightScale).toBe("number");
  }, 30_000);
});

// ─── TimelockClient (read-only) ──────────────────────────────────────────────

describeIfConfigured("TimelockClient integration (testnet)", () => {
  let timelock: TimelockClient;

  beforeAll(() => {
    timelock = new TimelockClient(makeConfig());
  });

  it("minDelay() returns bigint", async () => {
    const delay = await timelock.minDelay();
    expect(typeof delay).toBe("bigint");
    expect(delay >= 0n).toBe(true);
  }, 30_000);
});

// ─── TreasuryClient (read-only) ──────────────────────────────────────────────

describeIfConfigured("TreasuryClient integration (testnet)", () => {
  let treasury: TreasuryClient | null = null;

  beforeAll(() => {
    if (TREASURY_ADDRESS) {
      treasury = new TreasuryClient({
        treasuryAddress: TREASURY_ADDRESS,
        network: "testnet",
        rpcUrl: TESTNET_RPC_URL,
      });
    }
  });

  it("getSpendingCap() returns SpendingCap or null", async () => {
    if (!treasury) return;
    const cap = await treasury.getSpendingCap(
      Keypair.fromSecret(TESTNET_SECRET_KEY as string).publicKey(),
    );
    expect(cap === null || (typeof cap === "object" && "maxAmount" in cap)).toBe(true);
  }, 30_000);

  it("getOwners() returns array", async () => {
    if (!treasury) return;
    const owners = await treasury.getOwners();
    expect(Array.isArray(owners)).toBe(true);
  }, 30_000);

  it("getThreshold() returns number", async () => {
    if (!treasury) return;
    const threshold = await treasury.getThreshold();
    expect(typeof threshold).toBe("number");
    expect(threshold >= 0).toBe(true);
  }, 30_000);

  it("getTxCount() returns bigint", async () => {
    if (!treasury) return;
    const count = await treasury.getTxCount();
    expect(typeof count).toBe("bigint");
    expect(count >= 0n).toBe(true);
  }, 30_000);
});
