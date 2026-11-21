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

/**
 * Correlated outcome exposure (#59).
 *
 * Positions that resolve together are one bet, not several. Before trading,
 * the agent aggregates its committed exposure by configurable correlation
 * groups and checks each group against a cap. Markets whose correlation is
 * unknown are treated conservatively: they are placed in a shared "unknown"
 * bucket so missing relationships can never *increase* the effective limit.
 */
export interface CorrelationGroup {
  /** Stable identifier surfaced in traces and risk reports. */
  id: string;
  /** Markets that resolve together and share this group's cap. */
  marketIds: readonly bigint[];
  /** Most collateral the group may hold in aggregate. */
  maxExposure: bigint;
}

export interface CorrelationConfig {
  groups: readonly CorrelationGroup[];
  /**
   * Cap applied to the shared bucket of markets with no known relationship.
   * Unknown correlation must not raise limits, so this bucket is always
   * enforced and defaults to the tightest known group cap when unset.
   */
  unknownGroupMaxExposure?: bigint;
}

export interface CorrelatedExposureInput {
  /** Committed exposure per market (cost basis). */
  marketExposure: ReadonlyMap<bigint, bigint>;
  /** Collateral the candidate trade would add to `marketId`. */
  marketId: bigint;
  additionalExposure: bigint;
}

export interface CorrelationGroupExposure {
  groupId: string;
  exposure: bigint;
  maxExposure: bigint;
}

export interface CorrelatedExposureResult {
  /** Per-group aggregate exposure after the candidate trade. */
  groups: CorrelationGroupExposure[];
  /** Aggregate exposure of markets with no known correlation. */
  unknownExposure: bigint;
  unknownMaxExposure: bigint;
  /** Every cap the candidate trade would breach; empty means it fits. */
  problems: string[];
}

const UNKNOWN_GROUP_ID = "unknown";

/**
 * Aggregates committed exposure by correlation group and checks the candidate
 * trade against each group cap. Markets absent from every configured group
 * fall into the shared unknown bucket, whose cap is the tightest known group
 * cap (or the explicit `unknownGroupMaxExposure` when provided). This keeps
 * unknown correlation from ever loosening the effective limit.
 */
export function checkCorrelatedExposure(
  input: CorrelatedExposureInput,
  config: CorrelationConfig,
): CorrelatedExposureResult {
  const groupOf = new Map<bigint, string>();
  for (const group of config.groups) {
    for (const marketId of group.marketIds) groupOf.set(marketId, group.id);
  }

  const totals = new Map<string, bigint>();
  for (const group of config.groups) totals.set(group.id, 0n);
  let unknownExposure = 0n;
  for (const [marketId, exposure] of input.marketExposure) {
    const groupId = groupOf.get(marketId);
    if (groupId === undefined) {
      unknownExposure += exposure;
    } else {
      totals.set(groupId, (totals.get(groupId) ?? 0n) + exposure);
    }
  }

  // Apply the candidate trade to whichever bucket its market belongs to.
  const candidateGroup = groupOf.get(input.marketId);
  if (candidateGroup === undefined) {
    unknownExposure += input.additionalExposure;
  } else {
    totals.set(candidateGroup, (totals.get(candidateGroup) ?? 0n) + input.additionalExposure);
  }

  const problems: string[] = [];
  const groups: CorrelationGroupExposure[] = [];
  for (const group of config.groups) {
    const exposure = totals.get(group.id) ?? 0n;
    groups.push({ groupId: group.id, exposure, maxExposure: group.maxExposure });
    if (exposure > group.maxExposure) {
      problems.push(
        `correlation group ${group.id}: exposure ${exposure} would exceed cap ${group.maxExposure}`,
      );
    }
  }

  const unknownMaxExposure = resolveUnknownCap(config);
  if (unknownExposure > unknownMaxExposure) {
    problems.push(
      `correlation group ${UNKNOWN_GROUP_ID}: exposure ${unknownExposure} would exceed cap ${unknownMaxExposure}`,
    );
  }

  return { groups, unknownExposure, unknownMaxExposure, problems };
}

/**
 * The unknown bucket cap is the explicit value when set, otherwise the
 * tightest configured group cap. With no groups at all it is zero, so an
 * unconfigured agent cannot trade on unknown correlation.
 */
function resolveUnknownCap(config: CorrelationConfig): bigint {
  if (config.unknownGroupMaxExposure !== undefined) return config.unknownGroupMaxExposure;
  let tightest: bigint | undefined;
  for (const group of config.groups) {
    if (tightest === undefined || group.maxExposure < tightest) tightest = group.maxExposure;
  }
  return tightest ?? 0n;
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
  /** Treasury's current token balance before a possible yield withdrawa

/* … truncated 7739 chars — edit only what you need near the top … */
