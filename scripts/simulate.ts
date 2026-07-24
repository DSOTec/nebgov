#!/usr/bin/env node
/**
 * TypeScript integration harness for `tools/sim` (the Rust governance
 * simulation crate — see tools/sim/README.md and issue #770).
 *
 * `runSimulation` and `generateRandomScenario` are genuinely functional.
 * `replayEventsFromIndexer` fetches real on-chain events via Soroban RPC and
 * writes them to disk; turning those events back into replayable `SimStep`s
 * (decoding calldata into a `Propose`/`Vote`/... step) is a natural follow-up
 * once there's a real need for it, and is out of scope here — see the inline
 * comment on that function.
 *
 * Usage:
 *   tsx scripts/simulate.ts run <scenario.json> [--output report.json] [--verbose]
 *   tsx scripts/simulate.ts generate <seed> <actorCount> <proposalCount> [--output scenario.json]
 *   tsx scripts/simulate.ts compare <reportA.json> <reportB.json>
 *   tsx scripts/simulate.ts replay --from <ledger> --to <ledger> [--rpc-url <url>] [--contract <id>] [--output events.json]
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(__dirname, "..");
const SIM_MANIFEST = path.join(REPO_ROOT, "tools", "sim", "Cargo.toml");

// ─── Types (mirror tools/sim/src/{scenario,report}.rs) ────────────────────

export type ActorRole = "TokenHolder" | "Proposer" | "Guardian" | "Pauser" | "Admin";
export type SimVoteType = "Simple" | "Extended" | "Quadratic";
export type SimVoteSupport = "Against" | "For" | "Abstain";
export type SimProposalState =
  | "Pending"
  | "Active"
  | "Defeated"
  | "Succeeded"
  | "Queued"
  | "Executed"
  | "Cancelled"
  | "Expired";

export interface SimGovernorSettings {
  voting_delay: number;
  voting_period: number;
  quorum_numerator: number;
  proposal_threshold: number;
  vote_type: SimVoteType;
  proposal_grace_period: number;
  max_calldata_size: number;
  proposal_cooldown: number;
  max_proposals_per_period: number;
  proposal_period_duration: number;
}

export interface SimActor {
  name: string;
  initial_balance: number;
  delegate_to: string | null;
  role: ActorRole;
}

// A loose union — scenario JSON is produced/consumed by serde's internally
// tagged `#[serde(tag = "type")]` representation on the Rust side.
export type SimStep = { type: string; [key: string]: unknown };

export interface Scenario {
  name: string;
  description: string;
  seed: number;
  governor_settings: SimGovernorSettings;
  actors: SimActor[];
  steps: SimStep[];
}

export interface StepResult {
  step_index: number;
  step_type: string;
  ledger: number;
  success: boolean;
  error: string | null;
  cpu_insns: number;
  mem_bytes: number;
  storage_entries_read: number;
  storage_entries_written: number;
  duration_ms: number;
  anticipated_failure: boolean;
}

export interface BudgetWarning {
  step_index: number;
  cpu_insns: number;
  budget_limit: number;
  utilization_pct: number;
}

export interface StorageWarning {
  step_index: number;
  entries_written: number;
  utilization_pct: number;
}

export interface SimulationReport {
  scenario_name: string;
  total_steps: number;
  passed_steps: number;
  failed_steps: number;
  final_ledger: number;
  proposals_created: number;
  proposals_executed: number;
  proposals_defeated: number;
  total_votes_cast: number;
  step_results: StepResult[];
  compute_budget_warnings: BudgetWarning[];
  storage_warnings: StorageWarning[];
}

export interface SimOptions {
  /** Where to write the JSON report; defaults to a temp file that's read back and cleaned up. */
  outputPath?: string;
  verbose?: boolean;
}

// ─── runSimulation ──────────────────────────────────────────────────────────

/**
 * Run a scenario file through the compiled `nebgov-sim` binary (built via
 * `cargo run --manifest-path tools/sim/Cargo.toml`) and return its parsed
 * report.
 */
export async function runSimulation(
  scenarioPath: string,
  options: SimOptions = {},
): Promise<SimulationReport> {
  const outputPath =
    options.outputPath ??
    path.join(REPO_ROOT, "tools", "sim", "reports", `.tmp-${Date.now()}.json`);

  const args = [
    "run",
    "--quiet",
    "--manifest-path",
    SIM_MANIFEST,
    "--",
    "run",
    "--scenario",
    scenarioPath,
    "--output",
    outputPath,
  ];
  if (options.verbose) args.push("--verbose");

  try {
    await execFileAsync("cargo", args, { cwd: REPO_ROOT });
  } catch (err) {
    // `nebgov-sim run` exits non-zero when any step fails — the report is
    // still written and worth returning rather than throwing away.
    const asExecError = err as { code?: number };
    if (asExecError?.code === undefined) throw err;
  }

  const raw = await readFile(outputPath, "utf-8");
  return JSON.parse(raw) as SimulationReport;
}

// ─── generateRandomScenario ─────────────────────────────────────────────────

/** Minimal deterministic PRNG (mulberry32) so a given seed always produces the same scenario. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generate a full-scale random scenario for local stress testing — the
 * shipped `tools/sim/src/scenarios/*.json` files are intentionally scaled
 * down from the issue's illustrative figures (e.g. "50 actors, 200
 * proposals") to keep CI runtime reasonable; use this to regenerate a
 * bigger version on demand.
 */
export async function generateRandomScenario(
  seed: number,
  actorCount: number,
  proposalCount: number,
): Promise<Scenario> {
  if (actorCount < 1) throw new Error("actorCount must be >= 1");
  const rng = mulberry32(seed);

  const actors: SimActor[] = [];
  for (let i = 0; i < actorCount; i++) {
    actors.push({
      name: `actor_${i}`,
      initial_balance: 100 + Math.floor(rng() * 9900),
      delegate_to: null,
      role: i === 0 ? "Proposer" : "TokenHolder",
    });
  }

  const steps: SimStep[] = [];
  const supports: SimVoteSupport[] = ["For", "Against", "Abstain"];
  for (let p = 0; p < proposalCount; p++) {
    const proposalId = p + 1;
    const proposer = actors[Math.floor(rng() * actorCount)].name;
    steps.push({
      type: "Propose",
      actor: proposer,
      targets: ["target"],
      fn_names: ["noop"],
      description: `generated proposal ${proposalId} (seed ${seed})`,
    });
    steps.push({ type: "AdvanceLedger", ledgers: 2 });

    const voterCount = Math.max(1, Math.floor(rng() * actorCount));
    const voted = new Set<string>();
    for (let v = 0; v < voterCount; v++) {
      const voter = actors[Math.floor(rng() * actorCount)].name;
      if (voted.has(voter)) continue;
      voted.add(voter);
      const support = supports[Math.floor(rng() * supports.length)];
      steps.push({ type: "Vote", actor: voter, proposal_id: proposalId, support });
    }
    steps.push({ type: "AdvanceLedger", ledgers: 10 });
  }
  steps.push({ type: "TakeAnalyticsSnapshot" });

  return {
    name: `generated_seed${seed}_a${actorCount}_p${proposalCount}`,
    description: `Randomly generated via scripts/simulate.ts generateRandomScenario(${seed}, ${actorCount}, ${proposalCount}).`,
    seed,
    governor_settings: {
      voting_delay: 1,
      voting_period: 10,
      quorum_numerator: 10,
      proposal_threshold: 50,
      vote_type: "Extended",
      proposal_grace_period: 1000,
      max_calldata_size: 10_000,
      proposal_cooldown: 0,
      max_proposals_per_period: Math.max(5, proposalCount),
      proposal_period_duration: 10_000,
    },
    actors,
    steps,
  };
}

// ─── compareReports ──────────────────────────────────────────────────────────

export interface DiffReport {
  scenarioMatches: boolean;
  passedStepsDelta: number;
  failedStepsDelta: number;
  finalLedgerDelta: number;
  newlyFailingSteps: StepResult[];
  newlyPassingSteps: StepResult[];
  budgetWarningCountDelta: number;
  storageWarningCountDelta: number;
  identical: boolean;
}

/**
 * Compare two simulation reports — typically the same scenario run before
 * and after a contract change, to check an upgrade didn't silently alter
 * governance outcomes (see `upgrade_replay.json`'s doc comment for why full
 * WASM-swap replay isn't modeled here; this compares two independently-run
 * reports instead).
 */
export async function compareReports(
  report1: SimulationReport,
  report2: SimulationReport,
): Promise<DiffReport> {
  const stepsByIndex2 = new Map(report2.step_results.map((r) => [r.step_index, r]));

  const newlyFailingSteps: StepResult[] = [];
  const newlyPassingSteps: StepResult[] = [];
  for (const before of report1.step_results) {
    const after = stepsByIndex2.get(before.step_index);
    if (!after) continue;
    if (before.success && !after.success) newlyFailingSteps.push(after);
    if (!before.success && after.success) newlyPassingSteps.push(after);
  }

  const diff: DiffReport = {
    scenarioMatches: report1.scenario_name === report2.scenario_name,
    passedStepsDelta: report2.passed_steps - report1.passed_steps,
    failedStepsDelta: report2.failed_steps - report1.failed_steps,
    finalLedgerDelta: report2.final_ledger - report1.final_ledger,
    newlyFailingSteps,
    newlyPassingSteps,
    budgetWarningCountDelta:
      report2.compute_budget_warnings.length - report1.compute_budget_warnings.length,
    storageWarningCountDelta: report2.storage_warnings.length - report1.storage_warnings.length,
    identical: false,
  };
  diff.identical =
    diff.scenarioMatches &&
    diff.passedStepsDelta === 0 &&
    diff.failedStepsDelta === 0 &&
    diff.finalLedgerDelta === 0 &&
    newlyFailingSteps.length === 0 &&
    newlyPassingSteps.length === 0;

  return diff;
}

// ─── replayEventsFromIndexer ─────────────────────────────────────────────────

export interface ReplayOptions {
  rpcUrl?: string;
  contractId?: string;
  outputPath?: string;
}

/**
 * Fetch real on-chain governor events in `[fromLedger, toLedger]` via
 * Soroban RPC and write them to disk.
 *
 * This is the data-collection half of "replay historical events against a
 * new contract version" (issue #770, point 2). Turning raw events back into
 * `SimStep`s the runner can execute requires decoding each event's
 * `ProposalCreated`/`VoteCast`/etc. payload into the matching step shape —
 * intentionally left as a follow-up rather than guessed at here, since
 * getting the calldata/target mapping wrong would make "replay" silently
 * lie about upgrade compatibility, which is worse than not having it yet.
 */
export async function replayEventsFromIndexer(
  fromLedger: number,
  toLedger: number,
  options: ReplayOptions = {},
): Promise<void> {
  const { SorobanRpc } = await import("@stellar/stellar-sdk");
  const rpcUrl = options.rpcUrl ?? process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
  const contractId = options.contractId ?? process.env.GOVERNOR_ADDRESS;
  if (!contractId) {
    throw new Error(
      "replayEventsFromIndexer requires a contract id (pass options.contractId or set GOVERNOR_ADDRESS)",
    );
  }

  const server = new SorobanRpc.Server(rpcUrl, { allowHttp: false });
  const events: unknown[] = [];
  let startLedger = fromLedger;

  while (startLedger <= toLedger) {
    const response = await server.getEvents({
      startLedger,
      filters: [{ type: "contract", contractIds: [contractId] }],
      limit: 200,
    });
    if (response.events.length === 0) break;
    for (const event of response.events) {
      if (event.ledger > toLedger) continue;
      events.push({
        ledger: event.ledger,
        topic: event.topic.map((t) => t.toXDR("base64")),
        value: event.value.toXDR("base64"),
      });
    }
    const lastLedger = response.events[response.events.length - 1].ledger;
    if (lastLedger >= toLedger || lastLedger < startLedger) break;
    startLedger = lastLedger + 1;
  }

  const outputPath =
    options.outputPath ??
    path.join(REPO_ROOT, "tools", "sim", "reports", `events-${fromLedger}-${toLedger}.json`);
  await writeFile(outputPath, JSON.stringify(events, null, 2));
  console.log(`Wrote ${events.length} event(s) from ledger ${fromLedger}-${toLedger} to ${outputPath}`);
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

async function main() {
  const [, , command, ...rest] = process.argv;

  switch (command) {
    case "run": {
      const scenarioPath = rest[0];
      if (!scenarioPath) {
        console.error("Usage: simulate.ts run <scenario.json> [--output report.json] [--verbose]");
        process.exit(1);
      }
      const outputIdx = rest.indexOf("--output");
      const outputPath = outputIdx >= 0 ? rest[outputIdx + 1] : undefined;
      const verbose = rest.includes("--verbose");
      const report = await runSimulation(scenarioPath, { outputPath, verbose });
      console.log(
        `${report.scenario_name}: ${report.passed_steps}/${report.total_steps} steps passed, final ledger ${report.final_ledger}`,
      );
      if (report.failed_steps > 0) process.exitCode = 1;
      break;
    }
    case "generate": {
      const [seedStr, actorCountStr, proposalCountStr] = rest;
      const outputIdx = rest.indexOf("--output");
      const outputPath = outputIdx >= 0 ? rest[outputIdx + 1] : "generated-scenario.json";
      if (!seedStr || !actorCountStr || !proposalCountStr) {
        console.error("Usage: simulate.ts generate <seed> <actorCount> <proposalCount> [--output scenario.json]");
        process.exit(1);
      }
      const scenario = await generateRandomScenario(
        Number(seedStr),
        Number(actorCountStr),
        Number(proposalCountStr),
      );
      await writeFile(outputPath, JSON.stringify(scenario, null, 2));
      console.log(`Wrote generated scenario (${scenario.actors.length} actors, ${scenario.steps.length} steps) to ${outputPath}`);
      break;
    }
    case "compare": {
      const [pathA, pathB] = rest;
      if (!pathA || !pathB) {
        console.error("Usage: simulate.ts compare <reportA.json> <reportB.json>");
        process.exit(1);
      }
      const reportA = JSON.parse(await readFile(pathA, "utf-8")) as SimulationReport;
      const reportB = JSON.parse(await readFile(pathB, "utf-8")) as SimulationReport;
      const diff = await compareReports(reportA, reportB);
      console.log(JSON.stringify(diff, null, 2));
      if (!diff.identical) process.exitCode = 1;
      break;
    }
    case "replay": {
      const fromIdx = rest.indexOf("--from");
      const toIdx = rest.indexOf("--to");
      if (fromIdx < 0 || toIdx < 0) {
        console.error("Usage: simulate.ts replay --from <ledger> --to <ledger> [--rpc-url <url>] [--contract <id>] [--output events.json]");
        process.exit(1);
      }
      const rpcIdx = rest.indexOf("--rpc-url");
      const contractIdx = rest.indexOf("--contract");
      const outputIdx = rest.indexOf("--output");
      await replayEventsFromIndexer(Number(rest[fromIdx + 1]), Number(rest[toIdx + 1]), {
        rpcUrl: rpcIdx >= 0 ? rest[rpcIdx + 1] : undefined,
        contractId: contractIdx >= 0 ? rest[contractIdx + 1] : undefined,
        outputPath: outputIdx >= 0 ? rest[outputIdx + 1] : undefined,
      });
      break;
    }
    default:
      console.error(
        "Usage: simulate.ts <run|generate|compare|replay> ...\nSee the file header comment for details on each subcommand.",
      );
      process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
