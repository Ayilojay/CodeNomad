/**
 * Canonical trace payload schema + serialization for trace hashing.
 *
 * Producers and consumers must agree on a stable schema/version contract as
 * fields and actions evolve. The canonical payload is a deterministic JSON
 * encoding with:
 *   - a fixed top-level key order (schemaVersion first, then payload keys)
 *   - lexicographically sorted object keys at every nesting level
 *   - no whitespace
 *   - only finite numbers in canonical form (no -0, no exponent ambiguity)
 *   - rejection of duplicate keys and unsupported schema versions
 */

export const TRACE_SCHEMA_VERSION = 1 as const;

export const SUPPORTED_TRACE_SCHEMA_VERSIONS: readonly number[] = [1];

export type TraceSchemaVersion = (typeof TRACE_SCHEMA_VERSION);

export interface CanonicalTracePayload {
  schemaVersion: TraceSchemaVersion;
  [key: string]: unknown;
}

export class TraceSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TraceSchemaError";
  }
}

function assertSupportedVersion(version: unknown): asserts version is TraceSchemaVersion {
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new TraceSchemaError(`trace schemaVersion must be an integer, got ${String(version)}`);
  }
  if (!SUPPORTED_TRACE_SCHEMA_VERSIONS.includes(version)) {
    throw new TraceSchemaError(
      `unsupported trace schemaVersion ${version}; supported: ${SUPPORTED_TRACE_SCHEMA_VERSIONS.join(", ")}`,
    );
  }
}

// --- verified-trace cache ---------------------------------------------------

/**
 * Cache key for a verified trace. Every dimension that can change the
 * verification outcome is part of the key, so entries can never collide
 * across networks, registries, traces, or committed hashes.
 */
export interface VerifiedTraceCacheKey {
  network: string;
  registry: string;
  traceId: string;
  committedHash: string;
}

/** Default TTL for verified-trace cache entries: 5 minutes. */
export const DEFAULT_VERIFIED_TRACE_TTL_MS = 5 * 60 * 1000;

/**
 * Deterministic, collision-free cache key. Fields are length-prefixed so
 * values containing the separator cannot alias each other.
 */
export function verifiedTraceCacheKey(k: VerifiedTraceCacheKey): string {
  const parts = [k.network, k.registry, k.traceId, k.committedHash];
  return parts.map((p) => `${p.length}:${p}`).join("|");
}

export interface VerifiedTraceCacheEntry {
  key: string;
  /** Committed hash the entry was verified against. */
  committedHash: string;
  /** Registry address/version the entry was verified against. */
  registryState: string;
  /** Unix milliseconds. */
  verifiedAt: number;
  /** Unix milliseconds; `verifiedAt + ttlMs`. */
  expiresAt: number;
  /** Opaque verified payload; never a success-shaped fallback. */
  value: unknown;
}

export interface VerifiedTraceCacheOptions {
  /** Entry TTL in ms. Defaults to `DEFAULT_VERIFIED_TRACE_TTL_MS`. */
  ttlMs?: number;
  /** Test seam for the clock. */
  now?: () => number;
}

/**
 * In-memory cache of verified traces. A lookup returns `undefined` (a miss)
 * when the entry is absent, expired, was verified against a different
 * committed hash, or the registry state has changed since verification.
 * Misses are never turned into a success-shaped value.
 */
export class VerifiedTraceCache {
  private readonly entries = new Map<string, VerifiedTraceCacheEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: VerifiedTraceCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_VERIFIED_TRACE_TTL_MS;
    if (!(this.ttlMs > 0)) throw new Error(`bad verified-trace TTL ${this.ttlMs}`);
    this.now = opts.now ?? Date.now;
  }

  get(
    key: VerifiedTraceCacheKey,
    expected: { committedHash: string; registryState: string },
  ): VerifiedTraceCacheEntry | undefined {
    const id = verifiedTraceCacheKey(key);
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (entry.committedHash !== expected.committedHash || key.committedHash !== expected.committedHash) {
      this.entries.delete(id);
      return undefined;
    }
    if (entry.registryState !== expected.registryState) {
      this.entries.delete(id);
      return undefined;
    }
    if (this.now() >= entry.expiresAt) {
      this.entries.delete(id);
      return undefined;
    }
    return entry;
  }

  set(
    key: VerifiedTraceCacheKey,
    value: unknown,
    expected: { registryState: string },
  ): VerifiedTraceCacheEntry {
    const id = verifiedTraceCacheKey(key);
    const verifiedAt = this.now();
    const entry: VerifiedTraceCacheEntry = {
      key: id,
      committedHash: key.committedHash,
      registryState: expected.registryState,
      verifiedAt,
      expiresAt: verifiedAt + this.ttlMs,
      value,
    };
    this.entries.set(id, entry);
    return entry;
  }

  /** Explicit invalidation, e.g. when registry state changes. */
  invalidate(key: VerifiedTraceCacheKey): void {
    this.entries.delete(verifiedTraceCacheKey(key));
  }

  /** Drop every entry verified against a given registry state. */
  invalidateRegistry(registryState: string): void {
    for (const [id, entry] of this.entries) {
      if (entry.registryState === registryState) this.entries.delete(id);
    }
  }

  size(): number {
    return this.entries.size;
  }
}

export interface FileSpecStoreOptions {
  /** Shell command run after each put (e.g. `rclone copy .specs remote:specs`).
   * Gets `SPEC_DIR` and `SPEC_FILE` in its environment. */
  backupCmd?: string;
  /** Test seam: replaces the rename step. */
  rename?: (from: string, to: string) => Promise<void>;
  log?: (msg: string) => void;
}

/**
 * One JSON file per create attempt, `<dir>/<commitment>.<id>.json`, written
 * as temp file → fsync → rename → fsync(dir). A crash at any point leaves
 * either the previous complete file or the new complete file, never a
 * partial one; stray `*.tmp` files are ignored.
 */
export class FileSpecStore implements SpecStore {
  private readonly renameFn: (from: string, to: string) => Promise<void>;
  private readonly log: (msg: string) => void;

  constructor(
    private readonly dir: string,
    private readonly opts: FileSpecStoreOptions = {},
  ) {
    this.renameFn = opts.rename ?? rename;
    this.log = opts.log ?? ((m) => console.warn(m));
  }
  if (Object.is(value, -0)) {
    throw new TraceSchemaError("negative zero is not a canonical number form");
  }
  return JSON.stringify(value);
}

function canonicalize(value: unknown, path: string): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") return canonicalizeNumber(value as number);
  if (t === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v, i) => canonicalize(v, `${path}[${i}]`)).join(",")}]`;
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const v = obj[key];
      if (v === undefined) {
        throw new TraceSchemaError(`undefined value at ${path}.${key} is not canonical`);
      }
      parts.push(`${JSON.stringify(key)}:${canonicalize(v, `${path}.${key}`)}`);
    }
    return `{${parts.join(",")}}`;
  }
  throw new TraceSchemaError(`unsupported value type ${t} at ${path}`);
}

/**
 * Build a canonical trace payload with the current schema version stamped in.
 * The returned object is the canonical structure; serialize it with
 * `serializeCanonicalTrace` before hashing.
 */
export async function revealStored(
  store: SpecStore,
  chain: RecoveryChain,
  entry: StoredSpec,

/* … truncated 5128 chars — edit only what you need near the top … */
