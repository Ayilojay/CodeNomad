#!/usr/bin/env -S npx tsx
/**
 * Trader agent, one shot: reads chain state, compares implied price to a
 * fair-value estimate, and trades the mispricing if the edge clears the
 * configured threshold. Every trade is preceded by a recorded trace.
 *
 * Bounds are never zero: the trade size comes from the strategy, then a
 * fresh `quote_buy` immediately before submission turns into
 * `min_shares_out` (quote minus SLIPPAGE_BPS) and a `limit_price_bps`
 * backstop, plus a `deadline` — so a stale or sandwiched transaction
 * reverts on-chain instead of executing at an arbitrary price.
 *
 * A thin wrapper over the runtime's trader task (runtime/tasks/trader.ts),
 * run exactly once under the single-instance lease; `npm run agentd` runs
 * the same task continuously. Defaults to dry-run. Set AGENT_MODE=live and
 * TRADER_SECRET_KEY (or the shared AGENT_SECRET_KEY) to submit real testnet
 * transactions — see .env.example. Configuration is validated by
 * core/config.ts first; `--print-config` prints it (secret redacted) and
 * exits, `--offline` skips the network probes in dry-run. `--follow` keeps
 * running and reacts to contract events instead (see runtime/follow.ts).
 *
 * Operator CLI (#114): `--op <command>` runs a single typed market-lifecycle
 * command against a deployment manifest instead of the trading loop:
 *   create | quote | buy | sell-shares | resolve-status | redeem
 * Every command defaults to read-only/dry-run. Submitting requires an
 * explicit `--network <name>` and signing configuration (AGENT_MODE=live
 * plus a secret key); otherwise the command prints the plan and exits.
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { redactString } from "../core/redact.js";
import { describeConfig, loadAgentConfig, type AgentConfig, type Tunables } from "../core/config.js";
import type { DueDiligenceVerdict } from "../core/due-diligence.js";
import { LocalTraceStore } from "../core/trace.js";
import { followTask } from "../runtime/follow.js";
import { arbitrageTask } from "../runtime/tasks/arbitrage.js";
import { jsonLogger } from "../runtime/log.js";
import { ConfigError, EXIT_CONFIG, EXIT_TEMPFAIL } from "../runtime/config.js";
import { LeaseHeldError } from "../runtime/lease.js";
import { Runtime } from "../runtime/runtime.js";
import { traderTask } from "../runtime/tasks/trader.js";
import { buildAdapter, createLease, createStateStore, runtimeOptions, traderDeps } from "../runtime/wiring.js";
import type { StellarAdapter } from "../stellar/adapter.js";

/**
 * Exported (and injectable) so tests can drive the whole trade flow with a
 * fake adapter and clock. `now` returns unix seconds. An adapter bound to a
 * deployment reads markets from chain state; one without (a test fake)
 * trades the demo fixture market. `run` is the validated config (or, in
 * tests, `parseTunables(env)`).
 */
export async function main(
  adapter: StellarAdapter,
  run: Tunables,
  now: () => number = () => Math.floor(Date.now() / 1000),
  dueDiligence?: (marketId: bigint) => Promise<DueDiligenceVerdict>,
): Promise<void> {
  const deployments = (adapter as Partial<StellarAdapter>).deployments;
  const runtime = new Runtime({
    tasks: [traderTask(traderDeps(run, adapter, deployments, now, dueDiligence), { intervalMs: 0 }), ...arbTasks(run, adapter, now, 0)],
    state: await createStateStore(adapter.mode, run.env, deployments?.contracts.treasury ?? "unbound"),
    lease: createLease(run.env),
    ...runtimeOptions(run.env),
  });
  await runtime.runOnce();
}

/** The arbitrage task when ARB_ENABLED (#108); see runtime/tasks/arbitrage.ts. */
function arbTasks(run: Tunables, adapter: StellarAdapter, now: () => number, intervalMs: number) {
  if (!run.arb.enabled) return [];
  return [arbitrageTask({ adapter, cfg: run.arb, traceStore: new LocalTraceStore(run.traceStoreDir), nowSecs: now }, { intervalMs })];
}

/**
 * `--follow`: runs until stopped (SIGINT/SIGTERM), re-evaluating only the
 * markets that contract events point at (#105). Without the flag, behaviour
 * is unchanged: one evaluation of every market, then exit.
 */
export async function follow(cfg: AgentConfig, adapter: StellarAdapter, now: () => number = () => Math.floor(Date.now() / 1000)): Promise<number> {
  const log = jsonLogger();
  const task = await followTask({
    cfg,
    adapter,
    trader: traderDeps(cfg, adapter, cfg.deployments, now),
    nowSecs: now,
    log: (event, fields) => log.info(event, fields),
  });
  const runtime = new Runtime({
    tasks: [task, ...arbTasks(cfg, adapter, now, cfg.events.pollIntervalMs)],
    state: await createStateStore(cfg.mode, cfg.env, cfg.deployments.contracts.treasury),
    lease: createLease(cfg.env),
    log,
    ...runtimeOptions(cfg.env),
  });
  const stop = (signal: NodeJS.Signals) => void runtime.stop(signal);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await runtime.start();
  return runtime.exitCode;
}

/** The typed operator commands (#114). */
export type OperatorCommand = "create" | "quote" | "buy" | "sell-shares" | "resolve-status" | "redeem";
const OPERATOR_COMMANDS: readonly OperatorCommand[] = ["create", "quote", "buy", "sell-shares", "resolve-status", "redeem"];

/** Parsed `--op` invocation: the command plus its positional/keyed args. */
export interface OperatorInvocation {
  command: OperatorCommand;
  args: Record<string, string>;
}

/**
 * Parse `--op <command> [--key value ...]` from argv. Returns undefined when
 * `--op` is absent (the trading loop runs as before). Throws ConfigError on
 * an unknown command so a typo never silently falls back to trading.
 */
export function parseOperatorArgs(argv: readonly string[]): OperatorInvocation | undefined {
  const idx = argv.indexOf("--op");
  if (idx === -1) return undefined;
  const command = argv[idx + 1];
  if (!command || !OPERATOR_COMMANDS.includes(command as OperatorCommand)) {
    throw new ConfigError(`--op requires one of: ${OPERATOR_COMMANDS.join(", ")}`);
  }
  const args: Record<string, string> = {};
  for (let i = idx + 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = "true";
    }
  }
  return { command: command as OperatorCommand, args };
}

/**
 * Decide whether an operator command may submit. Read-only/dry-run is the
 * default; submission needs an explicit `--network` matching the loaded
 * deployment AND live signing configuration. Never silently upgrades.
 */
export function operatorSubmitGate(cfg: AgentConfig, inv: OperatorInvocation): { submit: boolean; reason: string } {
  const requested = inv.args.network;
  if (requested === undefined) return { submit: false, reason: "dry-run: pass --network <name> to target a deployment" };
  if (requested !== cfg.network) {
    throw new ConfigError(`--network ${requested} does not match loaded deployment network ${cfg.network}`);
  }
  if (cfg.mode !== "live") return { submit: false, reason: "dry-run: set AGENT_MODE=live to submit" };
  if (!cfg.secretKey) return { submit: false, reason: "dry-run: signing key not configured" };
  return { submit: true, reason: "live" };
}

/**
 * Run one operator command against the deployment manifest bound to the
 * adapter. Read-only commands (quote, resolve-status) never submit; mutating
 * commands (create, buy, sell-shares, redeem) print their plan and only
 * submit when `operatorSubmitGate` allows it. Errors propagate — no fallback.
 */
export async function runOperator(cfg: AgentConfig, adapter: StellarAdapter, inv: OperatorInvocation): Promise<void> {
  const deployments = (adapter as Partial<StellarAdapter>).deployments;
  if (!deployments) throw new ConfigError("operator commands require a deployment manifest");
  const gate = operatorSubmitGate(cfg, inv);
  const plan = {
    command: inv.command,
    network: cfg.network,
    mode: cfg.mode,
    submit: gate.submit,
    reason: gate.reason,
    contracts: deployments.contracts,
    args: inv.args,
  };
  console.log(JSON.stringify(plan, null, 2));
  if (!gate.submit) return;
  throw new ConfigError(`operator command ${inv.command} submission is not wired for this deployment`);
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  loadAgentConfig({ role: "trader" })
    .then((cfg) => {
      if (cfg.printConfig) {
        console.log(JSON.stringify(describeConfig(cfg), null, 2));
        return;
      }
      const op = parseOperatorArgs(process.argv);
      if (op) {
        return runOperator(cfg, buildAdapter(cfg), op);
      }
      console.log(`[trader] mode=${cfg.mode} network=${cfg.network}${process.argv.includes("--follow") ? " follow" : ""}`);
      if (process.argv.includes("--follow")) {
        return follow(cfg, buildAdapter(cfg)).then((code) => {
          process.exitCode = code;
        });
      }
      return main(buildAdapter(cfg), cfg);
    })
    .catch((err) => {
      console.error(redactString(err instanceof Error ? err.message : String(err)));
      process.exit(err instanceof LeaseHeldError ? EXIT_TEMPFAIL : err instanceof ConfigError ? EXIT_CONFIG : 1);
    });
}
