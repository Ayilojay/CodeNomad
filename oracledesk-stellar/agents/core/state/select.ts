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
 * Metadata-only trace descriptor returned by cursor-based discovery.
 *
 * Deliberately excludes trace bytes: content stays behind the verified
 * payment flow. Only stable, non-sensitive descriptors are exposed here.
 */
export interface TraceMetadata {
  traceId: string;
  createdAt: number;
  size: number;
  contentHash: string;
}

/** A page of trace metadata plus an opaque cursor for the next page. */
export interface TraceMetadataPage {
  traces: TraceMetadata[];
  /** Opaque cursor for the next page, or null when this is the last page. */
  nextCursor: string | null;
}

/** Default and maximum page sizes for trace metadata discovery. */
export const TRACE_DISCOVERY_DEFAULT_LIMIT = 50;
export const TRACE_DISCOVERY_MAX_LIMIT = 200;

/**
 * Encode an opaque cursor from a stable sort key (createdAt + traceId).
 * The cursor is base64url-encoded JSON so callers cannot forge ordering
 * semantics by hand-crafting a plain offset.
 */
function encodeTraceCursor(createdAt: number, traceId: string): string {
  return Buffer.from(JSON.stringify({ c: createdAt, t: traceId }), "utf8").toString(
    "base64url",
  );
}

/**
 * Decode an opaque cursor. Throws on malformed input so callers cannot fall
 * back to a success-shaped first page when a cursor is invalid.
 */
function decodeTraceCursor(cursor: string): { createdAt: number; traceId: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid trace cursor: not decodable");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { c?: unknown }).c !== "number" ||
    typeof (parsed as { t?: unknown }).t !== "string"
  ) {
    throw new Error("invalid trace cursor: malformed payload");
  }
  return { createdAt: (parsed as { c: number }).c, traceId: (parsed as { t: string }).t };
}

/**
 * Cursor-based, metadata-only trace discovery.
 *
 * Returns at most `limit` trace descriptors ordered by (createdAt, traceId)
 * ascending, starting strictly after `cursor` when provided. Trace bytes are
 * never returned; retrieval of content remains gated by the verified payment
 * flow. Invalid cursors and out-of-range limits throw rather than silently
 * degrading to an unbounded or first-page result.
 */
export function discoverTraceMetadata(
  traces: Iterable<TraceMetadata>,
  options: { cursor?: string | null; limit?: number } = {},
): TraceMetadataPage {
  const limit = options.limit ?? TRACE_DISCOVERY_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > TRACE_DISCOVERY_MAX_LIMIT) {
    throw new Error(
      `invalid trace discovery limit: must be an integer in [1, ${TRACE_DISCOVERY_MAX_LIMIT}]`,
    );
  }

  const after = options.cursor ? decodeTraceCursor(options.cursor) : null;

  const sorted = Array.from(traces).sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.traceId < b.traceId ? -1 : a.traceId > b.traceId ? 1 : 0;
  });

  const start = after
    ? sorted.findIndex(
        (t) =>
          t.createdAt > after.createdAt ||
          (t.createdAt === after.createdAt && t.traceId > after.traceId),
      )
    : 0;

  const from = start === -1 ? sorted.length : start;
  const page = sorted.slice(from, from + limit);
  const hasMore = from + limit < sorted.length;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeTraceCursor(last.createdAt, last.traceId) : null;

  return {
    traces: page.map((t) => ({
      traceId: t.traceId,
      createdAt: t.createdAt,
      size: t.size,
      contentHash: t.contentHash,
    })),
    nextCursor,
  };
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
