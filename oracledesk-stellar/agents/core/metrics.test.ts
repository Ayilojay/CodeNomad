import { describe, it, expect, beforeEach } from "vitest";
import {
  MetricsRegistry,
  createMetrics,
  type TaskOutcome,
} from "./metrics";
import {
  runTournament,
  type StrategyVariant,
  type SeedRunResult,
} from "./backtest";

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

// Deterministic multi-seed fixtures for tournament evaluation.
const SEEDS = [1, 2, 3, 4, 5];

function makeRun(seed: number, overrides: Partial<SeedRunResult> = {}): SeedRunResult {
  return {
    seed,
    pnl: 100 + seed * 10,
    maxDrawdown: 0.1 + seed * 0.01,
    tailLoss: 0.05 + seed * 0.005,
    turnover: 1000 + seed * 100,
    calibration: 0.9 - seed * 0.01,
    capitalUse: 0.5 + seed * 0.02,
    ...overrides,
  };
}

function makeVariant(
  id: string,
  runs: SeedRunResult[],
): StrategyVariant {
  return { id, runs };
}

describe("strategy tournament evaluation", () => {
  it("compares variants across shared seeds with risk-adjusted scoring", () => {
    const conservative = makeVariant(
      "conservative",
      SEEDS.map((s) => makeRun(s, { maxDrawdown: 0.05, tailLoss: 0.02, turnover: 500 })),
    );
    const aggressive = makeVariant(
      "aggressive",
      SEEDS.map((s) => makeRun(s, { maxDrawdown: 0.3, tailLoss: 0.25, turnover: 5000 })),
    );

    const report = runTournament([conservative, aggressive], { seeds: SEEDS });

    expect(report.seeds).toEqual(SEEDS);
    expect(report.variants).toHaveLength(2);

    const cons = report.variants.find((v) => v.id === "conservative")!;
    const aggr = report.variants.find((v) => v.id === "aggressive")!;

    // Risk-adjusted score should favor the lower-drawdown variant.
    expect(cons.score).toBeGreaterThan(aggr.score);
    expect(report.ranking[0]).toBe("conservative");

    // Each metric reports an uncertainty interval.
    for (const metric of ["maxDrawdown", "tailLoss", "turnover", "calibration", "capitalUse"] as const) {
      const interval = cons.intervals[metric];
      expect(interval.low).toBeLessThanOrEqual(interval.high);
      expect(interval.mean).toBeGreaterThanOrEqual(interval.low);
      expect(interval.mean).toBeLessThanOrEqual(interval.high);
    }
  });

  it("is deterministic across repeated runs", () => {
    const a = makeVariant("a", SEEDS.map((s) => makeRun(s)));
    const b = makeVariant("b", SEEDS.map((s) => makeRun(s, { pnl: 50 })));

    const first = runTournament([a, b], { seeds: SEEDS });
    const second = runTournament([a, b], { seeds: SEEDS });

    expect(second).toEqual(first);
  });

  it("rejects unpaired comparisons when seed sets differ", () => {
    const paired = makeVariant("paired", SEEDS.map((s) => makeRun(s)));
    const unpaired = makeVariant(
      "unpaired",
      [1, 2, 3].map((s) => makeRun(s)),
    );

    expect(() => runTournament([paired, unpaired], { seeds: SEEDS })).toThrow(
      /unpaired|seed/i,
    );
  });

  it("rejects variants evaluated on seeds outside the shared set", () => {
    const variant = makeVariant(
      "mismatched",
      [1, 2, 3, 4, 99].map((s) => makeRun(s)),
    );

    expect(() => runTournament([variant], { seeds: SEEDS })).toThrow(/seed/i);
  });

  it("handles a single variant without comparison errors", () => {
    const only = makeVariant("only", SEEDS.map((s) => makeRun(s)));
    const report = runTournament([only], { seeds: SEEDS });

    expect(report.variants).toHaveLength(1);
    expect(report.ranking).toEqual(["only"]);
  });
});
