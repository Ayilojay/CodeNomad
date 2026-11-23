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

/**
 * Indexer ingestion health states (issue #95).
 *
 * `stale` and `failed` are deliberately distinct: a stale indexer is still
 * making progress but has fallen behind, while a failed indexer has stopped
 * ingesting (decode failures / retries exhausted). Neither is ever reported as
 * `healthy`, so there is no success-shaped fallback.
 */
export type IngestionHealth = "healthy" | "stale" | "failed";

export interface IngestionMetricsSnapshot {
  /** Ledger lag: latest chain ledger minus last ingested ledger (>= 0). */
  ledgerLag: number;
  /** Most recent poll duration in milliseconds (>= 0). */
  pollDurationMs: number;
  /** Cumulative decode failures. */
  decodeFailures: number;
  /** Cumulative ingestion retries. */
  retries: number;
  /** Age of the last durable checkpoint in milliseconds (>= 0). */
  checkpointAgeMs: number;
  /** Derived health state (exactly one active). */
  health: Record<IngestionHealth, number>;
}

export interface IngestionThresholds {
  /** Ledger lag at or above which ingestion is considered stale. */
  staleLedgerLag: number;
  /** Checkpoint age (ms) at or above which ingestion is considered stale. */
  staleCheckpointAgeMs: number;
}

export const DEFAULT_INGESTION_THRESHOLDS: IngestionThresholds = {
  staleLedgerLag: 50,
  staleCheckpointAgeMs: 120_000,
};

export interface MetricsSnapshot {
  taskRuns: Record<TaskOutcome, number>;
  taskFailures: Record<FailureReason, number>;
  circuitState: Record<CircuitState, number>;
  submissions: Record<SubmissionResult, number>;
  traceBacklog: number;
  schedulerDelayMs: number;
  ingestion: IngestionMetricsSnapshot;
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
const INGESTION_HEALTH: readonly IngestionHealth[] = ["healthy", "stale", "failed"];

function zeroed<K extends string>(keys: readonly K[]): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const key of keys) {
    out[key] = 0;
  }
  return out;
}

function clampNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
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

  private ledgerLag = 0;
  private pollDurationMs = 0;
  private decodeFailures = 0;
  private retries = 0;
  private checkpointAgeMs = 0;
  private ingestionFailed = false;
  private ingestionThresholds: IngestionThresholds = { ...DEFAULT_INGESTION_THRESHOLDS };

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

  /**
   * Configure the stale-ingestion thresholds. Non-finite or negative values
   * fall back to the defaults so health can never be silently disabled.
   */
  setIngestionThresholds(thresholds: Partial<IngestionThresholds>): void {
    const next = { ...this.ingestionThresholds };
    if (thresholds.staleLedgerLag !== undefined) {
      next.staleLedgerLag = clampNonNegative(thresholds.staleLedgerLag);
    }
    if (thresholds.staleCheckpointAgeMs !== undefined) {
      next.staleCheckpointAgeMs = clampNonNegative(thresholds.staleCheckpointAgeMs);
    }
    this.ingestionThresholds = next;
  }

  /** Set the current ledger lag (latest chain ledger minus last ingested). */
  setLedgerLag(lag: number): void {
    this.ledgerLag = clampNonNegative(lag);
  }

  /** Set the most recent poll duration in milliseconds (clamped >= 0). */
  setPollDurationMs(durationMs: number): void {
    this.pollDurationMs = clampNonNegative(durationMs);
  }

  /** Set the age of the last durable checkpoint in milliseconds (clamped >= 0). */
  setCheckpointAgeMs(ageMs: number): void {
    this.checkpointAgeMs = clampNonNegative(ageMs);
  }

  /** Record a decode failure (increments the cumulative counter). */
  recordDecodeFailure(): void {
    this.decodeFailures += 1;
  }

  /** Record an ingestion retry (increments the cumulative counter). */
  recordRetry(): void {
    this.retries += 1;
  }

  /**
   * Mark ingestion as failed (e.g. decode failures or retries exhausted).
   * A failed indexer is reported as `failed`, never as `healthy`.
   */
  markIngestionFailed(): void {
    this.ingestionFailed = true;
  }

  /** Clear the failed flag once ingestion recovers. */
  clearIngestionFailed(): void {
    this.ingestionFailed = false;
  }

  /**
   * Derive the current ingestion health state.
   *
   * Precedence: `failed` (explicit failure) > `stale` (lag or checkpoint age
   * over threshold) > `healthy`. There is no success-shaped fallback: an
   * unknown/absent signal never masks a failure.
   */
  ingestionHealth(): IngestionHealth {
    if (this.ingestionFailed) {
      return "failed";
    }
    if (
      this.ledgerLag >= this.ingestionThresholds.staleLedgerLag ||
      this.checkpointAgeMs >= this.ingestionThresholds.staleCheckpointAgeMs
    ) {
      return "stale";
    }
    return "healthy";
  }

  /** Return a defensive copy of the current metric values. */
  snapshot(): MetricsSnapshot {
    const health = zeroed(INGESTION_HEALTH);
    health[this.ingestionHealth()] = 1;
    return {
      taskRuns: { ...this.taskRuns },
      taskFailures: { ...this.taskFailures },
      circuitState: { ...this.circuitState },
      submissions: { ...this.submissions },
      traceBacklog: this.traceBacklog,
      schedulerDelayMs: this.schedulerDelayMs,
      ingestion: {
        ledgerLag: this.ledgerLag,
        pollDurationMs: this.pollDurationMs,
        decodeFailures: this.decodeFailures,
        retries: this.retries,
        checkpointAgeMs: this.checkpointAgeMs,
        health,
      },
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
    this.ledgerLag = 0;
    this.pollDurationMs = 0;
    this.decodeFailures = 0;
    this.retries = 0;
    this.checkpointAgeMs = 0;
    this.ingestionFailed = false;
    this.ingestionThresholds = { ...DEFAULT_INGESTION_THRESHOLDS };
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

  const ingestion = snapshot.ingestion;

  lines.push("# HELP indexer_ledger_lag Ledgers between chain head and last ingested ledger.");
  lines.push("# TYPE indexer_ledger_lag gauge");
  lines.push(`indexer_ledger_lag ${ingestion.ledgerLag}`);

  lines.push("# HELP indexer_poll_duration_ms Most recent ingestion poll duration in ms.");
  lines.push("# TYPE indexer_poll_duration_ms gauge");
  lines.push(`indexer_poll_duration_ms ${ingestion.pollDurationMs}`);

  lines.push("# HELP indexer_decode_failures_total Cumulative decode failures.");
  lines.push("# TYPE indexer_decode_failures_total counter");
  lines.push(`indexer_decode_failures_total ${ingestion.decodeFailures}`);

  lines.push("# HELP indexer_retries_total Cumulative ingestion retries.");
  lines.push("# TYPE indexer_retries_total counter");
  lines.push(`indexer_retries_total ${ingestion.retries}`);

  lines.push("# HELP indexer_checkpoint_age_ms Age of the last durable checkpoint in ms.");
  lines.push("# TYPE indexer_checkpoint_age_ms gauge");
  lines.push(`indexer_checkpoint_age_ms ${ingestion.checkpointAgeMs}`);

  lines.push("# HELP indexer_health Ingestion health state (1 = active).");
  lines.push("# TYPE indexer_health gauge");
  for (const state of INGESTION_HEALTH) {
    lines.push(`indexer_health{state="${state}"} ${ingestion.health[state]}`);
  }

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
}
