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

/**
 * Runtime state file versioning and migration.
 *
 * State files carry a `version` field. On load, files at an older supported
 * version are upgraded through a sequential migration chain; each step is
 * validated against the current schema before the next step runs. Files at an
 * unknown (future) version fail closed without being overwritten, so an
 * unresolved intent is never silently discarded by an older binary.
 *
 * Writes are atomic (temp file + rename) and a bounded set of pre-migration
 * backups is retained so operators can recover from a bad upgrade.
 */
export const CURRENT_STATE_VERSION = 2;
const MAX_STATE_BACKUPS = Number(process.env.AGENT_STATE_BACKUPS ?? 5);

/** A single forward migration from `from` to `from + 1`. */
export interface StateMigration {
  from: number;
  migrate: (state: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * Sequential migration chain. Each entry upgrades exactly one version step so
 * the chain can be applied in order and validated between steps.
 */
export const STATE_MIGRATIONS: StateMigration[] = [
  {
    from: 1,
    migrate: (state) => {
      // v1 -> v2: intents gained an explicit `status` field; older files only
      // tracked pending intents, so default them to "pending".
      const intents = Array.isArray(state.intents) ? state.intents : [];
      return {
        ...state,
        intents: intents.map((intent) => {
          const record = intent as Record<string, unknown>;
          return { status: "pending", ...record };
        }),
      };
    },
  },
];

/** Validate that a migrated state object matches the current schema. */
export function validateState(state: unknown): asserts state is Record<string, unknown> {
  if (typeof state !== "object" || state === null || Array.isArray(state)) {
    throw new Error("state file corrupted: expected a JSON object");
  }
  const record = state as Record<string, unknown>;
  if (record.version !== CURRENT_STATE_VERSION) {
    throw new Error(
      `state file corrupted: expected version ${CURRENT_STATE_VERSION}, got ${String(record.version)}`,
    );
  }
  if (!Array.isArray(record.intents)) {
    throw new Error("state file corrupted: `intents` must be an array");
  }
  for (const intent of record.intents) {
    if (typeof intent !== "object" || intent === null) {
      throw new Error("state file corrupted: intent entries must be objects");
    }
    if (typeof (intent as Record<string, unknown>).status !== "string") {
      throw new Error("state file corrupted: intent entries require a string `status`");
    }
  }
}

/**
 * Migrate a parsed state object to the current version. Unknown future
 * versions throw before any mutation so callers never overwrite them.
 */
export function migrateState(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("state file corrupted: expected a JSON object");
  }
  let state = raw as Record<string, unknown>;
  const version = state.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new Error(`state file corrupted: invalid version ${String(version)}`);
  }
  if (version > CURRENT_STATE_VERSION) {
    throw new Error(
      `state file version ${version} is newer than supported ${CURRENT_STATE_VERSION}; refusing to overwrite`,
    );
  }
  while ((state.version as number) < CURRENT_STATE_VERSION) {
    const current = state.version as number;
    const step = STATE_MIGRATIONS.find((m) => m.from === current);
    if (!step) {
      throw new Error(`no migration path from state version ${current}`);
    }
    state = { ...step.migrate(state), version: current + 1 };
    validateState(state);
  }
  validateState(state);
  return state;
}

/**
 * Load, migrate, and atomically persist a runtime state file.
 *
 * - Unknown future versions throw without touching the file.
 * - Corrupted input throws without touching the file.
 * - A pre-migration backup is written before replacement, bounded by
 *   MAX_STATE_BACKUPS.
 * - The new state is written to a temp file and renamed into place so a
 *   failed write never leaves a partially written state file.
 */
export async function loadAndMigrateState(filePath: string): Promise<Record<string, unknown>> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");

  let rawText: string;
  try {
    rawText = await fs.readFile(filePath, "utf8");
  } catch (err) {
    throw new Error(`state file unreadable: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(`state file corrupted: invalid JSON (${(err as Error).message})`);
  }

  const originalVersion =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>).version
      : undefined;
  const migrated = migrateState(parsed);

  // Only rewrite when a migration actually changed the version.
  if (originalVersion === CURRENT_STATE_VERSION) {
    return migrated;
  }

  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const backupPath = path.join(dir, `${base}.v${String(originalVersion)}.bak`);
  await fs.writeFile(backupPath, rawText, "utf8");
  await pruneBackups(dir, base, fs, path);

  const tmpPath = path.join(dir, `.${base}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tmpPath, JSON.stringify(migrated, null, 2), "utf8");
  await fs.rename(tmpPath, filePath);
  return migrated;
}

/** Retain only the newest MAX_STATE_BACKUPS backups for a state file. */
async function pruneBackups(
  dir: string,
  base: string,
  fs: typeof import("node:fs/promises"),
  path: typeof import("node:path"),
): Promise<void> {
  const prefix = `${base}.v`;
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  const backups = entries
    .filter((name) => name.startsWith(prefix) && name.endsWith(".bak"))
    .sort();
  const excess = backups.length - MAX_STATE_BACKUPS;
  for (let i = 0; i < excess; i++) {
    try {
      await fs.unlink(path.join(dir, backups[i]));
    } catch {
      // Best-effort pruning; never fail the migration over cleanup.
    }
  }
}
