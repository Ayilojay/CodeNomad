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
