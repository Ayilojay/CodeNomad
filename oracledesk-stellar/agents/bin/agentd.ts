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
 * Remote signing service operational controls (issue #68):
 *   - Authentication hooks with default-deny (no token => reject).
 *   - Bounded request size and request timeout.
 *   - Replay rejection via a bounded nonce/seen-id window.
 *   - Durable audit interface; audit failure fails closed.
 *   - Readiness check that reports whether the service can accept work.
 *   - Secrets and raw signing material are never logged.
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

export interface AgentdOverrides {
  /** Task factories by name (tests inject fakes; default: maker, trader). */
  taskFactories?: Record<string, TaskFactory>;
  state?: StateStore;
  lease?: Lease;
  log?: Logger;
  /** Installs SIGINT/SIGTERM handlers (default true outside --once). */
  handleSignals?: boolean;
  /** Remote signing service controls (tests inject fakes). */
  signing?: SigningServiceOverrides;
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

// ---------------------------------------------------------------------------
// Remote signing service operational controls (issue #68)
// ---------------------------------------------------------------------------

/** Durable audit sink. Implementations must persist synchronously enough that
 * a thrown error means the record was NOT durably stored (fail closed). */
export interface SigningAuditSink {
  record(entry: SigningAuditEntry): Promise<void>;
}

export interface SigningAuditEntry {
  /** Monotonic request id supplied by the caller (never a secret). */
  requestId: string;
  /** Opaque operation label, e.g. "sign". */
  operation: string;
  /** Outcome of the request. */
  outcome: "accepted" | "rejected";
  /** Reason code for rejections (auth, replay, size, timeout, audit). */
  reason?: string;
  /** Wall-clock ms when the request was received. */
  at: number;
}

export interface SigningRequest {
  /** Bearer token presented by the caller. */
  token?: string;
  /** Caller-supplied unique id used for replay detection. */
  requestId: string;
  /** Serialized payload; size is bounded before any signing work. */
  payload: string;
}

export interface SigningResult {
  ok: boolean;
  reason?: "auth" | "replay" | "size" | "timeout" | "audit";
  /** Signed material; never logged by this module. */
  signature?: string;
}

export interface SigningServiceOverrides {
  /** Verifies a bearer token. Default: deny everything (no token configured). */
  authenticate?: (token: string | undefined) => boolean | Promise<boolean>;
  /** Performs the actual signing. Default: rejects (no signer wired). */
  sign?: (payload: string) => Promise<string>;
  /** Durable audit sink. Default: in-memory (tests only). */
  audit?: SigningAuditSink;
  /** Max payload bytes (default 8 KiB). */
  maxBytes?: number;
  /** Request timeout in ms (default 5s). */
  timeoutMs?: number;
  /** Replay window size (default 1024 ids). */
  replayWindow?: number;
  /** Clock injection for tests. */
  now?: () => number;
}

/** In-memory audit sink used only when no durable sink is provided. */
class MemoryAuditSink implements SigningAuditSink {
  readonly entries: SigningAuditEntry[] = [];
  async record(entry: SigningAuditEntry): Promise<void> {
    this.entries.push(entry);
  }
}

/** Bounded FIFO set for replay detection. */
class ReplayWindow {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];
  constructor(private readonly capacity: number) {}
  /** Returns true if the id was already seen (replay). */
  check(id: string): boolean {
    if (this.seen.has(id)) return true;
    this.seen.add(id);
    this.order.push(id);
    while (this.order.length > this.capacity) {
      const evicted = this.order.shift();
      if (evicted !== undefined) this.seen.delete(evicted);
    }
    return false;
  }
}

export interface SigningService {
  handle(req: SigningRequest): Promise<SigningResult>;
  ready(): boolean;
}

/** Builds a hardened signing service. Default-deny: without an authenticate
 * hook every request is rejected; without a sign hook signing is refused. */
export function createSigningService(o: SigningServiceOverrides = {}): SigningService {
  const maxBytes = o.maxBytes ?? 8 * 1024;
  const timeoutMs = o.timeoutMs ?? 5_000;
  const replay = new ReplayWindow(o.replayWindow ?? 1024);
  const audit = o.audit ?? new MemoryAuditSink();
  const now = o.now ?? (() => Date.now());
  let auditHealthy = true;

  async function record(entry: SigningAuditEntry): Promise<boolean> {
    try {
      await audit.record(entry);
      auditHealthy = true;
      return true;
    } catch {
      auditHealthy = false;
      return false;
    }
  }

  async function reject(requestId: string, reason: SigningResult["reason"]): Promise<SigningResult> {
    const ok = await record({ requestId, operation: "sign", outcome: "rejected", reason, at: now() });
    return { ok: false, reason: ok ? reason : "audit" };
  }

  return {
    ready(): boolean {
      return auditHealthy;
    },
    async handle(req: SigningRequest): Promise<SigningResult> {
      // 1. Authentication (default-deny).
      let authed = false;
      if (o.authenticate) {
        try {
          authed = await o.authenticate(req.token);
        } catch {
          authed = false;
        }
      }
      if (!authed) return reject(req.requestId, "auth");

      // 2. Bounded request size.
      const bytes = Buffer.byteLength(req.payload, "utf8");
      if (bytes > maxBytes) return reject(req.requestId, "size");

      // 3. Replay rejection.
      if (replay.check(req.requestId)) return reject(req.requestId, "replay");

      // 4. Bounded request time.
      if (!o.sign) return reject(req.requestId, "auth");
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, fail) => {
        timer = setTimeout(() => fail(new Error("timeout")), timeoutMs);
      });
      let signature: string;
      try {
        signature = await Promise.race([o.sign(req.payload), timeout]);
      } catch {
        return reject(req.requestId, "timeout");
      } finally {
        if (timer) clearTimeout(timer);
      }

      // 5. Durable audit; fail closed if the record cannot be stored.
      const ok = await record({ requestId: req.requestId, operation: "sign", outcome: "accepted", at: now() });
      if (!ok) return { ok: false, reason: "audit" };
      return { ok: true, signature };
    },
  };
}

/** Runs agentd and resolves with its exit code (never calls process.exit). */
export async function runAgentd(argv: string[], baseEnv: NodeJS.ProcessEnv, o: AgentdOverrides = {}): Promise<number> {
  const log = o.log ?? jsonLogger();
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
      return runtime.exitCode;
    }
    if (o.handleSignals !== false) installSignalHandlers(runtime, log);
    await runtime.start();
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

function installSignalHandlers(runtime: Runtime, log: Logger): void {
  let interrupts = 0;
  const onSignal = (signal: NodeJS.Signals) => {
    if (signal === "SIGINT" && ++interrupts > 1) {
      log.error("FORCED_EXIT", { signal, inFlight: runtime.inFlightCount });
      process.exit(130);
    }
    log.info("SIGNAL", { signal });
    void runtime.stop(signal);
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
