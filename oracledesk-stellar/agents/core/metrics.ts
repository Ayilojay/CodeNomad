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
 * Agent decision-quality and calibration report (issue #75).
 *
 * Aggregates archived decisions into a versioned report covering:
 * - calibration buckets (predicted probability vs realized outcome),
 * - Brier score over labeled decisions,
 * - realized-versus-expected edge,
 * - skip reasons and exposure outcomes.
 *
 * Design constraints:
 * - Pure evaluation only: no control-flow authority, never bypasses the safe
 *   dry-run default or on-chain risk controls.
 * - Unavailable outcomes are distinguished from losses: a decision whose
 *   outcome is not yet known is excluded from scoring and counted separately,
 *   never treated as a loss.
 * - The report schema is versioned via `CALIBRATION_REPORT_VERSION`.
 */

export const CALIBRATION_REPORT_VERSION = 1;

/** Fixed calibration bucket boundaries over predicted probability [0, 1]. */
export const CALIBRATION_BUCKETS: readonly number[] = [
  0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0,
];

export type ExposureOutcome = "win" | "loss" | "flat" | "unavailable";

export interface ArchivedDecision {
  /** Predicted probability of a positive outcome, in [0, 1]. */
  predictedProbability: number;
  /** Realized outcome: true = win, false = loss, null = not yet known. */
  realizedOutcome: boolean | null;
  /** Expected edge (fractional) the decision anticipated. */
  expectedEdge: number;
  /** Realized edge (fractional) once known; null when unavailable. */
  realizedEdge: number | null;
  /** Bounded skip reason when the decision was skipped, else null. */
  skipReason: string | null;
}

export interface CalibrationBucket {
  /** Inclusive lower bound of the bucket. */
  lower: number;
  /** Exclusive upper bound of the bucket (inclusive for the last bucket). */
  upper: number;
  /** Number of labeled decisions in this bucket. */
  count: number;
  /** Mean predicted probability within the bucket (0 when empty). */
  meanPredicted: number;
  /** Realized win rate within the bucket (0 when empty). */
  realizedRate: number;
}

export interface CalibrationReport {
  version: number;
  /** Total archived decisions considered. */
  totalDecisions: number;
  /** Decisions with a known outcome (used for scoring). */
  labeledDecisions: number;
  /** Decisions whose outcome is not yet known (excluded from scoring). */
  unavailableDecisions: number;
  /** Brier score over labeled decisions (lower is better); null if none. */
  brierScore: number | null;
  /** Mean expected edge over labeled decisions; null if none. */
  expectedEdge: number | null;
  /** Mean realized edge over labeled decisions; null if none. */
  realizedEdge: number | null;
  /** Realized minus expected edge; null if unavailable. */
  realizedVersusExpectedEdge: number | null;
  /** Calibration buckets over predicted probability. */
  buckets: CalibrationBucket[];
  /** Counts of skip reasons (bounded, sorted by reason). */
  skipReasons: Record<string, number>;
  /** Counts of exposure outcomes. */
  exposureOutcomes: Record<ExposureOutcome, number>;
}

function clampProbability(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function bucketIndex(probability: number): number {
  const last = CALIBRATION_BUCKETS.length - 2;
  for (let i = 0; i < last; i += 1) {
    if (probability < CALIBRATION_BUCKETS[i + 1]) {
      return i;
    }
  }
  return last;
}

/**
 * Build a versioned decision-quality and calibration report from archived
 * decisions. Unavailable outcomes are excluded from scoring and counted
 * separately, never treated as losses.
 */
export function buildCalibrationReport(
  decisions: readonly ArchivedDecision[],
): CalibrationReport {
  const bucketCount = CALIBRATION_BUCKETS.length - 1;
  const bucketCounts = new Array<number>(bucketCount).fill(0);
  const bucketPredicted = new Array<number>(bucketCount).fill(0);
  const bucketWins = new Array<number>(bucketCount).fill(0);

  const skipReasons: Record<string, number> = {};
  const exposureOutcomes: Record<ExposureOutcome, number> = {
    win: 0,
    loss: 0,
    flat: 0,
    unavailable: 0,
  };

  let labeled = 0;
  let unavailable = 0;
  let brierSum = 0;
  let expectedSum = 0;
  let realizedSum = 0;
  let realizedCount = 0;

  for (const decision of decisions) {
    const probability = clampProbability(decision.predictedProbability);

    if (decision.skipReason) {
      skipReasons[decision.skipReason] = (skipReasons[decision.skipReason] ?? 0) + 1;
    }

    if (decision.realizedOutcome === null) {
      unavailable += 1;
      exposureOutcomes.unavailable += 1;
      continue;
    }

    labeled += 1;
    const realized = decision.realizedOutcome ? 1 : 0;
    brierSum += (probability - realized) ** 2;
    expectedSum += Number.isFinite(decision.expectedEdge) ? decision.expectedEdge : 0;

    if (decision.realizedEdge !== null && Number.isFinite(decision.realizedEdge)) {
      realizedSum += decision.realizedEdge;
      realizedCount += 1;
    }

    if (decision.realizedOutcome) {
      exposureOutcomes.win += 1;
    } else {
      exposureOutcomes.loss += 1;
    }

    const index = bucketIndex(probability);
    bucketCounts[index] += 1;
    bucketPredicted[index] += probability;
    bucketWins[index] += realized;
  }

  const buckets: CalibrationBucket[] = [];
  for (let i = 0; i < bucketCount; i += 1) {
    const count = bucketCounts[i];
    buckets.push({
      lower: CALIBRATION_BUCKETS[i],
      upper: CALIBRATION_BUCKETS[i + 1],
      count,
      meanPredicted: count > 0 ? bucketPredicted[i] / count : 0,
      realizedRate: count > 0 ? bucketWins[i] / count : 0,
    });
  }

  const expectedEdge = labeled > 0 ? expectedSum / labeled : null;
  const realizedEdge = realizedCount > 0 ? realizedSum / realizedCount : null;

  return {
    version: CALIBRATION_REPORT_VERSION,
    totalDecisions: decisions.length,
    labeledDecisions: labeled,
    unavailableDecisions: unavailable,
    brierScore: labeled > 0 ? brierSum / labeled : null,
    expectedEdge,
    realizedEdge,
    realizedVersusExpectedEdge:
      expectedEdge !== null && realizedEdge !== null
        ? realizedEdge - expectedEdge
        : null,
    buckets,
    skipReasons,
    exposureOutcomes,
  };
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
  strategyRetur

/* … truncated 6852 chars — edit only what you need near the top … */
