/**
 * Production {@link TraceStore}: pins the exact trace bytes to IPFS and
 * returns a CID the agent computed and verified itself.
 *
 * The CID is a CIDv1 with the raw codec (0x55) and a sha2-256 multihash, so
 * its digest IS `sha256(bytes)` — the `trace_hash` published next to it in
 * reasoning-registry. Anyone can check CID ↔ hash without fetching anything,
 * and no pinning provider is trusted to name the content: a provider that
 * reports a different CID fails the whole put, because a wrong CID on-chain
 * is permanent. `put` resolves only once enough providers confirmed the pin
 * AND a gateway served bytes hashing to `trace_hash`. See
 * docs/architecture.md, "IPFS trace storage".
 *
 * ## Confidentiality / public-data boundary
 *
 * Everything this module produces is PUBLIC and permanent:
 * - the pinned bytes (anyone with the CID can fetch them from any gateway),
 * - the CID and its `trace_hash` (published on-chain in reasoning-registry),
 * - the gateway probe evidence returned by {@link TraceAvailabilityChecker}.
 *
 * Therefore trace content MUST NOT contain secrets (private keys, seed
 * phrases, API tokens, x402 payment signatures). Callers are responsible for
 * redacting before serialization; {@link assertNoSecrets} is a last-line
 * guard that refuses to pin bytes matching well-known secret shapes so a
 * leaked key can never become a permanent, content-addressed artifact.
 */
import { createHash } from "node:crypto";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import type { TraceStore } from "./trace.js";

/** One IPFS block: kubo's `chunker=size-1048576` keeps the root a raw leaf. */
export const MAX_TRACE_BYTES = 1024 * 1024;

/**
 * Patterns that must never appear in serialized trace bytes. These are
 * deliberately conservative: a false positive only blocks a pin (recoverable),
 * while a false negative would publish a secret permanently (unrecoverable).
 */
const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // Stellar secret seeds (S... 56 base32 chars).
  { name: "stellar-secret-seed", re: /\bS[A-Z2-7]{55}\b/ },
  // PEM-encoded private keys.
  { name: "pem-private-key", re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  // Common bearer / API token shapes.
  { name: "bearer-token", re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/ },
  { name: "api-key", re: /\b(?:api[_-]?key|secret[_-]?key|private[_-]?key)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{16,}/i },
];

/**
 * Throws {@link TraceStoreIntegrityError} when `bytes` contain a recognizable
 * secret. This is a guard, not a redactor: callers must redact before
 * serialization; this only prevents an accidental leak from being pinned.
 */
export function assertNoSecrets(bytes: Uint8Array): void {
  const text = Buffer.from(bytes).toString("utf8");
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(text)) {
      throw new TraceStoreIntegrityError(
        `refusing to pin trace: detected ${name} in serialized content; redact secrets before publishing`,
      );
    }
  }
}

export class TraceStoreIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TraceStoreIntegrityError";
  }
}

export interface PinAttempt {
  provider: string;
  attempt: number;
  ok: boolean;
  error?: string;
}

export class TracePinError extends Error {
  constructor(
    message: string,
    readonly attempts: PinAttempt[],
  ) {
    super(message);
    this.name = "TracePinError";
  }
}

export class TraceGatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TraceGatewayError";
  }
}

export async function rawCidForBytes(bytes: Uint8Array): Promise<{ cid: string; digestHex: string }> {
  const mh = await sha256.digest(bytes);
  return { cid: CID.createV1(raw.code, mh).toString(), digestHex: Buffer.from(mh.digest).toString("hex") };
}

/** CID equality by value (codec + multihash), not by string encoding. */
export function sameCid(a: string, b: string): boolean {
  try {
    return CID.parse(a).toV1().equals(CID.parse(b).toV1());
  } catch {
    return false;
  }
}

/**
 * Distinct, non-success outcomes when resolving indexed trace content through
 * the independent verifier. `unavailable` means the content could not be
 * fetched at all; `hash-mismatch` means bytes were served but did not hash to
 * the expected `trace_hash`/CID. Neither is ever treated as success.
 */
export type TraceContentStatus = "verified" | "unavailable" | "hash-mismatch";

export interface TraceContentResult {
  status: TraceContentStatus;
  /** CID the indexer referenced for this trace event. */
  cid: string;
  /** `trace_hash` published on-chain next to the CID. */
  traceHash: string;
  /** Present only when `status === "verified"`. */
  bytes?: Uint8Array;
  /** Human-readable detail for non-verified states. */
  reason?: string;
}

/**
 * Resolves trace content for an indexed event by fetching through the
 * independent verifier and checking the served bytes against the expected
 * `trace_hash`. Never trusts indexed data: a mismatch is reported as
 * `hash-mismatch`, a fetch failure as `unavailable`.
 */
export async function resolveVerifiedTraceContent(
  verifier: { fetch(cid: string, signal?: AbortSignal): Promise<Uint8Array> },
  ref: { cid: string; traceHash: string },
  signal?: AbortSignal,
): Promise<TraceContentResult> {
  let bytes: Uint8Array;
  try {
    bytes = await verifier.fetch(ref.cid, signal);
  } catch (err) {
    return { status: "unavailable", cid: ref.cid, traceHash: ref.traceHash, reason: errorText(err) };
  }
  const digestHex = createHash("sha256").update(bytes).digest("hex");
  if (digestHex !== ref.traceHash.toLowerCase()) {
    return {
      status: "hash-mismatch",
      cid: ref.cid,
      traceHash: ref.traceHash,
      reason: `served bytes hash to ${digestHex}, expected ${ref.traceHash}`,
    };
  }
  return { status: "verified", cid: ref.cid, traceHash: ref.traceHash, bytes };
}

/**
 * A single gateway probe outcome. `available` means the gateway served bytes
 * hashing to the expected `trace_hash`; `missing` means the gateway could not
 * serve the content; `tampered` means bytes were served but did not match.
 */
export type GatewayProbeStatus = "available" | "missing" | "tampered";

export interface GatewayProbeResult {
  gateway: string;
  status: GatewayProbeStatus;
  /** HTTP status when the gateway responded, if any. */
  httpStatus?: number;
  /** Human-readable detail for non-available states. */
  reason?: string;
}

export interface TraceAvailabilityEvidence {
  cid: string;
  traceHash: string;
  /** True when at least one gateway served bytes matching `traceHash`. */
  available: boolean;
  /** True when any gateway served bytes that did not match `traceHash`. */
  tampered: boolean;
  probes: GatewayProbeResult[];
  checkedAt: string;
}

export interface TraceAvailabilityCheckerOptions {
  /** Gateway base URLs, e.g. `https://ipfs.io/ipfs/`. */
  gateways: string[];
  /** Per-gateway fetch timeout in milliseconds. */
  timeoutMs?: number;
  /** Injectable fetch for deterministic tests. */
  fetchImpl?: typeof fetch;
}

function gatewayUrl(base: string, cid: string): string {
  return `${base.replace(/\/+$/, "")}/${cid}`;
}

/**
 * Samples trace CIDs across configurable IPFS gateways and verifies the served
 * bytes against the on-chain `trace_hash`. Read-only: it never rewrites
 * registry data, it only records availability evidence and reports failures.
 */
export class TraceAvailabilityChecker {
  private readonly gateways: string[];
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(o: TraceAvailabilityCheckerOptions) {
    if (!o.gateways.length) throw new TraceGatewayError("at least one gateway is required");
    this.gateways = o.gateways;
    this.timeoutMs = o.timeoutMs ?? 10_000;
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  private async probe(gateway: string, ref: { cid: string; traceHash: string }): Promise<GatewayProbeResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(gatewayUrl(gateway, ref.cid), { signal: controller.signal });
      if (!res.ok) {
        return { gateway, status: "missing", httpStatus: res.status, reason: `HTTP ${res.status}` };
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      const digestHex = createHash("sha256").update(bytes).digest("hex");
      if (digestHex !== ref.traceHash.toLowerCase()) {
        return {
          gateway,
          status: "tampered",
          httpStatus: res.status,
          reason: `served bytes hash to ${digestHex}, expected ${ref.traceHash}`,
        };
      }
      return { gateway, status: "available", httpStatus: res.status };
    } catch (err) {
      return { gateway, status: "missing", reason: errorText(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Probes every configured gateway for one trace reference and returns the
   * aggregated availability evidence. Never throws on gateway failures.
   */
  async check(ref: { cid: string; traceHash: string }): Promise<TraceAvailabilityEvidence> {
    const probes = await Promise.all(this.gateways.map((g) => this.probe(g, ref)));
    return {
      cid: ref.cid,
      traceHash: ref.traceHash,
      available: probes.some((p) => p.status === "available"),
      tampered: probes.some((p) => p.status === "tampered"),
      probes,
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * Samples a batch of trace references, returning evidence for each. Failures
   * are reported in the evidence, never thrown, so a scheduled run completes.
   */
  async sample(refs: Array<{ cid: string; traceHash: string }>): Promise<TraceAvailabilityEvidence[]> {
    return Promise.all(refs.map((ref) => this.check(ref)));
  }
}

export interface PinResult {
  cid: string;
  traceHash: string;
  providers: string[];
}

export interface TraceStoreOptions {
  /** Pinning provider base URLs, e.g. `https://api.pinata.cloud/pinning/pinFileToIPFS`. */
  providers: string[];
  /** Minimum providers that must confirm the pin before `put` resolves. */
  minConfirmations?: number;
  /** Gateway base URLs used to verify the pinned bytes are retrievable. */
  gateways: string[];
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** Injectable fetch for deterministic tests. */
  fetchImpl?: typeof fetch;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Pins trace bytes to IPFS and returns the self-computed CID. Refuses to pin
 * bytes that exceed {@link MAX_TRACE_BYTES} or that contain recognizable
 * secrets (see {@link assertNoSecrets}); both are permanent, unrecoverable
 * outcomes once published.
 */
export class IpfsTraceStore implements TraceStore {
  private readonly providers: string[];
  private readonly minConfirmations: number;
  private readonly gateways: string[];
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(o: TraceStoreOptions) {
    if (!o.providers.length) throw new TracePinError("at least one pinning provider is required", []);
    if (!o.gateways.length) throw new TraceGatewayError("at least one gateway is required");
    this.providers = o.providers;
    this.minConfirmations = o.minConfirmations ?? 1;
    this.gateways = o.gateways;
    this.timeoutMs = o.timeoutMs ?? 30_000;
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  async put(bytes: Uint8Array): Promise<PinResult> {
    if (bytes.byteLength > MAX_TRACE_BYTES) {
      throw new TraceStoreIntegrityError(
        `trace is ${bytes.byteLength} bytes, exceeds MAX_TRACE_BYTES (${MAX_TRACE_BYTES})`,
      );
    }
    assertNoSecrets(bytes);
    const { cid, digestHex } = await rawCidForBytes(bytes);
    const attempts: PinAttempt[] = [];
    const confirmed: string[] = [];
    for (const provider of this.providers) {
      const attempt = await this.pin(provider, bytes, cid, attempts.length + 1);
      attempts.push(attempt);
      if (attempt.ok) confirmed.push(provider);
    }
    if (confirmed.length < this.minConfirmations) {
      throw new TracePinError(
        `only ${confirmed.length}/${this.minConfirmations} providers confirmed pin for ${cid}`,
        attempts,
      );
    }
    const checker = new TraceAvailabilityChecker({
      gateways: this.gateways,
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
    });
    const evidence = await checker.check({ cid, traceHash: digestHex });
    if (!evidence.available) {
      throw new TraceGatewayError(`pinned ${cid} but no gateway served matching bytes`);
    }
    return { cid, traceHash: digestHex, providers: confirmed };
  }

  private async pin(provider: string, bytes: Uint8Array, cid: string, attempt: number): Promise<PinAttempt> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(provider, {
        method: "POST",
        body: bytes,
        signal: controller.signal,
      });
      if (!res.ok) {
        return { provider, attempt, ok: false, error: `HTTP ${res.status}` };
      }
      const body = (await res.json().catch(() => ({}))) as { cid?: string; Hash?: string };
      const reported = body.cid ?? body.Hash;
      if (reported && !sameCid(reported, cid)) {
        return { provider, attempt, ok: false, error: `provider reported CID ${reported}, expected ${cid}` };
      }
      return { provider, attempt, ok: true };
    } catch (err) {
      return { provider, attempt, ok: false, error: errorText(err) };
    } finally {
      clearTimeout(timer);
    }
  }
}
