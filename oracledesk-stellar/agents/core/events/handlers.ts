/**
 * Example event handlers (#105). Each is idempotent: handling the same event
 * twice re-reads chain state and reaches the same result, because events are
 * delivered at least once. None trusts the event alone; each re-reads the
 * chain before acting.
 */
import type { OracleDeskEvent } from "./decode.js";
import type { EventHandler } from "./dispatch.js";

type Of<K extends OracleDeskEvent["kind"]> = Extract<OracleDeskEvent, { kind: K }>;

export interface MarketSnapshot {
  marketId: bigint;
  open: boolean;
  yesBps: number;
}

/**
 * After a trade of at least `threshold` stroops, re-reads the market and, if
 * it is still open, queues it for the trader to re-evaluate.
 */
export function tradeReevaluate(deps: {
  threshold: bigint;
  readMarket: (marketId: bigint) => Promise<MarketSnapshot | undefined>;
  enqueue: (marketId: bigint) => void;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}): EventHandler {
  return {
    name: "TradeReevaluate",
    kinds: ["Trade"],
    async handle(e) {
      const t = e as Of<"Trade">;
      if (t.collateral < deps.threshold) return;
      const market = await deps.readMarket(t.marketId);
      if (!market?.open) return;
      deps.log?.("EVENT_REEVALUATE", { market: t.marketId, collateral: t.collateral, yesBps: market.yesBps });
      deps.enqueue(t.marketId);
    },
  };
}

/** Unix seconds by which a dispute must be raised, from ledger timestamps. */
export function disputeDeadline(proposedAt: bigint, disputeWindowSecs: bigint): bigint {
  return proposedAt + disputeWindowSecs;
}

export interface ProposalAlert {
  marketId: bigint;
  outcome: string;
  exposure: bigint;
  proposedAt: bigint;
  /** Unix seconds; derived from the proposal's ledger timestamp. */
  disputeDeadline: bigint;
  /** Seconds left at the ledger the event closed in. */
  secondsLeft: bigint;
}

/**
 * Alerts when a resolution is proposed for a market the treasury holds a
 * position in. Proposals can be cancelled without an event, so it checks the
 * resolver's current state first and alerts only while the proposal stands.
 */
export function proposalWatch(deps: {
  exposure: (marketId: bigint) => Promise<bigint>;
  /** The resolver's state tag for the market (e.g. "SignersPending"). */
  proposalState: (marketId: bigint) => Promise<string>;
  disputeWindowSecs: (marketId: bigint) => Promise<bigint>;
  alert: (a: ProposalAlert) => void | Promise<void>;
}): EventHandler {
  return {
    name: "ProposalWatch",
    kinds: ["ResolutionProposed"],
    async handle(e) {
      const p = e as Of<"ResolutionProposed">;
      const exposure = await deps.exposure(p.marketId);
      if (exposure <= 0n) return;
      if ((await deps.proposalState(p.marketId)) !== "SignersPending") return;
      const deadline = disputeDeadline(p.proposedAt, await deps.disputeWindowSecs(p.marketId));
      await deps.alert({
        marketId: p.marketId,
        outcome: p.outcome,
        exposure,
        proposedAt: p.proposedAt,
        disputeDeadline: deadline,
        secondsLeft: deadline - BigInt(p.closedAt),
      });
    },
  };
}

/** Marks a market final once any resolution path reports it. */
export function finalityTracker(deps: { markFinal: (marketId: bigint, via: string) => void | Promise<void> }): EventHandler {
  return {
    name: "FinalityTracker",
    kinds: ["MarketResolved", "ResolutionFinalized", "PriceResolution"],
    async handle(e) {
      await deps.markFinal((e as Of<"MarketResolved" | "ResolutionFinalized" | "PriceResolution">).marketId, e.kind);
    },
  };
}

/**
 * The retention-gap handler: events were missed, so reload every market's
 * state from the chain instead of trusting incremental updates.
 */
export function resync(deps: { reloadAll: () => Promise<void>; log?: (event: string, fields?: Record<string, unknown>) => void }) {
  return async (reason: string): Promise<void> => {
    deps.log?.("EVENTS_RESYNC", { reason });
    await deps.reloadAll();
  };
}

/**
 * Rebuildable read models (#97).
 *
 * Market lifecycle, trades and treasury activity views are derived purely from
 * canonical events. Every derived record carries the `sourceEventId` of the
 * event that produced it, so applying the same event twice is a no-op and a
 * full rebuild (replaying every event from scratch) yields exactly the same
 * records as incremental updates. Nothing here trusts an event in isolation to
 * fabricate a success state: records are only emitted for events that carry the
 * fields the view needs, and unknown kinds are ignored.
 */
export interface MarketLifecycleRecord {
  marketId: bigint;
  /** Latest lifecycle stage observed for the market. */
  stage: "open" | "resolution_proposed" | "resolved" | "finalized";
  outcome?: string;
  /** Ledger close time of the event that set this stage. */
  updatedAt: bigint;
  sourceEventId: string;
}

export interface TradeRecord {
  marketId: bigint;
  trader: string;
  side: string;
  collateral: bigint;
  /** Ledger close time of the trade. */
  at: bigint;
  sourceEventId: string;
}

export interface TreasuryActivityRecord {
  marketId: bigint;
  /** Activity kind, e.g. "trade", "resolution_proposed", "resolved". */
  activity: string;
  amount: bigint;
  at: bigint;
  sourceEventId: string;
}

/**
 * Capital-flow accounting records (#36).
 *
 * A stable, auditable trail linking deposits, withdrawals, trading, fees,
 * Blend allocation and realized PnL to the current capital views. Each record
 * carries a unique `operationId` (derived from the source event) and the
 * ledger timestamp at which the flow was observed, so an off-chain reconciler
 * can replay the trail and prove the indexed total matches contract balances.
 */
export type CapitalFlowKind =
  | "deposit"
  | "withdrawal"
  | "trade"
  | "fee"
  | "blend_allocation"
  | "realized_pnl";

export interface CapitalFlowRecord {
  /** Unique, stable operation identifier for this flow. */
  operationId: string;
  kind: CapitalFlowKind;
  /** Signed amount in stroops: positive increases capital, negative decreases. */
  amount: bigint;
  /** Ledger close time (Unix seconds) at which the flow was observed. */
  ledgerTimestamp: bigint;
  /** Source event identity, for dedupe and replay. */
  sourceEventId: string;
}

export interface ReadModels {
  lifecycle: Map<bigint, MarketLifecycleRecord>;
  trades: TradeRecord[];
  treasury: TreasuryActivityRecord[];
  /** Capital-flow accounting trail (#36). */
  capitalFlows: CapitalFlowRecord[];
}

export function emptyReadModels(): ReadModels {
  return { lifecycle: new Map(), trades: [], treasury: [], capitalFlows: [] };
}

/** Stable identity for an event, used to dedupe incremental updates. */
export function sourceEventId(e: OracleDeskEvent): string {
  const anyE = e as unknown as { txHash?: string; eventIndex?: number; ledger?: number };
  if (anyE.txHash !== undefined && anyE.eventIndex !== undefined) {
    return `${anyE.txHash}:${anyE.eventIndex}`;
  }
  return `${e.kind}:${String(anyE.ledger ?? "")}:${JSON.stringify(e)}`;
}

/**
 * Maps a canonical event to a capital-flow record, or undefined when the event
 * does not represent a capital flow. Amounts are signed stroops.
 */
export function capitalFlowFor(e: OracleDeskEvent): CapitalFlowRecord | undefined {
  const id = sourceEventId(e);
  const anyE = e as unknown as { closedAt?: bigint; amount?: bigint; collateral?: bigint; fee?: bigint };
  const at = anyE.closedAt ?? 0n;
  const make = (kind: CapitalFlowKind, amount: bigint): CapitalFlowRecord => ({
    operationId: id,
    kind,
    amount,
    ledgerTimestamp: at,
    sourceEventId: id,
  });
  switch (e.kind) {
    case "Deposit":
      return make("deposit", anyE.amount ?? 0n);
    case "Withdrawal":
      return make("withdrawal", -(anyE.amount ?? 0n));
    case "Trade":
      return make("trade", -(anyE.collateral ?? 0n));
    case "FeeCharged":
      return make("fee", -(anyE.fee ?? anyE.amount ?? 0n));
    case "BlendAllocation":
      return make("blend_allocation", -(anyE.amount ?? 0n));
    case "RealizedPnl":
      return make("realized_pnl", anyE.amount ?? 0n);
    default:
      return undefined;
  }
}

/**
 * Off-chain reconciler (#36): sums the indexed capital-flow trail and compares
 * it against the contract's reported balance. Returns a proof object so
 * operators can see both sides of the check.
 */
export interface ReconciliationResult {
  indexedTotal: bigint;
  contractBalance: bigint;
  /** True when the indexed total matches the contract balance. */
  reconciled: boolean;
  /** Signed difference (indexedTotal - contractBalance). */
  difference: bigint;
}

export function reconcileCapital(
  flows: readonly CapitalFlowRecord[],
  contractBalance: bigint,
): ReconciliationResult {
  const indexedTotal = flows.reduce((sum, f) => sum + f.amount, 0n);
  const difference = indexedTotal - contractBalance;
  return { indexedTotal, contractBalance, reconciled: difference === 0n, difference };
}

const STAGE_RANK: Record<MarketLifecycleRecord["stage"], number> = {
  open: 0,
  resolution_proposed: 1,
  resolved: 2,
  finalized: 3,
};

/**
 * Applies a single canonical event to the read models. Idempotent: re-applying
 * an event whose `sourceEventId` is already recorded leaves the models
 * unchanged. Returns true when the models changed.
 */
export function applyEvent(models: ReadModels, e: OracleDeskEvent): boolean {
  const id = sourceEventId(e);
  if (models.trades.some((t) => t.sourceEventId === id)) return false;
  if (models.treasury.some((t) => t.sourceEventId === id)) return false;
  if (models.capitalFlows.some((f) => f.sourceEventId === id)) return false;
  if (models.lifecycle.get((e as { marketId?: bigint }).marketId ?? -1n)?.sourceEventId === id) return false;

  const flow = capitalFlowFor(e);
  if (flow) models.capitalFlows.push(flow);

  switch (e.kind) {
    case "MarketOpened": {
      const m = e as Of<"MarketOpened">;
      return setStage(models, m.marketId, "open", undefined, m.closedAt, id);
    }
    case "ResolutionProposed": {
      const m = e as Of<"ResolutionProposed">;
      const changed = setStage(models, m.marketId, "resolution_proposed", m.outcome, m.closedAt, id);
      models.treasury.push({ marketId: m.marketId, activity: "resolution_proposed", amount: 0n, at: m.closedAt, sourceEventId: id });
      return changed || true;
    }
    case "MarketResolved": {
      const m = e as Of<"MarketResolved">;
      const changed = setStage(models, m.marketId, "resolved", m.outcome, m.closedAt, id);
      models.treasury.push({ marketId: m.marketId, activity: "resolved", amount: 0n, at: m.closedAt, sourceEventId: id });
      return changed || true;
    }
    case "ResolutionFinalized": {
      const m = e as Of<"ResolutionFinalized">;
      return setStage(models, m.marketId, "finalized", undefined, m.closedAt, id);
    }
    case "PriceResolution": {
      const m = e as Of<"PriceResolution">;
      return setStage(models, m.marketId, "resolved", undefined, m.closedAt, id);
    }
    case "Trade": {
      const m = e as Of<"Trade">;
      models.trades.push({
        marketId: m.marketId,
        trader: m.trader,
        side: m.side,
        collateral: m.collateral,
        at: m.closedAt,
        sourceEventId: id,
      });
      models.treasury.push({ marketId: m.marketId, activity: "trade", amount: m.collateral, at: m.closedAt, sourceEventId: id });
      return true;
    }
    default:
      return flow !== undefined;
  }
}

function setStage(
  models: ReadModels,
  marketId: bigint,
  stage: MarketLifecycleRecord["stage"],
  outcome: string | undefined,
  at: bigint,
  sourceEventId: string,
): boolean {
  const prev = models.lifecycle.get(marketId);
  if (prev && STAGE_RANK[prev.stage] > STAGE_RANK[stage]) return false;
  models.lifecycle.set(marketId, { marketId, stage, outcome, updatedAt: at, sourceEventId });
  return true;
}
