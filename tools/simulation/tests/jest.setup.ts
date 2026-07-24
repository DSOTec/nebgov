/**
 * Runs before every `*.sim.ts` test file (see `jest.config.js`
 * `setupFiles`). Replaces `SorobanRpc.Server` with one that always
 * constructs to whichever `MockSorobanServer` the currently-booted
 * `SimulationHarness` registered — the same `jest.mock("@stellar/stellar-sdk")`
 * seam `sdk/src/__tests__/governor.test.ts` uses, kept in one place so
 * individual scenario suites don't repeat it.
 */
import { getActiveMockServer } from "../src/mock/registry";

jest.mock("@stellar/stellar-sdk", () => {
  const actual = jest.requireActual("@stellar/stellar-sdk");
  return {
    ...actual,
    SorobanRpc: {
      ...actual.SorobanRpc,
      Server: jest.fn().mockImplementation(() => getActiveMockServer()),
    },
  };
});
