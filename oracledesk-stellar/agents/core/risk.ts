import { createHash } from "crypto";

export interface SignalObservation {
  value: number;
  timestamp: number;
  sourceId: string;
  evidenceHash: string;
}

export interface NormalizedSignal extends SignalObservation {
  ageMs: number;
}

export interface SignalAdapterOptions {
  /** Maximum allowed age of an observation in milliseconds. */
  freshnessWindowMs: number;
  /** Maximum tolerated clock skew into the future in milliseconds. */
  maxClockSkewMs?: number;
  /** Optional clock injection for deterministic tests. */
  now?: () => number;
}

export type SignalRejectionReason =
  | "malformed"
  | "future"
  | "stale"
  | "duplicate";

export class SignalRejectedError extends Error {
  readonly reason: SignalRejectionReason;

  constructor(reason: SignalRejectionReason, message: string) {
    super(message);
    this.name = "SignalRejectedError";
    this.reason = reason;
  }
}

const EVIDENCE_HASH_PATTERN = /^[a-f0-9]{64}$/i;
const REDACTED = "[redacted]";
const CREDENTIAL_PATTERN =
  /((?:api[_-]?key|secret|token|password|authorization|bearer)\s*[:=]\s*)([^\s,;]+)/gi;

/**
 * Redact credential-like substrings from free-form provider text so they never
 * leak into logs or evidence payloads.
 */
export function redactCredentials(input: string): string {
  return input.replace(CREDENTIAL_PATTERN, (_match, prefix: string) => `${prefix}${REDACTED}`);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function assertWellFormed(observation: unknown): asserts observation is SignalObservation {
  if (typeof observation !== "object" || observation === null) {
    throw new SignalRejectedError("malformed", "observation must be an object");
  }
  const candidate = observation as Record<string, unknown>;
  if (!isFiniteNumber(candidate.value)) {
    throw new SignalRejectedError("malformed", "observation value must be a finite number");
  }
  if (!isFiniteNumber(candidate.timestamp)) {
    throw new SignalRejectedError("malformed", "observation timestamp must be a finite number");
  }
  if (typeof candidate.sourceId !== "string" || candidate.sourceId.trim() === "") {
    throw new SignalRejectedError("malformed", "observation sourceId must be a non-empty string");
  }
  if (
    typeof candidate.evidenceHash !== "string" ||
    !EVIDENCE_HASH_PATTERN.test(candidate.evidenceHash)
  ) {
    throw new SignalRejectedError(
      "malformed",
      "observation evidenceHash must be a 64-character hex digest",
    );
  }
}

/**
 * Normalize a raw provider observation into a canonical signal record, enforcing
 * provenance (sourceId + evidenceHash) and freshness (no future, no stale, no
 * duplicate) guarantees. Throws SignalRejectedError on any violation.
 */
export function normalizeSignal(
  observation: unknown,
  options: SignalAdapterOptions,
  seenEvidenceHashes: Set<string> = new Set(),
): NormalizedSignal {
  assertWellFormed(observation);

  const now = options.now ? options.now() : Date.now();
  const maxClockSkewMs = options.maxClockSkewMs ?? 0;
  const ageMs = now - observation.timestamp;

  if (ageMs < -maxClockSkewMs) {
    throw new SignalRejectedError(
      "future",
      `observation timestamp is ${-ageMs}ms in the future (max skew ${maxClockSkewMs}ms)`,
    );
  }
  if (ageMs > options.freshnessWindowMs) {
    throw new SignalRejectedError(
      "stale",
      `observation is ${ageMs}ms old (freshness window ${options.freshnessWindowMs}ms)`,
    );
  }

  const evidenceHash = observation.evidenceHash.toLowerCase();
  if (seenEvidenceHashes.has(evidenceHash)) {
    throw new SignalRejectedError("duplicate", "observation evidenceHash already processed");
  }
  seenEvidenceHashes.add(evidenceHash);

  return {
    value: observation.value,
    timestamp: observation.timestamp,
    sourceId: observation.sourceId.trim(),
    evidenceHash,
    ageMs,
  };
}

/**
 * Compute a deterministic evidence hash for a provider payload. Useful for
 * adapters that receive raw payloads without a precomputed digest.
 */
export function computeEvidenceHash(payload: unknown): string {
  const serialized = typeof payload === "string" ? payload : JSON.stringify(payload);
  return createHash("sha256").update(serialized).digest("hex");
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
  treasuryBalance: bigint;
  /** Amount currently deployed into yield strategies. */
  yieldDeployed: bigint;
  /** Optional per-market exposure already booked, keyed by market id. */
  marketExposure?: Record<string, bigint>;
}

export interface AgentRiskPolicy {
  maxTrade: bigint;
  maxMarket: bigint;
  maxDaily: bigint;
  maxNetExposure: bigint;
}

export interface AgentUsageWindow {
  day: bigint;
  dailyNotional: bigint;
  netExposure: bigint;
}

/**
 * A single deployment of an agent against a market. Multiple deployments may
 * share the same underlying market liquidity, so aggregate risk must be
 * evaluated across all of them rather than per-instance.
 */
export interface AgentDeployment {
  id: string;
  marketId: string;
  /** Notional currently at risk in this deployment. */
  notional: bigint;
  /** Fraction (0..1) of the deployment exposed to the market's shared liquidity. */
  liquidityShare: number;
}

/**
 * A correlated stress scenario: a set of markets that move together, the
 * drawdown applied to each, and the shared liquidity available to absorb it.
 */
export interface CorrelatedStressScenario {
  id: string;
  /** Markets assumed to be perfectly correlated in this scenario. */
  marketIds: string[];
  /** Fractional drawdown (0..1) applied simultaneously to every market. */
  drawdown: number;
  /** Shared liquidity pool (in token units) backing the correlated markets. */
  sharedLiquidity: bigint;
}

export interface DeploymentStressResult {
  deploymentId: string;
  marketId: string;
  /** Loss booked to this deployment under the scenario. */
  loss: bigint;
  /** Portion of the loss that could not be covered by shared liquidity. */
  uncoveredLoss: bigint;
}

export interface TreasuryStressReport {
  scenarioId: string;
  /** Worst-case capital at risk across all deployments in the scenario. */
  capitalAtRisk: bigint;
  /** Total loss across deployments after shared-liquidity absorption. */
  totalLoss: bigint;
  /** Loss that exceeds shared liquidity and must be borne by the treasury. */
  uncoveredLoss: bigint;
  /** Per-deployment breakdown for operator inspection. */
  deployments: DeploymentStressResult[];
  /**
   * Controls that act on-chain (enforced by contracts) versus off-chain
   * (advisory only). Operators must not rely on off-chain controls for safety.
   */
  onChainControls: string[];
  offChainControls: string[];
}

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function toBigIntFraction(amount: bigint, fraction: number): bigint {
  // Scale to basis points to keep bigint math deterministic.
  const bps = BigInt(Math.round(clampFraction(fraction) * 10_000));
  return (amount * bps) / 10_000n;
}

/**
 * Evaluate a treasury-wide loss and exposure stress model. Correlated markets
 * draw down simultaneously; losses are first absorbed by the shared liquidity
 * pool, and any remainder is reported as uncovered treasury loss. The report
 * also enumerates which controls act on-chain so operators can reason about
 * enforceable guarantees.
 */
export function evaluateTreasuryStress(
  scenario: CorrelatedStressScenario,
  deployments: AgentDeployment[],
): TreasuryStressReport {
  const drawdown = clampFraction(scenario.drawdown);
  const correlated = new Set(scenario.marketIds);
  const affected = deployments.filter((d) => correlated.has(d.marketId));

  let capitalAtRisk = 0n;
  let grossLoss = 0n;
  const results: DeploymentStressResult[] = affected.map((deployment) => {
    const exposure = deployment.notional > 0n ? deployment.notional : 0n;
    capitalAtRisk += exposure;
    const loss = toBigIntFraction(exposure, drawdown);
    grossLoss += loss;
    return {
      deploymentId: deployment.id,
      marketId: deployment.marketId,
      loss,
      uncoveredLoss: 0n,
    };
  });

  const liquidity = scenario.sharedLiquidity > 0n ? scenario.sharedLiquidity : 0n;
  const absorbed = grossLoss < liquidity ? grossLoss : liquidity;
  const uncoveredLoss = grossLoss - absorbed;

  // Distribute the uncovered remainder proportionally across deployments so
  // operators can see which deployment drives treasury loss.
  if (uncoveredLoss > 0n && grossLoss > 0n) {
    for (const result of results) {
      result.uncoveredLoss = (result.loss * uncoveredLoss) / grossLoss;
    }
  }

  return {
    scenarioId: scenario.id,
    capitalAtRisk,
    totalLoss: grossLoss,
    uncoveredLoss,
    deployments: results,
    onChainControls: [
      "per-trade cap (maxTrade)",
      "per-market cap (maxMarket)",
      "daily notional cap (maxDaily)",
      "net exposure cap (maxNetExposure)",
      "treasury balance / yield withdrawal guard",
    ],
    offChainControls: [
      "correlated stress scenario selection",
      "shared-liquidity assumptions",
      "operator alerting and dashboards",
    ],
  };
}
