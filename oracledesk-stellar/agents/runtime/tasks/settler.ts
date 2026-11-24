/**
 * Permissionless settlement monitor: discovers treasury markets whose
 * on-chain status is Resolved or Void, calls `settle_market` for each,
 * and reconciles the resulting balance change in the operator log.
 *
 * # Operator-visible behaviour
 *
 * On every tick the monitor calls `discoverMarkets` (operator-supplied) to
 * obtain a list of market IDs to check, reads each market's status from
 * market-core (`getMarket`), and skips markets that are still Open. For
 * every market whose status is Resolved or Void it calls `settle_market`.
 *
 * The default `discoverMarkets` implementation paginates the treasury's
 * `open_exposure_page` view — available in treasury WASM builds that expose
 * it. For older deployments, operators can supply a custom implementation
 * that falls back to iterating `market_count` / `getMarket` range reads.
 *
 * Log events:
 * - `SETTLER_ELIGIBLE` — a final market was found and a settlement call was
 *   queued.
 * - `SETTLER_SETTLED` — the settlement call landed; `redeemed` and
 *   `lpClaimed` show the collateral returned to the treasury.
 * - `SETTLER_NOOP` — the contract returned `already_settled: true` (another
 *   caller, or a previous tick, already settled it). This is a no-op.
 * - `SETTLER_SKIP_NOT_FINAL` — the contract rejected the call with
 *   `MarketNotFinal`. Treated as a transient mismatch (the resolution state
 *   propagates asynchronously); the market is retried next tick.
 * - `SETTLER_FAILED` — a transient or unknown error; the market is retried
 *   next tick. The runtime's circuit breaker counts repeated failures across
 *   all tasks.
 *
 * # Restart safety
 *
 * `settle_market` is idempotent on-chain: a duplicate delivery returns
 * `already_settled: true` and costs one fee but changes nothing else. The
 * monitor does not keep its own journal for settlements; on restart it re-
 * discovers and re-attempts every unsettled final market, which the contract
 * handles safely.
 *
 * # Partial progress
 *
 * When one market's settlement fails the monitor logs `SETTLER_FAILED` and
 * continues to the next market, so a single stuck market does not block the
 * rest. The runtime's circuit breaker still opens after
 * `maxConsecutiveFailures` failures (across all tasks), so runaway retries
 * are bounded at the process level.
 */
import type { StellarAdapter } from "../../stellar/adapter.js";
import type { Task, TaskContext } from "../runtime.js";

export interface SettlerDeps {
  adapter: Pick<StellarAdapter, "mode" | "getMarket" | "settleMarket">;
  /**
   * Returns all market IDs that should be checked for settlement on this
   * tick. The default implementation paginates `openExposurePage` on
   * `adapter`; override to use `market_count` range reads or any other
   * discovery mechanism.
   */
  discoverMarkets?: () => Promise<bigint[]>;
  /**
   * Maximum markets to settle per tick. Defaults to Infinity (settle all
   * eligible markets found). Set to a small number if you want bounded
   * per-tick fee spend.
   */
  maxPerTick?: number;
}

export interface SettlementSummary {
  settled: number;
  noops: number;
  failed: number;
  totalRedeemed: bigint;
  totalLpClaimed: bigint;
}

/**
 * Default discovery: paginate `openExposurePage` to exhaustion. Requires
 * the adapter to expose `openExposurePage` (present on current treasury
 * builds). Operators targeting older deployments should supply their own
 * `discoverMarkets` callback.
 */
export async function discoverViaExposurePage(
  adapter: Pick<StellarAdapter, "openExposurePage">,
  pageSize = 20,
): Promise<bigint[]> {
  const ids: bigint[] = [];
  let cursor = 0n;
  do {
    const { marketIds, nextCursor } = await adapter.openExposurePage(cursor, pageSize);
    ids.push(...marketIds);
    if (nextCursor === 0n) break;
    cursor = nextCursor;
  } while (true);
  return ids;
}

/**
 * Error strings the contract returns that are safe to treat as expected
 * no-ops: the market is not yet final. Retrying next tick is correct.
 */
const NOT_FINAL_PATTERNS = [/MarketNotFinal/i, /market_not_final/i, /NotFinal/i, /not final/i];

function isNotFinal(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return NOT_FINAL_PATTERNS.some((p) => p.test(msg));
}

export async function settlerTick(deps: SettlerDeps, ctx: TaskContext): Promise<SettlementSummary> {
  const maxPerTick = deps.maxPerTick ?? Infinity;
  const summary: SettlementSummary = { settled: 0, noops: 0, failed: 0, totalRedeemed: 0n, totalLpClaimed: 0n };

  if (ctx.signal.aborted) return summary;

  const marketIds = await deps.discoverMarkets!();
  let processedThisTick = 0;

  for (const marketId of marketIds) {
    if (ctx.signal.aborted) break;
    if (processedThisTick >= maxPerTick) break;

    // Read the market's current status to filter still-open markets cheaply
    // before spending a fee on a settle_market call that would fail.
    const mkt = await deps.adapter.getMarket(marketId);
    if (!mkt) {
      ctx.log.warn("SETTLER_MARKET_MISSING", { marketId: String(marketId) });
      continue;
    }
    if (mkt.status === "Open") continue;

    ctx.log.info("SETTLER_ELIGIBLE", { marketId: String(marketId), status: mkt.status });

    try {
      const result = await ctx.submit(
        () => deps.adapter.settleMarket(marketId),
        `settle:${marketId}`,
      );

      if (result.dryRun) {
        ctx.log.info("SETTLER_DRY_RUN", { marketId: String(marketId) });
        processedThisTick++;
        continue;
      }

      if (result.value.alreadySettled) {
        ctx.log.info("SETTLER_NOOP", { marketId: String(marketId) });
        summary.noops++;
      } else {
        ctx.log.info("SETTLER_SETTLED", {
          marketId: String(marketId),
          redeemed: String(result.value.redeemed),
          lpClaimed: String(result.value.lpClaimed),
        });
        summary.settled++;
        summary.totalRedeemed += result.value.redeemed;
        summary.totalLpClaimed += result.value.lpClaimed;
      }
      processedThisTick++;
    } catch (err) {
      if (isNotFinal(err)) {
        ctx.log.info("SETTLER_SKIP_NOT_FINAL", { marketId: String(marketId), err });
      } else {
        ctx.log.warn("SETTLER_FAILED", { marketId: String(marketId), err });
        summary.failed++;
        // Continue to the next market rather than stopping entirely.
      }
    }
  }

  if (summary.settled > 0 || summary.noops > 0) {
    ctx.log.info("SETTLER_TICK_SUMMARY", {
      settled: summary.settled,
      noops: summary.noops,
      failed: summary.failed,
      totalRedeemed: String(summary.totalRedeemed),
      totalLpClaimed: String(summary.totalLpClaimed),
    });
  }

  return summary;
}

/**
 * Builds a settler task with batteries included. If `deps.discoverMarkets`
 * is not supplied, it defaults to paginating the adapter's
 * `openExposurePage`. Pass your own `discoverMarkets` to target a
 * deployment whose treasury WASM predates `open_exposure_page`.
 */
export function settlerTask(
  deps: Omit<SettlerDeps, "discoverMarkets"> & {
    discoverMarkets?: () => Promise<bigint[]>;
    adapter: Pick<StellarAdapter, "mode" | "getMarket" | "settleMarket"> &
      Partial<Pick<StellarAdapter, "openExposurePage">>;
    pageSize?: number;
  },
  opts: { intervalMs: number; jitterMs?: number },
): Task {
  const discover =
    deps.discoverMarkets ??
    (() => discoverViaExposurePage(deps.adapter as Parameters<typeof discoverViaExposurePage>[0], deps.pageSize));
  const resolved: SettlerDeps = { ...deps, discoverMarkets: discover };
  return {
    name: "settler",
    mode: deps.adapter.mode,
    ...opts,
    run: (ctx) => settlerTick(resolved, ctx).then(() => undefined),
  };
}
