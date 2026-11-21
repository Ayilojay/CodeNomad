/**
 * Durable storage for resolution specs the market-maker has committed to,
 * and the recovery loop that guarantees each one is eventually revealed.
 *
 * A market's `resolution_hash` is fixed at creation and only the stored
 * spec reproduces it, so losing the spec between `agent_create_market` and
 * `register_*_spec` makes the market permanently unresolvable. The store is
 * therefore written (fsync + atomic rename) BEFORE the create transaction
 * exists, and its directory (`AGENT_SPEC_DIR`, default `./.specs`) must be
 * backed up — `SPEC_BACKUP_CMD` runs after every write for that.
 */
import { exec } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { canonicalizeSpec, type SpecJson } from "./spec.js";

export interface StoredSpec {
  /** Unique per create attempt: the same spec may be committed to by
   * several markets, so the commitment alone is not a key. */
  id: string;
  commitment: string;
  spec: SpecJson;
  questionHash: string;
  state: "pending_create" | "created" | "revealed" | "abandoned";
  marketId?: string;
  createdTx?: string;
  /** close_time sent with the create, so recovery can match it exactly. */
  closeTime?: string;
  /** Unix milliseconds. */
  createdAt: number;
  updatedAt: number;
  lastError?: string;
}

export interface SpecStore {
  put(s: StoredSpec): Promise<void>;
  byCommitment(h: string): Promise<StoredSpec | undefined>;
  list(state?: StoredSpec["state"]): Promise<StoredSpec[]>;
}

export function newStoredSpec(args: {
  commitment: string;
  spec: SpecJson;
  questionHash: string;
  closeTime?: bigint;
  now?: number;
}): StoredSpec {
  const now = args.now ?? Date.now();
  return {
    id: `${now}-${randomBytes(4).toString("hex")}`,
    commitment: args.commitment,
    spec: canonicalizeSpec(args.spec),
    questionHash: args.questionHash,
    state: "pending_create",
    closeTime: args.closeTime?.toString(),
    createdAt: now,
    updatedAt: now,
  };
}

function pickByCommitment(all: StoredSpec[], h: string): StoredSpec | undefined {
  const matches = all.filter((s) => s.commitment === h);
  matches.sort((a, b) => Number(a.state === "abandoned") - Number(b.state === "abandoned") || b.updatedAt - a.updatedAt);
  return matches[0];
}

/** Non-durable store for dry-run and tests. */
export class MemorySpecStore implements SpecStore {
  private readonly entries = new Map<string, StoredSpec>();

  async put(s: StoredSpec): Promise<void> {
    this.entries.set(s.id, structuredClone(s));
  }

  async byCommitment(h: string): Promise<StoredSpec | undefined> {
    return pickByCommitment(await this.list(), h);
  }

  async list(state?: StoredSpec["state"]): Promise<StoredSpec[]> {
    return [...this.entries.values()].filter((s) => !state || s.state === state).map((s) => structuredClone(s));
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

  private fileFor(s: StoredSpec): string {
    if (!/^[0-9a-f]{64}$/.test(s.commitment)) throw new Error(`bad commitment ${s.commitment}`);
    if (!/^[A-Za-z0-9-]+$/.test(s.id)) throw new Error(`bad spec id ${s.id}`);
    return join(this.dir, `${s.commitment}.${s.id}.json`);
  }

  async put(s: StoredSpec): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const final = this.fileFor(s);
    const tmp = `${final}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    const fh = await open(tmp, "wx", 0o600);
    try {
      await fh.writeFile(JSON.stringify(s, null, 2) + "\n", "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await this.renameFn(tmp, final);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
    await this.syncDir();
    await this.backup(final);
  }

  private async syncDir(): Promise<void> {
    try {
      const dh = await open(this.dir, "r");
      try {
        await dh.sync();
      } finally {
        await dh.close();
      }
    } catch (err) {
      // Windows cannot open/fsync a directory; the rename itself is durable
      // there (MoveFileEx with write-through is what libuv uses).
      if (process.platform !== "win32") throw err;
    }
  }

  private async backup(file: string): Promise<void> {
    if (!this.opts.backupCmd) return;
    await new Promise<void>((resolve) => {
      exec(this.opts.backupCmd!, { env: { ...process.env, SPEC_DIR: this.dir, SPEC_FILE: file } }, (err) => {
        if (err) this.log(`[spec-store] WARNING: SPEC_BACKUP_CMD failed for ${file}: ${err.message}`);
        resolve();
      });
    });
  }

  async byCommitment(h: string): Promise<StoredSpec | undefined> {
    return pickByCommitment(await this.list(), h);
  }

  async list(state?: StoredSpec["state"]): Promise<StoredSpec[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: StoredSpec[] = [];
    for (const name of names) {
      if (!/^[0-9a-f]{64}\.[A-Za-z0-9-]+\.json$/.test(name)) continue;
      // Final files are only ever produced by rename, so a parse failure is
      // corruption, not a torn write: surface it rather than skip a spec.
      const s = JSON.parse(await readFile(join(this.dir, name), "utf8")) as StoredSpec;
      if (!state || s.state === state) out.push(s);
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }
}

// --- recovery ---------------------------------------------------------------

export interface ChainMarketView {
  creator: string;
  questionHash: string;
  resolutionHash: string;
  closeTime: bigint;
}

/** What recovery needs from the chain; implemented over StellarAdapter. */
export interface RecoveryChain {
  marketCount(): Promise<bigint>;
  getMarket(id: bigint): Promise<ChainMarketView | undefined>;
  /** True once any spec is registered for the market. Price reveals leave
   * `state()` at Unconfigured, so this must also check the spec entry. */
  isRevealed(id: bigint): Promise<boolean>;
  /** register_signer_spec / register_price_spec; throws on failure. */
  reveal(id: bigint, spec: SpecJson): Promise<void>;
}

/** The resolver's `MarketAlreadyConfigured` (#4), however the SDK surfaced it. */
export function isMarketAlreadyConfigured(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /MarketAlreadyConfigured|Error\(Contract, #4\)/.test(msg);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Reveals `entry` for its (already known) market and records the outcome.
 * Someone else may reveal first — reveal is permissionless — so
 * `MarketAlreadyConfigured` counts as success once the market's on-chain
 * commitment is confirmed to be ours.
 */
export async function revealStored(
  store: SpecStore,
  chain: RecoveryChain,
  entry: StoredSpec,

/* … truncated 5128 chars — edit only what you need near the top … */
