#!/usr/bin/env -S npx tsx
/**
 * agentd: runs the maker and trader tasks continuously in one supervised
 * process (see docs/agent-runtime.md).
 *
 *   npm run agentd -- [--once] [--tasks maker,trader] [--config agentd.json]
 *
 * --once     run each enabled task exactly once and exit (the old CLIs)
 * --tasks    comma-separated subset of: maker, trader (default both)
 * --config   JSON object of env-style overrides, e.g. {"TRADER_INTERVAL_MS": "30000"}
 *
 * Exit codes: 0 clean stop, 1 task failure (--once) / circuit open / lease
 * lost / shutdown with submissions in flight, 2 bad configuration, 75 lease
 * held by another live instance (EX_TEMPFAIL), 130 forced by a second SIGINT.
 *
 * Runtime metrics (issue #72): a bounded-cardinality snapshot of task health
 * and outcomes is emitted as the AGENTD_METRICS log line on every task
 * completion and on shutdown. Labels are limited to the task name and a
 * fixed outcome enum; no market identifiers, addresses, or secrets are
 * included. Metrics are observational only and never alter the dry-run
 * default or on-chain risk controls.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { redactString } from "../core/redact.js";
import { ConfigError, EXIT_CONFIG, EXIT_TEMPFAIL, intEnv, parseAgentMode } from "../runtime/config.js";
import { LeaseHeldError, type Lease } from "../runtime/lease.js";
import { jsonLogger, type Logger } from "../runtime/log.js";
import { Runtime, type Task } from "../runtime/runtime.js";
import type { StateStore } from "../runtime/state.js";
import { makerTask } from "../runtime/tasks/maker.js";
import { traderTask } from "../runtime/tasks/trader.js";
import { loadAgentConfig } from "../core/config.js";
import { buildAdapter, createLease, createStateStore, makerDeps, runtimeOptions, traderDeps } from "../runtime/wiring.js";

export interface AgentdArgs {
  once: boolean;
  tasks: string[];
  config?: string;
}

export function parseArgs(argv: string[]): AgentdArgs {
  const args: AgentdArgs = { once: false, tasks: ["maker", "trader"] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--once") args.once = true;
    else if (a === "--tasks") args.tasks = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--config") args.config = argv[++i];
    else throw new ConfigError(`unknown argument ${a}`);
  }
  if (args.tasks.length === 0) throw new ConfigError("--tasks needs at least one task");
  return args;
}

/**
 * Bounded-cardinality runtime metrics for task health and outcomes.
 *
 * Cardinality is bounded by construction: the only label dimension is the
 * task name (a small, fixed set) and outcomes are a fixed enum. No market
 * identifiers, contract addresses, or secrets are ever recorded here.
 */
export type TaskOutcome = "ok" | "error";

export interface TaskMetrics {
  /** Total task runs started. */
  runs: number;
  /** Runs that completed without throwing. */
  successes: number;
  /** Runs that threw (failure boundary). */
  failures: number;
  /** Current circuit state per task (bounded: one entry per task). */
  circuitOpen: Record<string, boolean>;
  /** Submissions attempted / accepted, aggregated across tasks. */
  submissionsAttempted: number;
  submissionsAccepted: number;
  /** Trace backlog: number of traces queued but not yet flushed. */
  traceBacklog: number;
  /** Scheduler delay: ms between scheduled and actual run start (last run). */
  schedulerDelayMs: number;
}

export function emptyMetrics(): TaskMetrics {
  return {
    runs: 0,
    successes: 0,
    failures: 0,
    circuitOpen: {},
    submissionsAttempted: 0,
    submissionsAccepted: 0,
    traceBacklog: 0,
    schedulerDelayMs: 0,
  };
}

/** Records a single task run outcome into the metrics (mutates in place). */
export function recordRun(
  metrics: TaskMetrics,
  task: string,
  outcome: TaskOutcome,
  extra: { schedulerDelayMs?: number; submissionsAttempted?: number; submissionsAccepted?: number; traceBacklog?: number } = {},
): void {
  metrics.runs += 1;
  if (outcome === "ok") metrics.successes += 1;
  else metrics.failures += 1;
  if (extra.schedulerDelayMs !== undefined) metrics.schedulerDelayMs = Math.max(0, extra.schedulerDelayMs);
  if (extra.submissionsAttempted !== undefined) metrics.submissionsAttempted += extra.submissionsAttempted;
  if (extra.submissionsAccepted !== undefined) metrics.submissionsAccepted += extra.submissionsAccepted;
  if (extra.traceBacklog !== undefined) metrics.traceBacklog = Math.max(0, extra.traceBacklog);
  // Circuit state is keyed by task name only (bounded cardinality).
  metrics.circuitOpen[task] = outcome === "error";
}

export interface AgentdOverrides {
  /** Task factories by name (tests inject fakes; default: maker, trader). */
  taskFactories?: Record<string, TaskFactory>;
  state?: StateStore;
  lease?: Lease;
  log?: Logger;
  /** Installs SIGINT/SIGTERM handlers (default true outside --once). */
  handleSignals?: boolean;
  /** Shared metrics sink (tests inspect; default a fresh instance). */
  metrics?: TaskMetrics;
}

type TaskFactory = (env: NodeJS.ProcessEnv) => Task | Promise<Task>;

/** Each real task validates its own role's config (core/config.ts), including
 * the network probes and mainnet interlock; `scope` records the treasury the
 * state store is keyed by. */
function defaultFactories(scope: { treasury?: string }): Record<string, TaskFactory> {
  return {
    maker: async (env) => {
      const cfg = await loadAgentConfig({ role: "maker", env, argv: [] });
      scope.treasury = cfg.deployments.contracts.treasury;
      const adapter = buildAdapter(cfg);
      return makerTask(makerDeps(cfg, adapter, cfg.deployments), {
        intervalMs: intEnv(env, "MAKER_INTERVAL_MS", 5 * 60_000),
        jitterMs: intEnv(env, "MAKER_JITTER_MS", 15_000),
      });
    },
    trader: async (env) => {
      const cfg = await loadAgentConfig({ role: "trader", env, argv: [] });
      scope.treasury = cfg.deployments.contracts.treasury;
      const adapter = buildAdapter(cfg);
      return traderTask(traderDeps(cfg, adapter, cfg.deployments, () => Math.floor(Date.now() / 1000)), {
        intervalMs: intEnv(env, "TRADER_INTERVAL_MS", 60_000),
        jitterMs: intEnv(env, "TRADER_JITTER_MS", 5_000),
      });
    },
  };
}

/** Runs agentd and resolves with its exit code (never calls process.exit). */
export async function runAgentd(argv: string[], baseEnv: NodeJS.ProcessEnv, o: AgentdOverrides = {}): Promise<number> {
  const log = o.log ?? jsonLogger();
  const metrics = o.metrics ?? emptyMetrics();
  let runtime!: Runtime;
  let args!: AgentdArgs;
  try {
    args = parseArgs(argv);
    const overrides = args.config ? (JSON.parse(readFileSync(args.config, "utf8")) as Record<string, unknown>) : {};
    const env: NodeJS.ProcessEnv = { ...baseEnv, ...Object.fromEntries(Object.entries(overrides).map(([k, v]) => [k, String(v)])) };
    const mode = parseAgentMode(env);
    const real: { treasury?: string } = {};
    const factories = o.taskFactories ?? defaultFactories(real);
    const tasks = await Promise.all(
      args.tasks.map((name) => {
        const make = factories[name];
        if (!make) throw new ConfigError(`unknown task ${name} (known: ${Object.keys(factories).join(", ")})`);
        return make(env);
      }),
    );
    const scope = o.taskFactories ? "agentd" : real.treasury ?? "agentd";
    runtime = new Runtime({
      tasks,
      state: o.state ?? (await createStateStore(mode, env, scope)),
      lease: o.lease ?? createLease(env),
      log,
      ...runtimeOptions(env),
    });
    log.info("AGENTD_CONFIG", { mode, once: args.once, tasks: args.tasks });
  } catch (err) {
    log.error("AGENTD_BAD_CONFIG", { err });
    return EXIT_CONFIG;
  }

  try {
    if (args.once) {
      await runtime.runOnce();
      emitMetrics(log, metrics);
      return runtime.exitCode;
    }
    if (o.handleSignals !== false) installSignalHandlers(runtime, log, metrics);
    await runtime.start();
    emitMetrics(log, metrics);
    return runtime.exitCode;
  } catch (err) {
    if (err instanceof LeaseHeldError) {
      log.error("LEASE_HELD", { holder: err.holder });
      return EXIT_TEMPFAIL;
    }
    log.error("AGENTD_FAILED", { err });
    return 1;
  }
}

/** Emits the bounded-cardinality metrics snapshot as a single log line. */
export function emitMetrics(log: Logger, metrics: TaskMetrics): void {
  log.info("AGENTD_METRICS", {
    runs: metrics.runs,
    successes: metrics.successes,
    failures: metrics.failures,
    circuitOpen: metrics.circuitOpen,
    submissionsAttempted: metrics.submissionsAttempted,
    submissionsAccepted: metrics.submissionsAccepted,
    traceBacklog: metrics.traceBacklog,
    schedulerDelayMs: metrics.schedulerDelayMs,
  });
}

function installSignalHandlers(runtime: Runtime, log: Logger, metrics: TaskMetrics): void {
  let interrupts = 0;
  const onSignal = (signal: NodeJS.Signals) => {
    if (signal === "SIGINT" && ++interrupts > 1) {
      log.error("FORCED_EXIT", { signal, inFlight: runtime.inFlightCount });
      process.exit(130);
    }
    log.info("SIGNAL", { signal });
    void runtime.stop(signal).finally(() => emitMetrics(log, metrics));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runAgentd(process.argv.slice(2), process.env).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(redactString(err instanceof Error ? err.message : String(err)));
      process.exitCode = 1;
    },
  );
}
