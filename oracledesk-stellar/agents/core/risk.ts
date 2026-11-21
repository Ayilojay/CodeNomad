// Risk controls for the OracleDesk agents.
//
// This module centralises the on-chain risk primitives (position caps, fee
// accounting) and the walk-forward backtest evaluator used to validate trading
// strategies against time-ordered observations.
//
// Backtest guarantees (see issue #61):
// - No look-ahead bias: each step only sees observations up to and including
//   the current index. The benchmark and strategy both consume the same slice.
// - Fees and position/size caps are applied on every simulated trade.
// - Missing observations follow an explicit, configurable policy.
// - Drawdown and calibration are reported alongside returns.

export interface Observation {
  /** Monotonically increasing timestamp (ms). */
  timestamp: number;
  /** Observed price; `null` marks a missing data point. */
  price: number | null;
}

export type MissingDataPolicy = "skip" | "hold" | "flat";

export interface BacktestConfig {
  /** Fraction of notional charged per trade (e.g. 0.001 = 10 bps). */
  feeRate: number;
  /** Maximum fraction of equity deployable in a single position (0..1]. */
  maxPositionFraction: number;
  /** Policy applied when an observation is missing. */
  missingDataPolicy: MissingDataPolicy;
}

export interface BacktestMetrics {
  /** Cumulative strategy return as a fraction (0.1 = +10%). */
  totalReturn: number;
  /** Cumulative benchmark (buy-and-hold) return as a fraction. */
  benchmarkReturn: number;
  /** Strategy return minus benchmark return. */
  excessReturn: number;
  /** Maximum peak-to-trough drawdown as a positive fraction. */
  maxDrawdown: number;
  /** Fraction of directional calls that matched the next move (0..1). */
  calibration: number;
  /** Number of steps actually evaluated. */
  steps: number;
}

/**
 * A strategy maps the observations available so far to a target position in
 * [-1, 1] (short..long). It must only read from the provided slice.
 */
export type Strategy = (history: ReadonlyArray<Observation>) => number;

export const DEFAULT_BACKTEST_CONFIG: BacktestConfig = {
  feeRate: 0.001,
  maxPositionFraction: 1,
  missingDataPolicy: "hold",
};

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Walk-forward backtest over time-ordered observations.
 *
 * At each step `i` the strategy receives `observations.slice(0, i + 1)` and may
 * only act on that history, so future prices never leak into the decision.
 * Returns are realised on the following observation, which is the first point
 * at which the position could actually be held.
 */
export function runWalkForwardBacktest(
  observations: ReadonlyArray<Observation>,
  strategy: Strategy,
  config: BacktestConfig = DEFAULT_BACKTEST_CONFIG,
): BacktestMetrics {
  const feeRate = clamp(config.feeRate, 0, 1);
  const maxPosition = clamp(config.maxPositionFraction, 0, 1);

  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  let benchmarkEquity = 1;
  let steps = 0;
  let correctCalls = 0;
  let directionalCalls = 0;
  let previousPosition = 0;

  for (let i = 0; i < observations.length - 1; i += 1) {
    const current = observations[i];
    const next = observations[i + 1];

    // Missing-data policy: decide how to treat a gap at the current point.
    if (current.price === null) {
      if (config.missingDataPolicy === "skip") {
        continue;
      }
      if (config.missingDataPolicy === "flat") {
        previousPosition = 0;
        continue;
      }
      // "hold": keep the previous position, but we cannot price a move.
      continue;
    }

    // A missing next price means we cannot realise a return this step.
    if (next.price === null) {
      continue;
    }

    const history = observations.slice(0, i + 1);
    const rawTarget = strategy(history);
    const target = clamp(rawTarget, -1, 1) * maxPosition;

    // Fees are charged on the traded delta of the position.
    const traded = Math.abs(target - previousPosition);
    equity -= equity * traded * feeRate;

    const priceReturn = (next.price - current.price) / current.price;
    equity += equity * target * priceReturn;

    // Benchmark: fully-invested buy-and-hold, no fees.
    benchmarkEquity += benchmarkEquity * priceReturn;

    if (target !== 0) {
      directionalCalls += 1;
      if (Math.sign(target) === Math.sign(priceReturn)) {
        correctCalls += 1;
      }
    }

    peak = Math.max(peak, equity);
    const drawdown = peak > 0 ? (peak - equity) / peak : 0;
    maxDrawdown = Math.max(maxDrawdown, drawdown);

    previousPosition = target;
    steps += 1;
  }

  const totalReturn = equity - 1;
  const benchmarkReturn = benchmarkEquity - 1;

  return {
    totalReturn,
    benchmarkReturn,
    excessReturn: totalReturn - benchmarkReturn,
    maxDrawdown,
    calibration: directionalCalls === 0 ? 0 : correctCalls / directionalCalls,
    steps,
  };
}
