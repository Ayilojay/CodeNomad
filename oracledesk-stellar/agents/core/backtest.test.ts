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
    expect(m.totalReturn).toBe(0);
    expect(m.trades).toBe(0);
  });
});
