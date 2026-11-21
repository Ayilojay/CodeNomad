/**
 * Runtime metrics for the agent task loop.
 *
 * Design constraints (issue #72):
 * - Bounded cardinality: only fixed label sets are allowed. Market identifiers
 *   (asset pairs, contract ids, task ids, etc.) are NEVER used as labels.
 * - No secrets: values are numeric counters/gauges only; no payloads, keys or
 *   free-form strings are recorded.
 * - Observability only: recording metrics must never influence the safe
 *   dry-run default or bypass on-chain risk controls. This module is a pure
 *   side-channel and has no control-flow authority.
 */

export type TaskOutcome = "success" | "failure";

export type FailureReason =
  | "validation"
  | "simulation"
  | "submission"
  | "timeout"
  | "unknown";

export type CircuitState = "closed" | "open" | "half_open";

export type SubmissionResult = "accepted" | "rejected" | "dry_run";

export interface MetricsSnapshot {
  taskRuns: Record<TaskOutcome, number>;
  taskFailures: Record<FailureReason, number>;
  circuitState: Record<CircuitState, number>;
  submissions: Record<SubmissionResult, number>;
  traceBacklog: number;
  schedulerDelayMs: number;
}

const TASK_OUTCOMES: readonly TaskOutcome[] = ["success", "failure"];
const FAILURE_REASONS: readonly FailureReason[] = [
  "validation",
  "simulation",
  "submission",
  "timeout",
  "unknown",
];
const CIRCUIT_STATES: readonly CircuitState[] = ["closed", "open", "half_open"];
const SUBMISSION_RESULTS: readonly SubmissionResult[] = [
  "accepted",
  "rejected",
  "dry_run",
];

function zeroed<K extends string>(keys: readonly K[]): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const key of keys) {
    out[key] = 0;
  }
  return out;
}

/**
 * In-memory, bounded-cardinality metrics registry for the agent runtime.
 *
 * All label dimensions are closed enumerations, so the number of series is
 * fixed regardless of how many markets or tasks are processed.
 */
export class AgentMetrics {
  private taskRuns = zeroed(TASK_OUTCOMES);
  private taskFailures = zeroed(FAILURE_REASONS);
  private circuitState = zeroed(CIRCUIT_STATES);
  private submissions = zeroed(SUBMISSION_RESULTS);
  private traceBacklog = 0;
  private schedulerDelayMs = 0;

  /** Record a completed task run and, on failure, its bounded reason. */
  recordTaskRun(outcome: TaskOutcome, reason?: FailureReason): void {
    if (!TASK_OUTCOMES.includes(outcome)) {
      return;
    }
    this.taskRuns[outcome] += 1;
    if (outcome === "failure") {
      const bounded = reason && FAILURE_REASONS.includes(reason) ? reason : "unknown";
      this.taskFailures[bounded] += 1;
    }
  }

  /** Set the current circuit breaker state (exactly one state is active). */
  setCircuitState(state: CircuitState): void {
    if (!CIRCUIT_STATES.includes(state)) {
      return;
    }
    for (const key of CIRCUIT_STATES) {
      this.circuitState[key] = key === state ? 1 : 0;
    }
  }

  /** Record a submission attempt outcome (dry-run is tracked separately). */
  recordSubmission(result: SubmissionResult): void {
    if (!SUBMISSION_RESULTS.includes(result)) {
      return;
    }
    this.submissions[result] += 1;
  }

  /** Set the current trace backlog depth (clamped to a non-negative integer). */
  setTraceBacklog(depth: number): void {
    this.traceBacklog = Number.isFinite(depth) && depth > 0 ? Math.floor(depth) : 0;
  }

  /** Set the most recent scheduler delay in milliseconds (clamped >= 0). */
  setSchedulerDelayMs(delayMs: number): void {
    this.schedulerDelayMs =
      Number.isFinite(delayMs) && delayMs > 0 ? Math.floor(delayMs) : 0;
  }

  /** Return a defensive copy of the current metric values. */
  snapshot(): MetricsSnapshot {
    return {
      taskRuns: { ...this.taskRuns },
      taskFailures: { ...this.taskFailures },
      circuitState: { ...this.circuitState },
      submissions: { ...this.submissions },
      traceBacklog: this.traceBacklog,
      schedulerDelayMs: this.schedulerDelayMs,
    };
  }

  /** Reset all metrics (useful between test cases or on process restart). */
  reset(): void {
    this.taskRuns = zeroed(TASK_OUTCOMES);
    this.taskFailures = zeroed(FAILURE_REASONS);
    this.circuitState = zeroed(CIRCUIT_STATES);
    this.submissions = zeroed(SUBMISSION_RESULTS);
    this.traceBacklog = 0;
    this.schedulerDelayMs = 0;
  }
}

/**
 * Render the snapshot as Prometheus text exposition format.
 *
 * Only fixed label values are emitted, so series cardinality stays bounded.
 */
export function renderPrometheus(snapshot: MetricsSnapshot): string {
  const lines: string[] = [];

  lines.push("# HELP agent_task_runs_total Completed agent task runs.");
  lines.push("# TYPE agent_task_runs_total counter");
  for (const outcome of TASK_OUTCOMES) {
    lines.push(
      `agent_task_runs_total{outcome="${outcome}"} ${snapshot.taskRuns[outcome]}`,
    );
  }

  lines.push("# HELP agent_task_failures_total Failed agent task runs by reason.");
  lines.push("# TYPE agent_task_failures_total counter");
  for (const reason of FAILURE_REASONS) {
    lines.push(
      `agent_task_failures_total{reason="${reason}"} ${snapshot.taskFailures[reason]}`,
    );
  }

  lines.push("# HELP agent_circuit_state Current circuit breaker state (1 = active).");
  lines.push("# TYPE agent_circuit_state gauge");
  for (const state of CIRCUIT_STATES) {
    lines.push(
      `agent_circuit_state{state="${state}"} ${snapshot.circuitState[state]}`,
    );
  }

  lines.push("# HELP agent_submissions_total Submission attempts by result.");
  lines.push("# TYPE agent_submissions_total counter");
  for (const result of SUBMISSION_RESULTS) {
    lines.push(
      `agent_submissions_total{result="${result}"} ${snapshot.submissions[result]}`,
    );
  }

  lines.push("# HELP agent_trace_backlog Current trace backlog depth.");
  lines.push("# TYPE agent_trace_backlog gauge");
  lines.push(`agent_trace_backlog ${snapshot.traceBacklog}`);

  lines.push("# HELP agent_scheduler_delay_ms Most recent scheduler delay in ms.");
  lines.push("# TYPE agent_scheduler_delay_ms gauge");
  lines.push(`agent_scheduler_delay_ms ${snapshot.schedulerDelayMs}`);

  return lines.join("\n") + "\n";
}

/**
 * Walk-forward backtest evaluation for trading strategies (issue #61).
 *
 * Design constraints:
 * - No look-ahead bias: at each step the strategy only sees observations up to
 *   and including the current index; future data is never passed to it.
 * - Fees and position/size caps are modeled on every rebalance.
 * - Missing data is handled by an explicit, documented policy.
 * - A benchmark (buy-and-hold) is evaluated alongside the strategy.
 * - Reports returns, drawdown and calibration alongside the benchmark.
 * - Pure evaluation only: this module has no control-flow authority and never
 *   bypasses the safe dry-run default or on-chain risk controls.
 */

export type MissingDataPolicy = "skip" | "hold" | "flat";

export interface BacktestObservation {
  /** Monotonic timestamp; observations must be supplied in ascending order. */
  timestamp: number;
  /** Reference price for the step; `null` marks a missing observation. */
  price: number | null;
}

export interface BacktestConfig {
  /** Proportional trading fee applied to the traded notional (e.g. 0.001). */
  feeRate: number;
  /** Maximum absolute position size as a fraction of equity (e.g. 1.0). */
  maxPositionFraction: number;
  /** Policy applied when an observation is missing. */
  missingDataPolicy: MissingDataPolicy;
}

export interface BacktestStep {
  timestamp: number;
  /** Target position fraction chosen by the strategy (post-cap). */
  position: number;
  /** Strategy equity after fees for this step. */
  equity: number;
  /** Benchmark (buy-and-hold) equity for this step. */
  benchmarkEquity: number;
  /** True when the observation was missing and the policy was applied. */
  missing: boolean;
}

export interface BacktestResult {
  steps: BacktestStep[];
  /** Total strategy return over the window (fractional). */
  strategyReturn: number;
  /** Total benchmark return over the window (fractional). */
  benchmarkReturn: number;
  /** Maximum peak-to-trough drawdown of the strategy (fractional, >= 0). */
  maxDrawdown: number;
  /** Brier score of the strategy's directional predictions (lower is better). */
  calibration: number;
  /** Number of steps where the missing-data policy was applied. */
  missingSteps: number;
}

/**
 * Strategy callback: receives only the observations available up to and
 * including `index` (no look-ahead) and returns a target position fraction.
 */
export type BacktestStrategy = (
  history: readonly BacktestObservation[],
  index: number,
) => number;

function clampPosition(position: number, maxFraction: number): number {
  if (!Number.isFinite(position)) {
    return 0;
  }
  const cap = Math.max(0, maxFraction);
  return Math.max(-cap, Math.min(cap, position));
}

/**
 * Run a walk-forward backtest over time-ordered observations.
 *
 * Each step evaluates the strategy using only `observations[0..i]`, applies
 * fees on the traded notional, clamps the position to the configured cap, and
 * applies the missing-data policy when the current price is `null`.
 */
export function runWalkForwardBacktest(
  observations: readonly BacktestObservation[],
  strategy: BacktestStrategy,
  config: BacktestConfig,
): BacktestResult {
  const steps: BacktestStep[] = [];
  const feeRate = Number.isFinite(config.feeRate) && config.feeRate > 0 ? config.feeRate : 0;
  const maxFraction =
    Number.isFinite(config.maxPositionFraction) && config.maxPositionFraction > 0
      ? config.maxPositionFraction
      : 0;
  const policy = config.missingDataPolicy;

  let strategyEquity = 1;
  let benchmarkEquity = 1;
  let prevPosition = 0;
  let prevPrice: number | null = null;
  let peak = 1;
  let maxDrawdown = 0;
  let missingSteps = 0;
  let brierSum = 0;
  let brierCount = 0;

  for (let i = 0; i < observations.length; i += 1) {
    const obs = observations[i];
    const missing = obs.price === null || !Number.isFinite(obs.price as number);

    let targetPosition: number;
    if (missing) {
      missingSteps += 1;
      if (policy === "flat") {
        targetPosition = 0;
      } else if (policy === "hold") {
        targetPosition = prevPosition;
      } else {
        // "skip": leave the position unchanged and do not trade this step.
        targetPosition = prevPosition;
      }
    } else {
      // No look-ahead: only history up to and including the current index.
      const history = observations.slice(0, i + 1);
      targetPosition = clampPosition(strategy(history, i), maxFraction);
    }

    const price = missing ? prevPrice : (obs.price as number);

    if (!missing && prevPrice !== null && price !== null) {
      const priceReturn = prevPrice === 0 ? 0 : price / prevPrice - 1;
      // Strategy earns the return on the position held into this step.
      strategyEquity *= 1 + prevPosition * priceReturn;
      // Benchmark is buy-and-hold from the first available price.
      benchmarkEquity *= 1 + priceReturn;

      // Calibration: did the strategy's directional call match the move?
      if (prevPosition !== 0) {
        const predictedUp = prevPosition > 0 ? 1 : 0;
        const actualUp = priceReturn > 0 ? 1 : 0;
        brierSum += (predictedUp - actualUp) ** 2;
        brierCount += 1;
      }
    }

    // Apply fees on the traded notional when the position changes.
    if (!missing && targetPosition !== prevPosition) {
      const tradedNotional = Math.abs(targetPosition - prevPosition) * strategyEquity;
      strategyEquity -= tradedNotional * feeRate;
    }

    prevPosition = targetPosition;
    if (!missing) {
      prevPrice = price;
    }

    peak = Math.max(peak, strategyEquity);
    const drawdown = peak === 0 ? 0 : (peak - strategyEquity) / peak;
    maxDrawdown = Math.max(maxDrawdown, drawdown);

    steps.push({
      timestamp: obs.timestamp,
      position: targetPosition,
      equity: strategyEquity,
      benchmarkEquity,
      missing,
    });
  }

  return {
    steps,
    strategyReturn: strategyEquity - 1,
    benchmarkReturn: benchmarkEquity - 1,
    maxDrawdown,
    calibration: brierCount === 0 ? 0 : brierSum / brierCount,
    missingSteps,
  };
}
