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
  /** Mean absolute calibration error of predicted vs realized returns. */
  calibrationError: number;
}

/**
 * Strategy tournament evaluation with risk-adjusted scoring (issue #63).
 *
 * Design constraints:
 * - Variants are compared across a SHARED set of seeds. A comparison is only
 *   valid when every variant was evaluated on the identical seed set; unpaired
 *   comparisons are rejected rather than silently reported.
 * - Risk-adjusted metrics are computed per variant: drawdown, tail loss
 *   (worst-case / CVaR-style), turnover, calibration error and capital use.
 * - Uncertainty intervals are reported for each metric so that differences
 *   between variants are not over-interpreted.
 * - Pure evaluation only: this module has no control-flow authority and never
 *   bypasses the safe dry-run default or on-chain risk controls.
 */

export interface TournamentMetrics {
  /** Mean total return across seeds (fractional). */
  meanReturn: number;
  /** Mean maximum drawdown across seeds (fractional, >= 0). */
  meanDrawdown: number;
  /** Mean tail loss: average of the worst-quantile seed returns (fractional). */
  tailLoss: number;
  /** Mean turnover: average absolute position change per step. */
  meanTurnover: number;
  /** Mean calibration error across seeds (fractional, >= 0). */
  meanCalibrationError: number;
  /** Mean capital use: average absolute position fraction per step. */
  meanCapitalUse: number;
}

export interface Interval {
  /** Lower bound of the uncertainty interval. */
  low: number;
  /** Upper bound of the uncertainty interval. */
  high: number;
}

export interface TournamentVariantResult {
  /** Per-seed metric samples, keyed by seed. */
  samples: Record<string, TournamentMetrics>;
  /** Aggregated point estimates across seeds. */
  metrics: TournamentMetrics;
  /** Uncertainty intervals for each aggregated metric. */
  intervals: Record<keyof TournamentMetrics, Interval>;
  /** Risk-adjusted score (higher is better); see `riskAdjustedScore`. */
  score: number;
}

export interface TournamentResult {
  /** Ordered list of seeds shared by every variant. */
  seeds: string[];
  /** Per-variant results, keyed by variant name. */
  variants: Record<string, TournamentVariantResult>;
  /** Variant names ranked by risk-adjusted score (best first). */
  ranking: string[];
}

/** A single variant's per-seed metric sample. */
export interface TournamentSample {
  seed: string;
  metrics: TournamentMetrics;
}

export interface TournamentVariant {
  name: string;
  samples: TournamentSample[];
}

/** Fraction of the worst seeds used to compute tail loss (e.g. 0.2 = worst 20%). */
const TAIL_QUANTILE = 0.2;
/** Two-sided z-score for a ~95% uncertainty interval. */
const Z_95 = 1.96;

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const v of values) {
    sum += v;
  }
  return sum / values.length;
}

function stddev(values: number[]): number {
  if (values.length < 2) {
    return 0;
  }
  const m = mean(values);
  let acc = 0;
  for (const v of values) {
    const d = v - m;
    acc += d * d;
  }
  return Math.sqrt(acc / (values.length - 1));
}

/**
 * Compute a mean and a ~95% uncertainty interval for a metric sample.
 * With fewer than two samples the interval collapses to the point estimate.
 */
function interval(values: number[]): Interval {
  const m = mean(values);
  if (values.length < 2) {
    return { low: m, high: m };
  }
  const half = (Z_95 * stddev(values)) / Math.sqrt(values.length);
  return { low: m - half, high: m + half };
}

/**
 * Risk-adjusted score for a variant: reward return, penalize drawdown, tail
 * loss, turnover and calibration error. Higher is better. Capital use is
 * reported but not scored (it is a constraint, not a reward).
 */
export function riskAdjustedScore(metrics: TournamentMetrics): number {
  return (
    metrics.meanReturn -
    metrics.meanDrawdown -
    metrics.tailLoss -
    metrics.meanTurnover -
    metrics.meanCalibrationError
  );
}

/**
 * Evaluate a strategy tournament across variants on a shared seed set.
 *
 * Throws when variants are not evaluated on identical seed sets, preventing
 * unpaired comparisons. Each variant must supply exactly one sample per seed.
 */
export function evaluateTournament(
  variants: TournamentVariant[],
): TournamentResult {
  if (variants.length === 0) {
    return { seeds: [], variants: {}, ranking: [] };
  }

  const referenceSeeds = variants[0].samples.map((s) => s.seed).sort();
  const referenceKey = referenceSeeds.join("\u0000");

  for (const variant of variants) {
    const seeds = variant.samples.map((s) => s.seed).sort();
    if (seeds.join("\u0000") !== referenceKey) {
      throw new Error(
        `Unpaired comparison: variant "${variant.name}" was not evaluated on the shared seed set`,
      );
    }
  }

  const results: Record<string, TournamentVariantResult> = {};

  for (const variant of variants) {
    const bySeed: Record<string, TournamentMetrics> = {};
    for (const sample of variant.samples) {
      bySeed[sample.seed] = sample.metrics;
    }

    const ordered = referenceSeeds.map((seed) => bySeed[seed]);
    const returns = ordered.map((m) => m.meanReturn);
    const drawdowns = ordered.map((m) => m.meanDrawdown);
    const turnovers = ordered.map((m) => m.meanTurnover);
    const calibrations = ordered.map((m) => m.meanCalibrationError);
    const capitalUses = ordered.map((m) => m.meanCapitalUse);

    // Tail loss: average of the worst TAIL_QUANTILE fraction of seed returns.
    const sortedReturns = [...returns].sort((a, b) => a - b);
    const tailCount = Math.max(1, Math.ceil(sortedReturns.length * TAIL_QUANTILE));
    const tailLoss = -mean(sortedReturns.slice(0, tailCount));

    const metrics: TournamentMetrics = {
      meanReturn: mean(returns),
      meanDrawdown: mean(drawdowns),
      tailLoss,
      meanTurnover: mean(turnovers),
      meanCalibrationError: mean(calibrations),
      meanCapitalUse: mean(capitalUses),
    };

    results[variant.name] = {
      samples: bySeed,
      metrics,
      intervals: {
        meanReturn: interval(returns),
        meanDrawdown: interval(drawdowns),
        tailLoss: interval(ordered.map((m) => -m.meanReturn)),
        meanTurnover: interval(turnovers),
        meanCalibrationError: interval(calibrations),
        meanCapitalUse: interval(capitalUses),
      },
      score: riskAdjustedScore(metrics),
    };
  }

  const ranking = Object.keys(results).sort(
    (a, b) => results[b].score - results[a].score,
  );

  return { seeds: referenceSeeds, variants: results, ranking };
}
