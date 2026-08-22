// Unlike backend/src/routes/relayer.test.ts's full-module mock, this file
// uses the *real* @stellar/stellar-sdk: Contract/TransactionBuilder/xdr are
// pure local computations with no network calls, and simulateAction()/
// simulateActions() already take the RPC `server` as a parameter — so only
// that one async boundary (getAccount/simulateTransaction) needs a fake.
// This gives genuine XDR encode/decode coverage for decodeCalldataArgs
// (the function this new feature's correctness most depends on) instead of
// a hand-rolled stand-in for it.
import { Account, Keypair, StrKey, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { randomBytes } from "crypto";
import {
  decodeCalldataArgs,
  simulateAction,
  simulateActions,
  type ProposalAction,
} from "../proposal-simulation/simulate";

const SOURCE = Keypair.random().publicKey();
// A contract call's target must be a C... contract strkey, not a G...
// account address — Contract's constructor validates this.
const TARGET = StrKey.encodeContract(randomBytes(32));

function fakeServer(simulateImpl: (tx: unknown) => unknown) {
  return {
    getAccount: jest.fn().mockResolvedValue(new Account(SOURCE, "1")),
    simulateTransaction: jest.fn().mockImplementation(async (tx) => simulateImpl(tx)),
  } as any;
}

beforeEach(() => {
  process.env.PROPOSAL_SIMULATION_ACCOUNT = SOURCE;
});

afterEach(() => {
  delete process.env.PROPOSAL_SIMULATION_ACCOUNT;
});

describe("decodeCalldataArgs", () => {
  it("decodes an empty calldata to zero args", () => {
    expect(decodeCalldataArgs(Buffer.alloc(0))).toEqual([]);
  });

  it("decodes a Vec<Val>-encoded calldata into its elements", () => {
    const args = [nativeToScVal(42, { type: "u32" }), nativeToScVal("hello", { type: "string" })];
    const encoded = Buffer.from(xdr.ScVal.scvVec(args).toXDR());
    const decoded = decodeCalldataArgs(encoded);
    expect(decoded).toHaveLength(2);
    expect(decoded[0].switch().name).toBe("scvU32");
    expect(decoded[1].switch().name).toBe("scvString");
  });

  it("mirrors the on-chain fallback: a bare (non-Vec) ScVal decodes to zero args, not a throw", () => {
    // This is exactly the shape `buildUpdateConfigProposal` used to produce
    // before its fix in this PR — a bare scvMap instead of a one-element
    // Vec — which the real timelock/governor decoder also silently drops
    // to zero args (see decode_invocation_args/decode_calldata_args).
    const bareMap = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("voting_delay"),
        val: nativeToScVal(10, { type: "u32" }),
      }),
    ]);
    const encoded = Buffer.from(bareMap.toXDR());
    expect(decodeCalldataArgs(encoded)).toEqual([]);
  });

  it("decodes garbage bytes to zero args rather than throwing", () => {
    expect(decodeCalldataArgs(Buffer.from([0xff, 0x00, 0x01, 0x02]))).toEqual([]);
  });
});

describe("simulateAction", () => {
  it("returns success with the decoded return value", async () => {
    const retval = nativeToScVal(true, { type: "bool" });
    const server = fakeServer(() => ({ result: { retval } }));
    const action: ProposalAction = {
      target: TARGET,
      fnName: "get_spending_remaining",
      calldata: Buffer.alloc(0),
    };
    const outcome = await simulateAction(server, action);
    expect(outcome.success).toBe(true);
    expect(outcome.returnValue).toBe(true);
    expect(outcome.revertReason).toBeUndefined();
  });

  it("returns success:false with the revert reason on a simulation error", async () => {
    const server = fakeServer(() => ({ error: "HostError: Error(Contract, #5)" }));
    const action: ProposalAction = {
      target: TARGET,
      fnName: "update_config",
      calldata: Buffer.alloc(0),
    };
    const outcome = await simulateAction(server, action);
    expect(outcome.success).toBe(false);
    expect(outcome.revertReason).toContain("Error(Contract, #5)");
  });

  it("decodes calldata args and reports their native values on the outcome", async () => {
    const server = fakeServer(() => ({ result: { retval: nativeToScVal(1, { type: "u32" }) } }));
    const calldata = Buffer.from(
      xdr.ScVal.scvVec([nativeToScVal(7, { type: "u32" }), nativeToScVal(9, { type: "u32" })]).toXDR(),
    );
    const outcome = await simulateAction(server, { target: TARGET, fnName: "some_fn", calldata });
    expect(outcome.args).toEqual([7, 9]);
  });
});

describe("simulateActions", () => {
  it("does not short-circuit: a multi-action list returns every outcome even when one reverts", async () => {
    let call = 0;
    const server = fakeServer(() => {
      call += 1;
      if (call === 1) return { result: { retval: nativeToScVal(1, { type: "u32" }) } };
      return { error: "HostError: Error(Contract, #7)" };
    });

    const actions: ProposalAction[] = [
      { target: TARGET, fnName: "ok_fn", calldata: Buffer.alloc(0) },
      { target: TARGET, fnName: "reverting_fn", calldata: Buffer.alloc(0) },
    ];

    const outcomes = await simulateActions(server, actions);
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0].success).toBe(true);
    expect(outcomes[1].success).toBe(false);
    expect(outcomes[1].revertReason).toContain("#7");
  });
});
