/**
 * Off-chain Ed25519 attestations for `resolver.submit_signatures`.
 *
 * A committee member signs the message built here with a plain Ed25519 key;
 * anyone (typically the agent or a keeper) collects the signatures and submits
 * them in one transaction. The byte layout must match
 * `Resolver::attestation_message` in contracts/resolver/src/lib.rs exactly:
 *
 *   "oracledesk-attest-v1"                  20 ASCII bytes, domain tag
 *   || network_id                           32 bytes, sha256(network passphrase)
 *   || ScVal-XDR(resolver contract address) 40 bytes for a C... address
 *   || market_id                            u64 big-endian
 *   || round                                u32 big-endian
 *   || outcome                              1 byte: 0 = Yes, 1 = No
 *   || spec_hash                            32 bytes, the market's resolution_hash
 *
 * The message is signed raw (never pre-hashed), matching the contract's
 * `ed25519_verify`. The golden vectors in attestation.test.ts are shared with
 * the Rust test `golden_attestation_message_and_signature`.
 *
 * Verified-trace cache
 * --------------------
 * `VerifiedTraceCache` memoizes the result of verifying a trace so callers do
 * not re-run Ed25519 checks on every read. Entries are keyed by a deterministic
 * composite of network, registry, trace ID and committed hash, so a trace can
 * never be served from a cache entry belonging to a different network,
 * registry, trace or commit. Entries expire after a configurable TTL
 * (`DEFAULT_VERIFIED_TRACE_TTL_MS`, 5 minutes) and are invalidated eagerly when
 * the committed hash no longer matches the verified trace or when the registry
 * state (address/version or verification status) changes.
 */

import { createHash } from "node:crypto";
import { Address, Keypair, StrKey } from "@stellar/stellar-sdk";

const DOMAIN = Buffer.from("oracledesk-attest-v1", "ascii");
/** Order of the Ed25519 base-point subgroup. */
const GROUP_ORDER = (1n << 252n) + 27742317777372353535851937790883648493n;

export type AttestedOutcome = "Yes" | "No";

export interface AttestationContext {
  networkPassphrase: string;
  /** The resolver contract (`C...`) the signatures will be submitted to. */
  resolverId: string;
  marketId: bigint;
  /** `resolver.current_round(marketId)` at signing time. */
  round: number;
  outcome: AttestedOutcome;
  /** 32-byte `resolution_hash` of the market (from market-core `get_market`). */
  specHash: Uint8Array;
}

export interface Attestation {
  pubkey: Uint8Array;
  sig: Uint8Array;
}

export function buildAttestationMessage(ctx: AttestationContext): Uint8Array {
  if (ctx.specHash.length !== 32) {
    throw new Error(`specHash must be 32 bytes, got ${ctx.specHash.length}`);
  }
  if (!Number.isInteger(ctx.round) || ctx.round < 0 || ctx.round > 0xffff_ffff) {
    throw new Error(`round must be a u32, got ${ctx.round}`);
  }
  const marketId = Buffer.alloc(8);
  marketId.writeBigUInt64BE(ctx.marketId);
  const round = Buffer.alloc(4);
  round.writeUInt32BE(ctx.round);

  return Buffer.concat([
    DOMAIN,
    createHash("sha256").update(ctx.networkPassphrase).digest(),
    Address.fromString(ctx.resolverId).toScVal().toXDR(),
    marketId,
    round,
    Buffer.from([ctx.outcome === "Yes" ? 0 : 1]),
    ctx.specHash,
  ]);
}

export function signAttestation(keypair: Keypair, ctx: AttestationContext): Attestation {
  const message = buildAttestationMessage(ctx);
  return {
    pubkey: new Uint8Array(keypair.rawPublicKey()),
    sig: new Uint8Array(keypair.sign(Buffer.from(message))),
  };
}

/**
 * Pre-filter for a batch before `submit_signatures`: the contract aborts the
 * whole batch on one invalid signature, so drop anything this rejects.
 *
 * Besides the Ed25519 check it rejects a non-canonical `S` (>= the group
 * order), which the contract also rejects. It does not re-implement the
 * contract's rejection of weak (small-order) public keys and small-order `R`,
 * so it can pass a signature the contract refuses; that only makes the batch
 * fail, it can never make an invalid signature count.
 */
export function verifyAttestation(
  pubkey: Uint8Array,
  sig: Uint8Array,
  ctx: AttestationContext,
): boolean {
  if (pubkey.length !== 32 || sig.length !== 64) return false;
  const s = BigInt(`0x${Buffer.from(sig.slice(32)).reverse().toString("hex")}`);
  if (s >= GROUP_ORDER) return false;
  const message = Buffer.from(buildAttestationMessage(ctx));
  const key = Keypair.fromPublicKey(StrKey.encodeEd25519PublicKey(Buffer.from(pubkey)));
  return key.verify(message, Buffer.from(sig));
}

/** Default TTL for verified-trace cache entries: 5 minutes. */
export const DEFAULT_VERIFIED_TRACE_TTL_MS = 5 * 60 * 1000;

/** Registry state that a verified-trace cache entry is bound to. */
export interface RegistryState {
  /** Registry contract address (`C...`). */
  address: string;
  /** Registry version / schema identifier. */
  version: string;
  /** Whether the registry currently considers the trace verified. */
  verified: boolean;
}

/** Inputs that identify a verified trace for caching. */
export interface VerifiedTraceKey {
  /** Network passphrase (e.g. `Test SDF Network ; September 2015`). */
  networkPassphrase: string;
  /** Registry contract address (`C...`). */
  registry: string;
  /** Trace identifier. */
  traceId: string;
  /** Committed hash of the trace (hex or base64 string). */
  committedHash: string;
}

/**
 * Deterministic cache key isolating entries by network, registry, trace ID and
 * committed hash. Each component is length-prefixed so distinct tuples can
 * never collide into the same key.
 */
export function verifiedTraceCacheKey(key: VerifiedTraceKey): string {
  const parts = [key.networkPassphrase, key.registry, key.traceId, key.committedHash];
  return parts.map((p) => `${Buffer.byteLength(p, "utf8")}:${p}`).join("|");
}

interface CacheEntry<T> {
  value: T;
  committedHash: string;
  registry: RegistryState;
  expiresAt: number;
}

export interface VerifiedTraceCacheOptions {
  /** Entry TTL in milliseconds. Defaults to `DEFAULT_VERIFIED_TRACE_TTL_MS`. */
  ttlMs?: number;
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Cache of verified traces. A `get` only returns a value when the entry is
 * unexpired, its committed hash still matches, and the registry state is
 * unchanged; otherwise the entry is dropped and `undefined` is returned so the
 * caller re-verifies. This never fabricates a success: a miss forces a fresh
 * verification.
 */
export class VerifiedTraceCache<T = unknown> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: VerifiedTraceCacheOptions = {}) {
    const ttl = options.ttlMs ?? DEFAULT_VERIFIED_TRACE_TTL_MS;
    if (!Number.isFinite(ttl) || ttl <= 0) {
      throw new Error(`ttlMs must be a positive number, got ${ttl}`);
    }
    this.ttlMs = ttl;
    this.now = options.now ?? Date.now;
  }

  set(key: VerifiedTraceKey, value: T, registry: RegistryState): void {
    this.entries.set(verifiedTraceCacheKey(key), {
      value,
      committedHash: key.committedHash,
      registry: { ...registry },
      expiresAt: this.now() + this.ttlMs,
    });
  }

  get(key: VerifiedTraceKey, registry: RegistryState): T | undefined {
    const cacheKey = verifiedTraceCacheKey(key);
    const entry = this.entries.get(cacheKey);
    if (!entry) return undefined;
    if (this.now() >= entry.expiresAt) {
      this.entries.delete(cacheKey);
      return undefined;
    }
    if (entry.committedHash !== key.committedHash) {
      this.entries.delete(cacheKey);
      return undefined;
    }
    if (
      entry.registry.address !== registry.address ||
      entry.registry.version !== registry.version ||
      entry.registry.verified !== registry.verified
    ) {
      this.entries.delete(cacheKey);
      return undefined;
    }
    return entry.value;
  }

  /** Drop a single entry (e.g. on an observed hash mismatch). */
  invalidate(key: VerifiedTraceKey): void {
    this.entries.delete(verifiedTraceCacheKey(key));
  }

  /** Drop every entry bound to a registry address (e.g. on registry upgrade). */
  invalidateRegistry(registryAddress: string): void {
    for (const [cacheKey, entry] of this.entries) {
      if (entry.registry.address === registryAddress) this.entries.delete(cacheKey);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
