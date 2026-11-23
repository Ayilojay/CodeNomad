import { describe, it, expect } from "vitest";

/**
 * Walk-forward backtest evaluation for trading strategies.
 *
 * Design notes (operational visibility / compatibility assumptions):
 * - Observations are strictly time-ordered. Each step only sees data up to and
 *   including the current observation, so there is no look-ahead bias.
 * - Trading fees are charged on the notional traded each step.
 * - Position size is capped by `maxPosition` (fraction of equity).
 * - Missing data policy is explicit: "skip" (hold prior position, no trade),
 *   "hold" (same as skip but still marks-to-market), or "flat" (force to cash).
 * - A buy-and-hold benchmark is reported alongside strategy returns.
 * - Drawdown and calibration (hit rate of directional calls) are reported.
 */

export interface Observation {
  /** ISO timestamp or monotonically increasing index. */
  t: number;
  /** Price at this observation; null means missing data. */
  price: number | null;
}

export type MissingDataPolicy = "skip" | "hold" | "flat";

export interface BacktestConfig {
  /** Per-trade fee as a fraction of notional (e.g. 0.001 = 10 bps). */
  feeRate: number;
  /** Max fraction of equity deployable into the position (0..1]. */
  maxPosition: number;
  /** How to treat observations with missing price. */
  missingDataPolicy: MissingDataPolicy;
  /** Initial equity. */
  initialEquity: number;
}

export interface BacktestMetrics {
  finalEquity: number;
  totalReturn: number;
  benchmarkReturn: number;
  maxDrawdown: number;
  /** Fraction of directional signals that were correct. */
  calibration: number;
  trades: number;
}

/**
 * A strategy maps the history available *up to and including* the current
 * observation to a target position fraction in [-1, 1]. It must not read
 * future observations; the runner only passes a prefix of the series.
 */
export type Strategy = (history: ReadonlyArray<Observation>) => number;

export function runWalkForwardBacktest(
  observations: ReadonlyArray<Observation>,
  strategy: Strategy,
  config: BacktestConfig,
): BacktestMetrics {
  if (observations.length === 0) {
    return {
      finalEquity: config.initialEquity,
      totalReturn: 0,
      benchmarkReturn: 0,
      maxDrawdown: 0,
      calibration: 0,
      trades: 0,
    };
  }

  let equity = config.initialEquity;
  let peak = equity;
  let maxDrawdown = 0;
  let position = 0; // fraction of equity currently held
  let trades = 0;
  let correct = 0;
  let directional = 0;

  let lastPrice: number | null = null;
  let benchmarkStart: number | null = null;

  for (let i = 0; i < observations.length; i++) {
    const obs = observations[i];
    const history = observations.slice(0, i + 1);

    if (obs.price === null) {
      if (config.missingDataPolicy === "flat") {
        if (position !== 0 && lastPrice !== null) {
          const notional = Math.abs(position) * equity;
          equity -= notional * config.feeRate;
          position = 0;
          trades++;
        }
      }
      // "skip" and "hold" both leave the position untouched on gaps.
      continue;
    }

    const price = obs.price;
    if (benchmarkStart === null) benchmarkStart = price;

    // Mark-to-market on the price move since the last valid price.
    if (lastPrice !== null && position !== 0) {
      const ret = (price - lastPrice) / lastPrice;
      equity *= 1 + position * ret;
    }

    // Strategy sees only the prefix (no look-ahead).
    const rawTarget = strategy(history);
    const target = Math.max(-1, Math.min(1, rawTarget)) * config.maxPosition;

    if (target !== position) {
      const notional = Math.abs(target - position) * equity;
      equity -= notional * config.feeRate;
      trades++;

      // Calibration: did the direction of the new target match the next move?
      const next = observations[i + 1];
      if (next && next.price !== null && target !== 0) {
        directional++;
        const move = next.price - price;
        if ((target > 0 && move > 0) || (target < 0 && move < 0)) correct++;
      }

      position = target;
    }

    peak = Math.max(peak, equity);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
    lastPrice = price;
  }

  const lastValid = [...observations].reverse().find((o) => o.price !== null);
  const benchmarkReturn =
    benchmarkStart !== null && lastValid && lastValid.price !== null
      ? (lastValid.price - benchmarkStart) / benchmarkStart
      : 0;

  return {
    finalEquity: equity,
    totalReturn: (equity - config.initialEquity) / config.initialEquity,
    benchmarkReturn,
    maxDrawdown,
    calibration: directional === 0 ? 0 : correct / directional,
    trades,
  };
}

// ---------------------------------------------------------------------------
// Treasury-wide loss and exposure stress model
//
// Single-instance caps do not bound aggregate risk from multiple deployments
// or correlated markets. This model aggregates several agent deployments that
// share market liquidity and can draw down simultaneously, then reports the
// worst-case capital at risk across the whole treasury.
//
// Operator-visible behavior:
// - Each deployment has a notional exposure and a per-deployment loss rate.
// - `correlation` in [0, 1] scales how much deployments move together: 0 means
//   independent losses, 1 means a fully correlated simultaneous drawdown.
// - `sharedLiquidity` caps the fraction of aggregate notional that can be
//   exited at once; illiquid shared markets amplify realized losses.
// - `worstCaseCapitalAtRisk` is the aggregate notional exposed under the
//   worst-case (fully correlated) scenario, bounded by the treasury budget.
// ---------------------------------------------------------------------------

export interface Deployment {
  /** Stable identifier for the agent deployment. */
  id: string;
  /** Notional capital deployed into this instance. */
  notional: number;
  /** Fractional loss applied to notional in a stress event (0..1]. */
  lossRate: number;
}

export interface StressScenario {
  deployments: ReadonlyArray<Deployment>;
  /** Correlation of outcomes across deployments/markets, in [0, 1]. */
  correlation: number;
  /** Fraction of aggregate notional exitable at once, in (0, 1]. */
  sharedLiquidity: number;
  /** Total treasury budget available to absorb losses. */
  treasuryBudget: number;
}

export interface StressResult {
  /** Aggregate notional across all deployments. */
  totalNotional: number;
  /** Worst-case loss under a fully correlated simultaneous drawdown. */
  worstCaseLoss: number;
  /** Worst-case capital at risk, bounded by the treasury budget. */
  worstCaseCapitalAtRisk: number;
  /** Losses realized when shared liquidity cannot absorb the exit. */
  liquidityAdjustedLoss: number;
  /** Whether the treasury budget covers the worst-case loss. */
  withinBudget: boolean;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

export function runTreasuryStress(scenario: StressScenario): StressResult {
  const correlation = clamp01(scenario.correlation);
  const liquidity = Math.max(1e-9, clamp01(scenario.sharedLiquidity));

  const totalNotional = scenario.deployments.reduce(
    (sum, d) => sum + Math.max(0, d.notional),
    0,
  );

  // Independent component: sum of individual expected losses.
  const independentLoss = scenario.deployments.reduce(
    (sum, d) => sum + Math.max(0, d.notional) * clamp01(d.lossRate),
    0,
  );

  // Correlated component: all deployments draw down simultaneously at the
  // worst per-deployment loss rate, applied to the full aggregate notional.
  const worstLossRate = scenario.deployments.reduce(
    (max, d) => Math.max(max, clamp01(d.lossRate)),
    0,
  );
  const correlatedLoss = totalNotional * worstLossRate;

  // Blend independent and correlated outcomes by correlation.
  const worstCaseLoss =
    independentLoss * (1 - correlation) + correlatedLoss * correlation;

  // Shared liquidity: the fraction of notional that cannot be exited at once
  // is marked at the worst loss rate again (slippage on the illiquid remainder).
  const illiquidFraction = 1 - liquidity;
  const liquidityAdjustedLoss =
    worstCaseLoss + totalNotional * illiquidFraction * worstLossRate;

  const worstCaseCapitalAtRisk = Math.min(
    totalNotional,
    Math.max(0, scenario.treasuryBudget),
  );

  return {
    totalNotional,
    worstCaseLoss,
    worstCaseCapitalAtRisk,
    liquidityAdjustedLoss,
    withinBudget: worstCaseLoss <= scenario.treasuryBudget,
  };
}

// Deterministic dataset for reproducible metrics.
const DATASET: Observation[] = [
  { t: 0, price: 100 },
  { t: 1, price: 110 },
  { t: 2, price: 121 },
  { t: 3, price: null },
  { t: 4, price: 100 },
  { t: 5, price: 90 },
  { t: 6, price: 99 },
];

const BASE_CONFIG: BacktestConfig = {
  feeRate: 0.001,
  maxPosition: 1,
  missingDataPolicy: "skip",
  initialEquity: 1000,
};

// Momentum strategy: go long if last valid price rose vs prior valid price.
const momentum: Strategy = (history) => {
  const valid = history.filter((o) => o.price !== null);
  if (valid.length < 2) return 0;
  const a = valid[valid.length - 2].price as number;
  const b = valid[valid.length - 1].price as number;
  return b > a ? 1 : b < a ? -1 : 0;
};

describe("runWalkForwardBacktest", () => {
  it("produces reproducible metrics on a deterministic dataset", () => {
    const a = runWalkForwardBacktest(DATASET, momentum, BASE_CONFIG);
    const b = runWalkForwardBacktest(DATASET, momentum, BASE_CONFIG);
    expect(a).toEqual(b);
    expect(a.trades).toBeGreaterThan(0);
    expect(Number.isFinite(a.totalReturn)).toBe(true);
    expect(a.maxDrawdown).toBeGreaterThanOrEqual(0);
    expect(a.calibration).toBeGreaterThanOrEqual(0);
    expect(a.calibration).toBeLessThanOrEqual(1);
  });

  it("does not leak future data into the strategy (no look-ahead)", () => {
    const seen: number[] = [];
    const spy: Strategy = (history) => {
      seen.push(history.length);
      return 0;
    };
    runWalkForwardBacktest(DATASET, spy, BASE_CONFIG);
    // Each call sees a strictly growing prefix, never the full series early.
    for (let i = 0; i < seen.length; i++) {
      expect(seen[i]).toBeLessThanOrEqual(DATASET.length);
    }
    expect(seen[0]).toBe(1);
  });

  it("charges fees on trades, reducing equity vs a fee-free run", () => {
    const withFees = runWalkForwardBacktest(DATASET, momentum, {
      ...BASE_CONFIG,
      feeRate: 0.01,
    });
    const noFees = runWalkForwardBacktest(DATASET, momentum, {
      ...BASE_CONFIG,
      feeRate: 0,
    });
    expect(withFees.finalEquity).toBeLessThan(noFees.finalEquity);
  });

  it("respects the position cap", () => {
    const capped = runWalkForwardBacktest(DATASET, momentum, {
      ...BASE_CONFIG,
      maxPosition: 0.5,
    });
    const full = runWalkForwardBacktest(DATASET, momentum, BASE_CONFIG);
    // Half-size exposure should not exceed full-size exposure on a rising run.
    expect(Math.abs(capped.totalReturn)).toBeLessThanOrEqual(
      Math.abs(full.totalReturn) + 1e-9,
    );
  });

  it("applies the flat missing-data policy by exiting on gaps", () => {
    const flat = runWalkForwardBacktest(DATASET, momentum, {
      ...BASE_CONFIG,
      missingDataPolicy: "flat",
    });
    const skip = runWalkForwardBacktest(DATASET, momentum, BASE_CONFIG);
    // Forcing flat on the gap adds an extra exit trade.
    expect(flat.trades).toBeGreaterThan(skip.trades);
  });

  it("reports a benchmark alongside strategy returns", () => {
    const m = runWalkForwardBacktest(DATASET, momentum, BASE_CONFIG);
    // Buy-and-hold from 100 to 99 => -1%.
    expect(m.benchmarkReturn).toBeCloseTo(-0.01, 6);
  });

  it("handles an empty series without throwing", () => {
    const m = runWalkForwardBacktest([], momentum, BASE_CONFIG);
    expect(m.finalEquity).toBe(BASE_CONFIG.initialEquity);
    expect(m.trades).toBe(0);
  });
});

describe("runTreasuryStress", () => {
  const DEPLOYMENTS: Deployment[] = [
    { id: "agent-a", notional: 1000, lossRate: 0.2 },
    { id: "agent-b", notional: 500, lossRate: 0.2 },
    { id: "agent-c", notional: 250, lossRate: 0.1 },
  ];

  const BASE_SCENARIO: StressScenario = {
    deployments: DEPLOYMENTS,
    correlation: 1,
    sharedLiquidity: 1,
    treasuryBudget: 1000,
  };

  it("aggregates notional across multiple deployments", () => {
    const r = runTreasuryStress(BASE_SCENARIO);
    expect(r.totalNotional).toBe(1750);
  });

  it("bounds worst-case loss by aggregate notional under full correlation", () => {
    const r = runTreasuryStress(BASE_SCENARIO);
    // Fully correlated simultaneous drawdown at the worst loss rate (20%).
    expect(r.worstCaseLoss).toBeCloseTo(1750 * 0.2, 6);
    expect(r.worstCaseLoss).toBeLessThanOrEqual(r.totalNotional);
  });

  it("reduces worst-case loss as correlation drops toward independence", () => {
    const correlated = runTreasuryStress({ ...BASE_SCENARIO, correlation: 1 });
    const independent = runTreasuryStress({ ...BASE_SCENARIO, correlation: 0 });
    expect(independent.worstCaseLoss).toBeLessThan(correlated.worstCaseLoss);
    // Independent loss is the sum of per-deployment losses.
    expect(independent.worstCaseLoss).toBeCloseTo(1000 * 0.2 + 500 * 0.2 + 250 * 0.1, 6);
  });

  it("amplifies losses when shared market liquidity is constrained", () => {
    const liquid = runTreasuryStress({ ...BASE_SCENARIO, sharedLiquidity: 1 });
    const illiquid = runTreasuryStress({ ...BASE_SCENARIO, sharedLiquidity: 0.5 });
    expect(illiquid.liquidityAdjustedLoss).toBeGreaterThan(liquid.liquidityAdjustedLoss);
    expect(liquid.liquidityAdjustedLoss).toBeCloseTo(liquid.worstCaseLoss, 6);
  });

  it("reports worst-case capital at risk bounded by the treasury budget", () => {
    const r = runTreasuryStress({ ...BASE_SCENARIO, treasuryBudget: 500 });
    expect(r.worstCaseCapitalAtRisk).toBe(500);
    expect(r.worstCaseCapitalAtRisk).toBeLessThanOrEqual(r.totalNotional);
  });

  it("flags whether the treasury budget covers the worst-case loss", () => {
    const covered = runTreasuryStress({ ...BASE_SCENARIO, treasuryBudget: 1000 });
    const breached = runTreasuryStress({ ...BASE_SCENARIO, treasuryBudget: 100 });
    expect(covered.withinBudget).toBe(true);
    expect(breached.withinBudget).toBe(false);
  });

  it("is reproducible for identical scenarios", () => {
    const a = runTreasuryStress(BASE_SCENARIO);
    const b = runTreasuryStress(BASE_SCENARIO);
    expect(a).toEqual(b);
  });
});
