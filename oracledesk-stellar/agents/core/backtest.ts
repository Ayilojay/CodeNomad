/**
 * Walk-forward backtesting for trading strategies.
 *
 * Design notes (operational / compatibility assumptions):
 * - Observations are strictly time-ordered. Each step only sees data up to and
 *   including the current observation, so there is no look-ahead bias.
 * - Fees are charged per unit of traded notional (round-trip on turnover).
 * - Position size is capped by `maxPosition` (fraction of equity) and by
 *   `maxTurnover` per step; caps are applied before fees.
 * - Missing data policy is explicit: "skip" (hold previous position, no trade),
 *   "hold" (same as skip but still marks equity), or "flat" (force position to 0).
 * - A benchmark (buy-and-hold over the same observations) is reported alongside
 *   strategy returns, plus drawdown and calibration metrics.
 *
 * The module is pure and deterministic: given the same observations and config
 * it always produces identical metrics, which the tests rely on.
 */

export interface Observation {
  /** ISO timestamp or monotonically increasing index label. */
  timestamp: string;
  /** Price at this observation. `null` marks a missing-data gap. */
  price: number | null;
}

export type MissingDataPolicy = "skip" | "hold" | "flat";

export interface BacktestConfig {
  /** Per-unit traded notional fee, e.g. 0.001 = 10 bps. */
  feeRate: number;
  /** Max absolute position as a fraction of equity (0..1). */
  maxPosition: number;
  /** Max absolute turnover per step as a fraction of equity (0..1). */
  maxTurnover: number;
  /** How to treat observations with a missing price. */
  missingDataPolicy: MissingDataPolicy;
  /** Starting equity. Defaults to 1. */
  initialEquity?: number;
}

/** Strategy maps the visible history (up to and including current) to a target position in [-1, 1]. */
export type Strategy = (history: ReadonlyArray<Observation>) => number;

export interface BacktestStep {
  timestamp: string;
  price: number | null;
  position: number;
  turnover: number;
  fee: number;
  equity: number;
  benchmarkEquity: number;
  missing: boolean;
}

export interface BacktestMetrics {
  totalReturn: number;
  benchmarkReturn: number;
  excessReturn: number;
  maxDrawdown: number;
  benchmarkMaxDrawdown: number;
  /** Fraction of steps where the strategy's direction matched the next move. */
  calibration: number;
  steps: number;
  trades: number;
  totalFees: number;
}

export interface BacktestResult {
  metrics: BacktestMetrics;
  equityCurve: BacktestStep[];
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(max, Math.max(min, value));
}

function maxDrawdown(curve: number[]): number {
  let peak = curve.length > 0 ? curve[0] : 0;
  let worst = 0;
  for (const value of curve) {
    if (value > peak) peak = value;
    if (peak > 0) {
      const dd = (peak - value) / peak;
      if (dd > worst) worst = dd;
    }
  }
  return worst;
}

/**
 * Run a walk-forward backtest. Each step's strategy decision is made using only
 * `observations.slice(0, i + 1)` — never future data.
 */
export function runWalkForwardBacktest(
  observations: ReadonlyArray<Observation>,
  strategy: Strategy,
  config: BacktestConfig,
): BacktestResult {
  const initialEquity = config.initialEquity ?? 1;
  const feeRate = Math.max(0, config.feeRate);
  const maxPosition = clamp(config.maxPosition, 0, 1);
  const maxTurnover = clamp(config.maxTurnover, 0, 1);

  let equity = initialEquity;
  let benchmarkEquity = initialEquity;
  let position = 0;
  let totalFees = 0;
  let trades = 0;
  let calibrationHits = 0;
  let calibrationTotal = 0;

  const equityCurve: BacktestStep[] = [];
  const equityValues: number[] = [initialEquity];
  const benchmarkValues: number[] = [initialEquity];

  let lastPrice: number | null = null;
  let benchmarkBase: number | null = null;

  for (let i = 0; i < observations.length; i += 1) {
    const obs = observations[i];
    const missing = obs.price === null || obs.price === undefined || Number.isNaN(obs.price);

    if (missing) {
      if (config.missingDataPolicy === "flat") {
        const turnover = Math.abs(position);
        const fee = turnover * equity * feeRate;
        equity -= fee;
        totalFees += fee;
        if (turnover > 0) trades += 1;
        position = 0;
      }
      // "skip" and "hold" both keep the current position untouched.
      equityCurve.push({
        timestamp: obs.timestamp,
        price: null,
        position,
        turnover: 0,
        fee: 0,
        equity,
        benchmarkEquity,
        missing: true,
      });
      equityValues.push(equity);
      benchmarkValues.push(benchmarkEquity);
      continue;
    }

    const price = obs.price as number;

    // Benchmark: buy-and-hold from the first valid price.
    if (benchmarkBase === null) {
      benchmarkBase = price;
    } else if (benchmarkBase > 0) {
      benchmarkEquity = initialEquity * (price / benchmarkBase);
    }

    // Strategy sees only history up to and including this observation.
    const history = observations.slice(0, i + 1);
    const rawTarget = strategy(history);
    const target = clamp(rawTarget, -maxPosition, maxPosition);

    // Apply turnover cap, then compute fee on the traded notional.
    let desiredTurnover = target - position;
    desiredTurnover = clamp(desiredTurnover, -maxTurnover, maxTurnover);
    const newPosition = clamp(position + desiredTurnover, -maxPosition, maxPosition);
    const turnover = Math.abs(newPosition - position);
    const fee = turnover * equity * feeRate;

    // Mark-to-market PnL from the previous valid price using the held position.
    if (lastPrice !== null && lastPrice > 0) {
      const priceReturn = price / lastPrice - 1;
      equity += equity * position * priceReturn;
    }

    equity -= fee;
    totalFees += fee;
    if (turnover > 0) trades += 1;

    // Calibration: did the held position agree with the next observed move?
    // Evaluated lazily on the following iteration to avoid look-ahead.
    if (i > 0 && lastPrice !== null && lastPrice > 0 && position !== 0) {
      const move = price - lastPrice;
      if (move !== 0) {
        calibrationTotal += 1;
        if (Math.sign(move) === Math.sign(position)) calibrationHits += 1;
      }
    }

    position = newPosition;
    lastPrice = price;

    equityCurve.push({
      timestamp: obs.timestamp,
      price,
      position,
      turnover,
      fee,
      equity,
      benchmarkEquity,
      missing: false,
    });
    equityValues.push(equity);
    benchmarkValues.push(benchmarkEquity);
  }

  const finalEquity = equityValues[equityValues.length - 1];
  const finalBenchmark = benchmarkValues[benchmarkValues.length - 1];

  const metrics: BacktestMetrics = {
    totalReturn: finalEquity / initialEquity - 1,
    benchmarkReturn: finalBenchmark / initialEquity - 1,
    excessReturn: finalEquity / initialEquity - finalBenchmark / initialEquity,
    maxDrawdown: maxDrawdown(equityValues),
    benchmarkMaxDrawdown: maxDrawdown(benchmarkValues),
    calibration: calibrationTotal > 0 ? calibrationHits / calibrationTotal : 0,
    steps: observations.length,
    trades,
    totalFees,
  };

  return { metrics, equityCurve };
}
