/**
 * `SorobanRpc.Server` is exported by `@stellar/stellar-sdk` as a
 * non-configurable getter, so it cannot be monkey-patched at runtime — it
 * must be replaced via `jest.mock("@stellar/stellar-sdk", ...)` (wired up
 * once in `tests/jest.setup.ts`). That mock factory runs before any
 * `SimulationHarness` exists, so it can't close over a specific server
 * instance directly; instead it looks up whichever server is "active" here.
 */
import { MockSorobanServer } from "./server";

let active: MockSorobanServer | undefined;

export function setActiveMockServer(server: MockSorobanServer | undefined): void {
  active = server;
}

export function getActiveMockServer(): MockSorobanServer {
  if (!active) {
    throw new Error("No active MockSorobanServer — call SimulationHarness.boot({ mode: 'mock' }) first");
  }
  return active;
}
