import { describe, it, expect, beforeEach } from "vitest";
import {
  MetricsRegistry,
  createMetrics,
  type TaskOutcome,
} from "./metrics";

describe("agents runtime metrics", () => {
  let metrics: MetricsRegistry;

  beforeEach(() => {
    metrics = createMetrics();
  });

  it("counts task runs and outcomes", () => {
    metrics.recordTaskRun("success");
    metrics.recordTaskRun("success");
    metrics.recordTaskRun("failure");

    const snap = metrics.snapshot();
    expect(snap.taskRunsTotal).toBe(3);
    expect(snap.taskFailuresTotal).toBe(1);
    expect(snap.taskOutcomes.success).toBe(2);
    expect(snap.taskOutcomes.failure).toBe(1);
  });

  it("tracks circuit breaker state transitions", () => {
    metrics.setCircuitState("closed");
    expect(metrics.snapshot().circuitState).toBe("closed");

    metrics.setCircuitState("open");
    expect(metrics.snapshot().circuitState).toBe("open");

    metrics.setCircuitState("half_open");
    expect(metrics.snapshot().circuitState).toBe("half_open");
  });

  it("records submission outcomes", () => {
    metrics.recordSubmission("submitted");
    metrics.recordSubmission("rejected");
    metrics.recordSubmission("submitted");

    const snap = metrics.snapshot();
    expect(snap.submissionsTotal).toBe(3);
    expect(snap.submissionsByOutcome.submitted).toBe(2);
    expect(snap.submissionsByOutcome.rejected).toBe(1);
  });

  it("tracks trace backlog as a gauge", () => {
    metrics.setTraceBacklog(0);
    expect(metrics.snapshot().traceBacklog).toBe(0);

    metrics.setTraceBacklog(42);
    expect(metrics.snapshot().traceBacklog).toBe(42);

    metrics.setTraceBacklog(-5);
    expect(metrics.snapshot().traceBacklog).toBe(0);
  });

  it("tracks scheduler delay with bounded histogram buckets", () => {
    metrics.observeSchedulerDelay(5);
    metrics.observeSchedulerDelay(150);
    metrics.observeSchedulerDelay(5000);

    const snap = metrics.snapshot();
    expect(snap.schedulerDelay.count).toBe(3);
    expect(snap.schedulerDelay.sum).toBe(5155);
    expect(snap.schedulerDelay.buckets.length).toBeLessThanOrEqual(16);
  });

  it("enforces bounded cardinality for outcome labels", () => {
    const outcomes: TaskOutcome[] = ["success", "failure", "timeout", "skipped"];
    for (const o of outcomes) {
      metrics.recordTaskRun(o);
    }

    const snap = metrics.snapshot();
    const labelCount = Object.keys(snap.taskOutcomes).length;
    expect(labelCount).toBeLessThanOrEqual(outcomes.length);
  });

  it("does not leak secrets or unbounded market identifiers", () => {
    metrics.recordTaskRun("failure");
    metrics.recordSubmission("rejected");

    const snap = metrics.snapshot();
    const serialized = JSON.stringify(snap);

    expect(serialized).not.toMatch(/secret/i);
    expect(serialized).not.toMatch(/api[_-]?key/i);
    expect(serialized).not.toMatch(/token/i);
    expect(serialized).not.toMatch(/0x[0-9a-fA-F]{40}/);
    expect(serialized).not.toMatch(/[A-Z]{2,5}\/[A-Z]{2,5}/);
  });

  it("keeps dry-run default and does not bypass risk controls", () => {
    expect(metrics.isDryRun()).toBe(true);

    metrics.recordTaskRun("failure");
    metrics.recordSubmission("rejected");

    expect(metrics.isDryRun()).toBe(true);
    expect(metrics.snapshot().dryRun).toBe(true);
  });
});
