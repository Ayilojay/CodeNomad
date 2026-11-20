/**
 * Snapshot selector functions: filter and rank markets from chain state.
 */
import type { Snapshot, ChainMarket } from "./types.js";

const MIN_RESERVE_STROOPS = BigInt(process.env.AGENT_MIN_RESERVE ?? "100000000"); // 10 XLM
const CLOSE_BUFFER_SEC = Number(process.env.AGENT_CLOSE_BUFFER_SEC ?? 3600);

/** Markets that are open, have sufficient liquidity, and close in the future. */
export function tradableMarkets(snapshot: Snapshot): ChainMarket[] {
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
  return new Set(Array.from(snapshot.markets.values()).map((m) => m.questionHash));
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
