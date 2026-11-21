/**
 * Snapshot selector functions: filter and rank markets from chain state.
 *
 * Network/deployment isolation: every selector that reads chain state is
 * scoped to the snapshot's network identity and contract deployment identity.
 * A snapshot whose markets were indexed under a different network or
 * deployment than the one it declares is rejected rather than silently
 * treated as valid, so keys and cursors can never be reused across
 * configurations.
 */
import type { Snapshot, ChainMarket } from "./types.js";

const MIN_RESERVE_STROOPS = BigInt(process.env.AGENT_MIN_RESERVE ?? "100000000"); // 10 XLM
const CLOSE_BUFFER_SEC = Number(process.env.AGENT_CLOSE_BUFFER_SEC ?? 3600);

/**
 * Assert that the snapshot's markets belong to the snapshot's declared
 * network and contract deployment. Throws on missing or mismatched identity
 * so callers cannot fall back to a success-shaped result.
 */
export function assertSnapshotIdentity(snapshot: Snapshot): void {
  const network = snapshot.network;
  const deployment = snapshot.contractId;
  if (!network || !deployment) {
    throw new Error(
      "snapshot identity missing: network and contract deployment are required",
    );
  }
  for (const market of snapshot.markets.values()) {
    if (market.network !== network || market.contractId !== deployment) {
      throw new Error(
        `snapshot identity mismatch: market ${market.marketId} belongs to ` +
          `${market.network}/${market.contractId}, expected ${network}/${deployment}`,
      );
    }
  }
}

/** Markets that are open, have sufficient liquidity, and close in the future. */
export function tradableMarkets(snapshot: Snapshot): ChainMarket[] {
  assertSnapshotIdentity(snapshot);
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const bufferSec = BigInt(CLOSE_BUFFER_SEC);

  return Array.from(snapshot.markets.values()).filter(
    (m) =>
      m.status === "open" &&
      m.reserveYes >= MIN_RESERVE_STROOPS &&
      m.reserveNo >= MIN_RESERVE_STROOPS &&
      m.closeTime > nowSec + bufferSec,
  );
}

/** Markets where the agent holds a position. */
export function heldMarkets(snapshot: Snapshot): ChainMarket[] {
  assertSnapshotIdentity(snapshot);
  return Array.from(snapshot.markets.values()).filter((m) => {
    const pos = snapshot.portfolio.positions.get(m.marketId);
    return pos && (pos.yes > 0n || pos.no > 0n);
  });
}

/** Available capital the agent can deploy. */
export function availableCapital(snapshot: Snapshot): bigint {
  const { availableCapital, daily, config } = snapshot.portfolio;
  const dailyRemaining = config.maxDaily - daily.amount;
  return availableCapital < dailyRemaining ? availableCapital : dailyRemaining;
}

/** All unique question hashes already on-chain, used to skip duplicate market proposals. */
export function existingQuestionHashes(snapshot: Snapshot): Set<string> {
  assertSnapshotIdentity(snapshot);
  return new Set(Array.from(snapshot.markets.values()).map((m) => m.questionHash));
}

/**
 * Canonical trace intent: the minimal, deterministic description of a trace
 * publication. Two intents that describe the same decision must serialize to
 * the same string regardless of key ordering or process restart.
 */
export interface TraceIntent {
  network: string;
  contractId: string;
  marketId: string;
  decision: string;
  /** Stable identifier of the reasoning payload (e.g. content hash). */
  payloadHash: string;
}

/**
 * Derive a deterministic idempotency key from the canonical trace intent.
 * The key is stable across agent restarts so a producer that crashed after
 * publication but before local acknowledgement can reconcile the previous
 * result instead of publishing a duplicate decision.
 */
export function traceIdempotencyKey(intent: TraceIntent): string {
  const canonical = JSON.stringify([
    intent.network,
    intent.contractId,
    intent.marketId,
    intent.decision,
    intent.payloadHash,
  ]);
  // FNV-1a 64-bit over the canonical intent; deterministic and dependency-free.
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= BigInt(canonical.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return `trace:${hash.toString(16).padStart(16, "0")}`;
}

/**
 * Shared lease backend for multi-host deployment.
 *
 * A lease grants a single host the right to submit transactions for a scope.
 * Each successful acquisition issues a monotonically increasing fencing token;
 * submissions carrying a stale (older) token are rejected so that a host that
 * lost its lease cannot submit after another host has taken over.
 *
 * Backends must implement atomic acquisition. If the backend is unavailable or
 * errors, acquisition fails closed (returns null) and callers must deny
 * submission rather than fall back to unsafe behavior.
 */
export interface LeaseBackend {
  /** Atomically acquire the lease for `scope`, returning a fencing token or null if held. */
  acquire(scope: string, holder: string, ttlMs: number): Promise<Lease | null>;
  /** Release the lease if `token` is still the current holder. */
  release(scope: string, token: number): Promise<void>;
  /** True if `token` is the current, non-expired fencing token for `scope`. */
  isValid(scope: string, token: number): Promise<boolean>;
}

export interface Lease {
  scope: string;
  holder: string;
  token: number;
  expiresAt: number;
}

/**
 * File-based lease backend retained for single-host / local deployments.
 * Uses exclusive file creation for atomic acquisition and a token file to
 * track the monotonically increasing fencing token.
 */
export class FileLeaseBackend implements LeaseBackend {
  constructor(private readonly dir: string) {}

  async acquire(scope: string, holder: string, ttlMs: number): Promise<Lease | null> {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const leasePath = path.join(this.dir, `${scope}.lease`);
    const tokenPath = path.join(this.dir, `${scope}.token`);
    const now = Date.now();

    try {
      const raw = await fs.readFile(leasePath, "utf8");
      const existing = JSON.parse(raw) as Lease;
      if (existing.expiresAt > now && existing.holder !== holder) return null;
    } catch {
      // No existing lease (or unreadable) — proceed to acquire.
    }

    let token = 1;
    try {
      token = Number(await fs.readFile(tokenPath, "utf8")) + 1;
    } catch {
      token = 1;
    }

    const lease: Lease = { scope, holder, token, expiresAt: now + ttlMs };
    try {
      await fs.writeFile(tokenPath, String(token), "utf8");
      await fs.writeFile(leasePath, JSON.stringify(lease), "utf8");
      return lease;
    } catch {
      return null;
    }
  }

  async release(scope: string, token: number): Promise<void> {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const leasePath = path.join(this.dir, `${scope}.lease`);
    try {
      const existing = JSON.parse(await fs.readFile(leasePath, "utf8")) as Lease;
      if (existing.token === token) await fs.unlink(leasePath);
    } catch {
      // Nothing to release.
    }
  }

  async isValid(scope: string, token: number): Promise<boolean> {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const leasePath = path.join(this.dir, `${scope}.lease`);
    try {
      const existing = JSON.parse(await fs.readFile(leasePath, "utf8")) as Lease;
      return existing.token === token && existing.expiresAt > Date.now();
    } catch {
      return false;
    }
  }
}

/**
 * Resolve the configured lease backend. Defaults to the file backend for
 * backward compatibility; a shared backend may be supplied via env config.
 */
export function resolveLeaseBackend(dir: string): LeaseBackend {
  return new FileLeaseBackend(dir);
}

/**
 * Fail-closed submission guard: returns true only when the shared backend
 * confirms `token` is the current fencing token for `scope`. Any backend
 * error denies submission.
 */
export async function canSubmit(
  backend: LeaseBackend,
  scope: string,
  token: number,
): Promise<boolean> {
  try {
    return await backend.isValid(scope, token);
  } catch {
    return false;
  }
}
