// decode.ts's update_config diff path reads current settings via one
// simulateTransaction call — fully mock @stellar/stellar-sdk with a
// scripted response (same rationale/shape as
// backend/src/__tests__/signaling-tally.test.ts's mock) so this test file
// stays DB/network-free per the issue's spec, rather than hitting real RPC.
const mockGetAccount = jest.fn();
const mockSimulateTransaction = jest.fn();

jest.mock("@stellar/stellar-sdk", () => {
  class FakeTransactionBuilder {
    ops: unknown[] = [];
    constructor(_account: unknown, _opts: unknown) {}
    addOperation(op: unknown) {
      this.ops.push(op);
      return this;
    }
    setTimeout() {
      return this;
    }
    build() {
      return { ops: this.ops };
    }
  }

  class FakeServer {
    getAccount(...args: unknown[]) {
      return mockGetAccount(...args);
    }
    simulateTransaction(...args: unknown[]) {
      return mockSimulateTransaction(...args);
    }
  }

  return {
    Contract: class {
      constructor(private id: string) {}
      call(fn: string, ...args: unknown[]) {
        return { fn, args };
      }
    },
    Networks: { TESTNET: "testnet", PUBLIC: "public", FUTURENET: "futurenet" },
    BASE_FEE: "100",
    TransactionBuilder: FakeTransactionBuilder,
    nativeToScVal: (v: unknown) => v,
    scValToNative: (v: unknown) => v,
    rpc: {
      Server: FakeServer,
      Api: { isSimulationError: (r: unknown) => (r as { error?: unknown }).error !== undefined },
    },
    xdr: {},
  };
});

import { decodeAction } from "../proposal-simulation/decode";

const GOVERNOR = "CGOVERNORCONTRACTIDXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const TREASURY = "CTREASURYCONTRACTIDXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const VOTES = "CVOTESCONTRACTIDXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const PASSPHRASE = "Test SDF Network ; September 2015";

function fakeServer() {
  return new (require("@stellar/stellar-sdk").rpc.Server)();
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GOVERNOR_CONTRACT_ID = GOVERNOR;
  mockGetAccount.mockResolvedValue({});
});

afterEach(() => {
  delete process.env.GOVERNOR_CONTRACT_ID;
});

describe("decodeAction", () => {
  it("diffs update_config against current settings, only listing fields that actually changed", async () => {
    mockSimulateTransaction.mockResolvedValueOnce({
      result: {
        retval: { voting_delay: 10, voting_period: 100, quorum_numerator: 5000 },
      },
    });

    const summary = await decodeAction(
      fakeServer(),
      "GSIMACCOUNT",
      PASSPHRASE,
      GOVERNOR,
      "update_config",
      [{ voting_delay: 20, voting_period: 100, quorum_numerator: 5000 }],
      TREASURY,
    );

    expect(summary).toContain("update_config changes 1 setting");
    expect(summary).toContain("voting delay: 10 → 20");
    expect(summary).not.toContain("voting period");
  });

  it("reports missing/malformed proposed settings without throwing", async () => {
    const summary = await decodeAction(
      fakeServer(),
      "GSIMACCOUNT",
      PASSPHRASE,
      GOVERNOR,
      "update_config",
      [],
      TREASURY,
    );
    expect(summary).toMatch(/proposed settings are missing or malformed/);
  });

  it("falls back gracefully when current settings can't be read", async () => {
    mockSimulateTransaction.mockResolvedValueOnce({ error: "host invocation failed" });
    const summary = await decodeAction(
      fakeServer(),
      "GSIMACCOUNT",
      PASSPHRASE,
      GOVERNOR,
      "update_config",
      [{ voting_delay: 20 }],
      TREASURY,
    );
    expect(summary).toContain("current settings unavailable");
  });

  it("decodes batch_transfer with recipients and total amount", async () => {
    const summary = await decodeAction(
      fakeServer(),
      "GSIMACCOUNT",
      PASSPHRASE,
      TREASURY,
      "batch_transfer",
      [
        "GCALLER",
        "GTOKEN",
        [
          { recipient: "GALICE", amount: 100n },
          { recipient: "GBOB", amount: 250n },
        ],
      ],
      TREASURY,
    );
    expect(summary).toContain("Batch transfer 350 units of GTOKEN to 2 recipients");
    expect(summary).toContain("GALICE: 100");
    expect(summary).toContain("GBOB: 250");
  });

  it("decodes create_stream with name/owner/token/amount", async () => {
    const summary = await decodeAction(
      fakeServer(),
      "GSIMACCOUNT",
      PASSPHRASE,
      TREASURY,
      "create_stream",
      ["GCALLER", "marketing", "GOWNER", "GTOKEN", 5000n],
      TREASURY,
    );
    expect(summary).toContain('Create stream "marketing"');
    expect(summary).toContain("5000 units of GTOKEN");
    expect(summary).toContain("GOWNER");
  });

  it("decodes delegate calls", async () => {
    const summary = await decodeAction(
      fakeServer(),
      "GSIMACCOUNT",
      PASSPHRASE,
      VOTES,
      "delegate",
      ["GDELEGATOR", "GDELEGATEE"],
      TREASURY,
    );
    expect(summary).toBe("Delegate GDELEGATOR's voting power to GDELEGATEE");
  });

  it("falls back to raw args for an unknown target/fn_name pair rather than failing", async () => {
    const summary = await decodeAction(
      fakeServer(),
      "GSIMACCOUNT",
      PASSPHRASE,
      "CSOMEOTHERCONTRACT",
      "some_unknown_fn",
      ["arg1", 42n],
      TREASURY,
    );
    expect(summary).toBe("some_unknown_fn(arg1, 42) on CSOMEOTHERCONTRACT");
  });
});
