/**
 * Pre-trade risk checks for cross-market arbitrage (#108). The planner
 * already sizes a plan inside the hard treasury caps; these checks add the
 * arbitrage-specific limits that exist because the two legs are not atomic.
 */
import { BPS } from "./fpmm.js";
import type { ArbPlan } from "./strategies/arbitrage.js";

export interface ArbRiskLimits {
  /** ARB_MAX_NOTIONAL: most one plan may spend across both legs. */
  maxNotional: bigint;
  /** ARB_MAX_UNHEDGED_STROOPS: the first leg alone, if the second never fills. */
  maxUnhedged: bigint;
  /** ARB_MARKET_HEADROOM_BPS: share of each market's max_market kept free for hedges. */
  marketHeadroomBps: bigint;
  /** ARB_MAX_OPEN_LEGS: arbitrage legs in flight at once, across plans. */
  maxOpenLegs: number;
  /** ARB_MAX_UNWIND_RETRIES: attempts to sell a stranded first leg. */
  maxUnwindRetries: number;
}

export interface TreasuryRiskState {
  maxTrade: bigint;
  maxMarket: bigint;
  /** What the treasury has already committed per market (cost basis). */
  marketSpent: Map<bigint, bigint>;
  dailyRemaining: bigint;
  /** Arbitrage legs currently submitted but not settled. */
  openLegs: number;
}

/** Every limit `plan` breaks; empty means it may execute. */
export function checkArbPlan(plan: ArbPlan, state: TreasuryRiskState, limits: ArbRiskLimits): string[] {
  const problems: string[] = [];
  if (limits.maxUnwindRetries < 1) problems.push("ARB_MAX_UNWIND_RETRIES must allow at least one unwind attempt");
  if (limits.marketHeadroomBps < 0n || limits.marketHeadroomBps >= BPS) problems.push("ARB_MARKET_HEADROOM_BPS must be 0-9999");
  // Usable share of max_market once the reserved headroom is set aside.
  const usable = (state.maxMarket * (BPS - limits.marketHeadroomBps)) / BPS;
  for (const leg of plan.legs) {
    if (leg.collateral > state.maxTrade) {
      problems.push(`leg on market ${leg.marketId}: ${leg.collateral} exceeds max_trade ${state.maxTrade}`);
    }
    const spent = state.marketSpent.get(leg.marketId) ?? 0n;
    if (spent + leg.collateral > usable) {
      problems.push(
        `leg on market ${leg.marketId}: exposure ${spent + leg.collateral} would exceed ${usable} (max_market ${state.maxMarket} less ARB_MARKET_HEADROOM_BPS=${limits.marketHeadroomBps})`,
      );
    }
  }
  if (plan.cost > state.dailyRemaining) problems.push(`cost ${plan.cost} exceeds the remaining daily budget ${state.dailyRemaining}`);
  if (plan.cost > limits.maxNotional) problems.push(`cost ${plan.cost} exceeds ARB_MAX_NOTIONAL=${limits.maxNotional}`);
  const firstLeg = plan.legs[0].collateral;
  if (firstLeg > limits.maxUnhedged) {
    problems.push(`first leg ${firstLeg} exceeds ARB_MAX_UNHEDGED_STROOPS=${limits.maxUnhedged}, the exposure left if the second leg fails`);
  }
  if (state.openLegs + plan.legs.length > limits.maxOpenLegs) {
    problems.push(`${state.openLegs} arbitrage legs already open; ${plan.legs.length} more would exceed ARB_MAX_OPEN_LEGS=${limits.maxOpenLegs}`);
  }
  return problems;
}

/**
 * Market eligibility and quality scoring (#57).
 *
 * Before an agent may trade a market, the market must pass a configurable
 * policy: horizon, liquidity, breaker status, resolution mode, and metadata.
 * Rejections carry human-readable reasons so they surface in traces, and the
 * decision path guarantees a rejected market never submits an order.
 */
export type ResolutionMode = "oracle" | "manual" | "optimistic" | "unknown";

export interface MarketEligibilityPolicy {
  /** Minimum seconds between now and the market's close time. */
  minHorizonSecs: bigint;
  /** Maximum seconds between now and the market's close time (0 disables). */
  maxHorizonSecs: bigint;
  /** Minimum collateral liquidity required to trade. */
  minLiquidity: bigint;
  /** Reject markets whose circuit breaker is tripped. */
  rejectOnBreaker: boolean;
  /** Resolution modes the agent is allowed to trade. */
  allowedResolutionModes: readonly ResolutionMode[];
  /** Require a non-empty title and description in the market metadata. */
  requireMetadata: boolean;
  /** Minimum quality score (0-10000 bps) a market must reach. */
  minQualityBps: bigint;
}

export interface MarketEligibilityInput {
  now: bigint;
  closeTime: bigint;
  liquidity: bigint;
  breakerTripped: boolean;
  resolutionMode: ResolutionMode;
  metadata: { title: string; description: string };
}

export interface MarketEligibilityResult {
  eligible: boolean;
  /** Human-readable rejection reasons; empty when eligible. */
  reasons: string[];
  /** Quality score in bps (0-10000), independent of eligibility. */
  qualityBps: bigint;
}

const QUALITY_BPS = 10_000n;

/**
 * Scores a market 0-10000 bps from liquidity depth and metadata completeness.
 * The score is advisory; eligibility is decided by the policy checks below.
 */
export function scoreMarketQuality(input: MarketEligibilityInput, policy: MarketEligibilityPolicy): bigint {
  let score = 0n;
  if (policy.minLiquidity > 0n) {
    const ratio = (input.liquidity * QUALITY_BPS) / policy.minLiquidity;
    score += ratio > QUALITY_BPS ? QUALITY_BPS : ratio;
  } else {
    score += QUALITY_BPS;
  }
  if (policy.requireMetadata) {
    const hasTitle = input.metadata.title.trim().length > 0;
    const hasDescription = input.metadata.description.trim().length > 0;
    if (hasTitle && hasDescription) score += QUALITY_BPS;
    else if (hasTitle || hasDescription) score += QUALITY_BPS / 2n;
  } else {
    score += QUALITY_BPS;
  }
  return score / 2n;
}

/**
 * Evaluates a market against the eligibility policy. Every failing check
 * contributes a reason; an empty `reasons` array means the market is eligible.
 */
export function evaluateMarketEligibility(
  input: MarketEligibilityInput,
  policy: MarketEligibilityPolicy,
): MarketEligibilityResult {
  const reasons: string[] = [];
  const horizon = input.closeTime - input.now;
  if (horizon < policy.minHorizonSecs) {
    reasons.push(`horizon ${horizon}s is below minimum ${policy.minHorizonSecs}s`);
  }
  if (policy.maxHorizonSecs > 0n && horizon > policy.maxHorizonSecs) {
    reasons.push(`horizon ${horizon}s exceeds maximum ${policy.maxHorizonSecs}s`);
  }
  if (input.liquidity < policy.minLiquidity) {
    reasons.push(`liquidity ${input.liquidity} is below minimum ${policy.minLiquidity}`);
  }
  if (policy.rejectOnBreaker && input.breakerTripped) {
    reasons.push("market circuit breaker is tripped");
  }
  if (!policy.allowedResolutionModes.includes(input.resolutionMode)) {
    reasons.push(`resolution mode ${input.resolutionMode} is not allowed`);
  }
  if (policy.requireMetadata) {
    if (input.metadata.title.trim().length === 0) reasons.push("market metadata is missing a title");
    if (input.metadata.description.trim().length === 0) reasons.push("market metadata is missing a description");
  }
  const qualityBps = scoreMarketQuality(input, policy);
  if (qualityBps < policy.minQualityBps) {
    reasons.push(`quality score ${qualityBps}bps is below minimum ${policy.minQualityBps}bps`);
  }
  return { eligible: reasons.length === 0, reasons, qualityBps };
}

export const ROLE_CREATE = 1 << 0;
export const ROLE_TRADE = 1 << 1;
const USAGE_BUCKET_SECONDS = 3_600n;
const USAGE_BUCKETS = 25;
const CREATION_BUCKETS = 24;
const BPS_SCALE = 10_000n;

export interface AgentRiskPolicy {
  active: boolean;
  roles: number;
  maxTrade: bigint;
  maxDaily: bigint;
}

/** Ring buffer layout mirrors the treasury's on-chain UsageWindow. */
export interface AgentUsageWindow {
  headHour: bigint;
  headIdx: number;
  amounts: readonly bigint[];
}

export interface CreationRateBucket {
  bucketStart: bigint;
  count: number;
}

export interface AgentRiskState {
  now: bigint;
  global: {
    maxTrade: bigint;
    maxMarket: bigint;
    maxDaily: bigint;
    maxNetExposure: bigint;
  };
  agent: AgentRiskPolicy;
  usage: {
    global: AgentUsageWindow;
    agent: AgentUsageWindow;
  };
  /** Treasury's current token balance before a possible yield withdrawal. */
  idleCapital: bigint;
  queueReservedCapital: bigint;
  /** Current cost-basis exposure across all markets. */
  netExposure: bigint;
  /** Lifetime/cap exposure for the target market. Missing markets use zero. */
  marketExposure: bigint;
  /** In/out counters for the target market used to calculate its net increase. */
  marketNetPosition: { collateralIn: bigint; collateralOut: bigint };
  /** Whether a yield venue is enabled and the amount that can safely be recalled. */
  yieldLiquidity: { enabled: boolean; available: bigint | null };
  price: {
    maxBuyPriceBps: bigint;
    minSellPriceBps: bigint;
    maxImpactBps: bigint;
    maxSlippageBps: bigint;
  };
}

export interface AgentBuyRiskAction {
  kind: "buy";
  amount: bigint;
  priceBeforeBps: bigint;
  priceAfterBps: bigint;
  quotedShares: bigint;
  minSharesOut: bigint;
}

export interface AgentCreateRiskAction {
  kind: "create";
  seedAmount: bigint;
  closeTime: bigint;
  category: "Crypto" | "Macro" | "Geopolitics" | "Sports" | "Culture" | "Other";
  initialYesBps: bigint;
  creationPolicy: {
    maxSeed: bigint;
    maxMarketsPerWindow: number;
    creationWindowSecs: bigint;
    minCloseHorizon: bigint;
    maxCloseHorizon: bigint;
    allowedCategories: number;
  };
  creationBuckets: readonly CreationRateBucket[];
}

export type AgentRiskAction = AgentBuyRiskAction | AgentCreateRiskAction;
export interface AgentRiskEvaluation {
  /** Checks which would reject the invocation, in contract execution order. */
  violations: string[];
  /** Checks dependent on external runtime outcomes or unavailable inputs. */
  unverifiable: string[];
}

const CATEGORY_BITS: Record<AgentCreateRiskAction["category"], number> = {
  Crypto: 1 << 0,
  Macro: 1 << 1,
  Geopolitics: 1 << 2,
  Sports: 1 << 3,
  Culture: 1 << 4,
  Other: 1 << 5,
};

function windowState(window: AgentUsageWindow, now: bigint): { total: bigint; headAmount: bigint } | undefined {
  if (
    window.amounts.length !== USAGE_BUCKETS ||
    !Number.isInteger(window.headIdx) ||
    window.headIdx < 0 ||
    window.headIdx >= USAGE_BUCKETS
  ) return undefined;
  const currentHour = now / USAGE_BUCKET_SECONDS;
  const steps = currentHour > window.headHour
    ? Number((currentHour - window.headHour) > BigInt(USAGE_BUCKETS)
      ? BigInt(USAGE_BUCKETS)
      : currentHour - window.headHour)
    : 0;
  const headIdx = (window.headIdx + steps) % USAGE_BUCKETS;
  let total = 0n;
  for (let slot = 0; slot < USAGE_BUCKETS; slot += 1) {
    const amount = window.amounts[slot];
    if (amount === undefined || amount < 0n) return undefined;
    const age = (window.headIdx - slot + USAGE_BUCKETS) % USAGE_BUCKETS;
    if (age + steps < USAGE_BUCKETS) total += amount;
  }
  return { total, headAmount: window.amounts[headIdx] ?? 0n };
}

function marketNetIncrease(position: AgentRiskState["marketNetPosition"], amount: bigint): bigint {
  const current = position.collateralIn > position.collateralOut
    ? position.collateralIn - position.collateralOut
    : 0n;
  const nextIn = position.collateralIn + amount;
  const next = nextIn > position.collateralOut ? nextIn - position.collateralOut : 0n;
  return next - current;
}

function creationWindowTotal(
  buckets: readonly CreationRateBucket[],
  now: bigint,
  windowSecs: bigint,
): number {
  return buckets.reduce(
    (sum, bucket) => bucket.bucketStart + windowSecs > now ? sum + bucket.count : sum,
    0,
  );
}

/**
 * Mirrors the treasury's create/buy gates. For buys and creates, capacity,
 * daily usage, and net exposure are evaluated after the nested market-core
 * action, matching Soroban's transaction rollback semantics.
 */
export function evaluateAgentRisk(action: AgentRiskAction, state: AgentRiskState): AgentRiskEvaluation {
  const violations: string[] = [];
  const unverifiable: string[] = [];
  const role = action.kind === "buy" ? ROLE_TRADE : ROLE_CREATE;
  const amount = action.kind === "buy" ? action.amount : action.seedAmount;
  if (!state.agent.active || (state.agent.roles & role) === 0) {
    violations.push(`agent is inactive or missing the ${action.kind === "buy" ? "trade" : "create"} role`);
  }
  if (amount <= 0n) violations.push("amount must be positive");
  if (amount > state.agent.maxTrade) {
    violations.push(`amount ${amount} exceeds agent max_trade ${state.agent.maxTrade}`);
  }
  if (amount > state.global.maxTrade) {
    violations.push(`amount ${amount} exceeds global max_trade ${state.global.maxTrade}`);
  }
  const agentUsage = windowState(state.usage.agent, state.now);
  const globalUsage = windowState(state.usage.global, state.now);
  if (!agentUsage || !globalUsage) {
    unverifiable.push("usage window is malformed");
  } else {
    if (agentUsage.total + amount > state.agent.maxDaily) {
      violations.push(`amount ${amount} would exceed agent max_daily ${state.agent.maxDaily} (used ${agentUsage.total})`);
    }
    if (globalUsage.total + amount > state.global.maxDaily) {
      violations.push(`amount ${amount} would exceed global max_daily ${state.global.maxDaily} (used ${globalUsage.total})`);
    }
  }
  const netIncrease = marketNetIncrease(state.marketNetPosition, amount);
  if (state.marketExposure + netIncrease > state.global.maxMarket) {
    violations.push(`market exposure ${state.marketExposure + netIncrease} would exceed max_market ${state.global.maxMarket}`);
  }
  if (state.netExposure + netIncrease > state.global.maxNetExposure) {
    violations.push(`net exposure ${state.netExposure + netIncrease} would exceed max_net_exposure ${state.global.maxNetExposure}`);
  }
  const available = state.idleCapital + (state.yieldLiquidity.enabled ? (state.yieldLiquidity.available ?? 0n) : 0n);
  if (amount > available - state.queueReservedCapital) {
    violations.push(`amount ${amount} exceeds available capital ${available - state.queueReservedCapital}`);
  }
  if (action.kind === "buy") {
    if (action.priceBeforeBps > state.price.maxBuyPriceBps) {
      violations.push(`price ${action.priceBeforeBps}bps exceeds max_buy_price ${state.price.maxBuyPriceBps}bps`);
    }
    const impact = action.priceAfterBps > action.priceBeforeBps ? action.priceAfterBps - action.priceBeforeBps : 0n;
    if (impact > state.price.maxImpactBps) {
      violations.push(`price impact ${impact}bps exceeds max_impact ${state.price.maxImpactBps}bps`);
    }
    if (action.minSharesOut < action.quotedShares) {
      const slippage = action.quotedShares > 0n
        ? ((action.quotedShares - action.minSharesOut) * BPS_SCALE) / action.quotedShares
        : 0n;
      if (slippage > state.price.maxSlippageBps) {
        violations.push(`slippage ${slippage}bps exceeds max_slippage ${state.price.maxSlippageBps}bps`);
      }
    }
  } else {
    const policy = action.creationPolicy;
    if (action.seedAmount > policy.maxSeed) {
      violations.push(`seed ${action.seedAmount} exceeds max_seed ${policy.maxSeed}`);
    }
    const horizon = action.closeTime - state.now;
    if (horizon < policy.minCloseHorizon) {
      violations.push(`close horizon ${horizon}s is below minimum ${policy.minCloseHorizon}s`);
    }
    if (horizon > policy.maxCloseHorizon) {
      violations.push(`close horizon ${horizon}s exceeds maximum ${policy.maxCloseHorizon}s`);
    }
    if ((policy.allowedCategories & CATEGORY_BITS[action.category]) === 0) {
      violations.push(`category ${action.category} is not allowed`);
    }
    const created = creationWindowTotal(action.creationBuckets, state.now, policy.creationWindowSecs);
    if (created + 1 > policy.maxMarketsPerWindow) {
      violations.push(`${created} markets already created in window; limit is ${policy.maxMarketsPerWindow}`);
    }
  }
  return { violations, unverifiable };
}
