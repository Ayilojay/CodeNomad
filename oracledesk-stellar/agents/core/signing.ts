/**
 * Off-chain Ed25519 agent key binding and trace attestations (#53).
 *
 * An agent binds dedicated Ed25519 signing keys to their registered address
 * with on-chain proof of possession, and signs domain-separated trace attestations
 * that can be verified independently by any consumer offline without trusting
 * the registry admin.
 *
 * Byte layout for key binding message:
 *   "oracledesk-agent-key-v1"               23 ASCII bytes, domain tag
 *   || network_id                           32 bytes, sha256(network passphrase)
 *   || ScVal-XDR(registry contract address) 40 bytes for a C... address
 *   || ScVal-XDR(agent address)             36 bytes for G... or 40 bytes for C...
 *   || public_key                           32 bytes raw Ed25519 public key
 *
 * Byte layout for trace attestation message:
 *   "oracledesk-trace-v1"                   19 ASCII bytes, domain tag
 *   || network_id                           32 bytes, sha256(network passphrase)
 *   || ScVal-XDR(registry contract address) 40 bytes for a C... address
 *   || ScVal-XDR(agent address)             36 bytes for G... or 40 bytes for C...
 *   || market_id                            u64 big-endian (8 bytes)
 *   || action_tag                           1 byte (0..7 canonical, 8 Other + sym XDR)
 *   || trace_hash                           32 bytes
 */

import { createHash } from "node:crypto";
import { Address, Keypair, StrKey, xdr } from "@stellar/stellar-sdk";
import { toTraceAction, type TraceActionString, type TraceActionType } from "./trace.js";

const KEY_BIND_DOMAIN = Buffer.from("oracledesk-agent-key-v1", "ascii");
const TRACE_SIG_DOMAIN = Buffer.from("oracledesk-trace-v1", "ascii");

/** Order of the Ed25519 base-point subgroup. */
const GROUP_ORDER = (1n << 252n) + 27742317777372353535851937790883648493n;

export function actionToAttestationBytes(action: TraceActionType | TraceActionString): Buffer {
  const act = typeof action === "string" ? toTraceAction(action) : action;
  switch (act.tag) {
    case "CreateMarket":
      return Buffer.from([0]);
    case "ProposeMarket":
      return Buffer.from([1]);
    case "Buy":
      return Buffer.from([2]);
    case "Sell":
      return Buffer.from([3]);
    case "Skip":
      return Buffer.from([4]);
    case "Redeem":
      return Buffer.from([5]);
    case "ClaimRemainder":
      return Buffer.from([6]);
    case "Resolve":
      return Buffer.from([7]);
    case "Other": {
      const symScVal = xdr.ScVal.scvSymbol(act.values[0]);
      return Buffer.concat([Buffer.from([8]), symScVal.toXDR()]);
    }
  }
}

export interface KeyBindContext {
  networkPassphrase: string;
  registryId: string;
  agent: string;
  publicKey: Uint8Array;
}

export interface TraceAttestationContext {
  networkPassphrase: string;
  registryId: string;
  agent: string;
  marketId: bigint;
  action: TraceActionType | TraceActionString;
  traceHash: Uint8Array;
}

export interface AttestationSignature {
  publicKey: Uint8Array;
  signature: Uint8Array;
}

export function buildKeyBindMessage(ctx: KeyBindContext): Uint8Array {
  if (ctx.publicKey.length !== 32) {
    throw new Error(`publicKey must be 32 bytes, got ${ctx.publicKey.length}`);
  }
  return Buffer.concat([
    KEY_BIND_DOMAIN,
    createHash("sha256").update(ctx.networkPassphrase).digest(),
    Address.fromString(ctx.registryId).toScVal().toXDR(),
    Address.fromString(ctx.agent).toScVal().toXDR(),
    Buffer.from(ctx.publicKey),
  ]);
}

export function buildTraceAttestationMessage(ctx: TraceAttestationContext): Uint8Array {
  if (ctx.traceHash.length !== 32) {
    throw new Error(`traceHash must be 32 bytes, got ${ctx.traceHash.length}`);
  }
  const marketIdBuf = Buffer.alloc(8);
  marketIdBuf.writeBigUInt64BE(ctx.marketId);
  const actionBuf = actionToAttestationBytes(ctx.action);

  return Buffer.concat([
    TRACE_SIG_DOMAIN,
    createHash("sha256").update(ctx.networkPassphrase).digest(),
    Address.fromString(ctx.registryId).toScVal().toXDR(),
    Address.fromString(ctx.agent).toScVal().toXDR(),
    marketIdBuf,
    actionBuf,
    Buffer.from(ctx.traceHash),
  ]);
}

export function signKeyBind(
  keypair: Keypair,
  ctx: Omit<KeyBindContext, "publicKey">,
): AttestationSignature {
  const pubkey = new Uint8Array(keypair.rawPublicKey());
  const msg = buildKeyBindMessage({ ...ctx, publicKey: pubkey });
  const sig = new Uint8Array(keypair.sign(Buffer.from(msg)));
  return { publicKey: pubkey, signature: sig };
}

export function verifyKeyBind(
  publicKey: Uint8Array,
  signature: Uint8Array,
  ctx: Omit<KeyBindContext, "publicKey">,
): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  const s = BigInt(`0x${Buffer.from(signature.slice(32)).reverse().toString("hex")}`);
  if (s >= GROUP_ORDER) return false;
  const msg = Buffer.from(buildKeyBindMessage({ ...ctx, publicKey }));
  const key = Keypair.fromPublicKey(StrKey.encodeEd25519PublicKey(Buffer.from(publicKey)));
  return key.verify(msg, Buffer.from(signature));
}

export function signTraceAttestation(
  keypair: Keypair,
  ctx: TraceAttestationContext,
): AttestationSignature {
  const pubkey = new Uint8Array(keypair.rawPublicKey());
  const msg = buildTraceAttestationMessage(ctx);
  const sig = new Uint8Array(keypair.sign(Buffer.from(msg)));
  return { publicKey: pubkey, signature: sig };
}

export function verifyTraceAttestation(
  publicKey: Uint8Array,
  signature: Uint8Array,
  ctx: TraceAttestationContext,
): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  const s = BigInt(`0x${Buffer.from(signature.slice(32)).reverse().toString("hex")}`);
  if (s >= GROUP_ORDER) return false;
  const msg = Buffer.from(buildTraceAttestationMessage(ctx));
  const key = Keypair.fromPublicKey(StrKey.encodeEd25519PublicKey(Buffer.from(publicKey)));
  return key.verify(msg, Buffer.from(signature));
}

// ---------------------------------------------------------------------------
// Remote signing service operational controls (#68)
//
// These helpers harden a remote signing endpoint without weakening the safe
// dry-run default or bypassing on-chain risk controls. They are transport
// agnostic: an HTTP handler wires them together, but the policy lives here so
// it can be unit tested in isolation.
//
// Operational notes:
// - Authentication is default-deny: a request is only authorized when an
//   authenticator is configured AND it returns true. Missing/empty credentials
//   are rejected before any signing work happens.
// - Requests are bounded by both a byte-size cap and a wall-clock timeout.
// - Replay protection rejects any request whose nonce was already seen within
//   the retention window.
// - Every signing attempt is recorded through a durable audit sink. If the
//   audit sink fails, the request is denied (fail-closed) so no signature is
//   ever produced without a durable record.
// - Secrets and raw signing material are never logged or echoed in errors.
// ---------------------------------------------------------------------------

/** Default maximum accepted request body size in bytes (16 KiB). */
export const DEFAULT_MAX_REQUEST_BYTES = 16 * 1024;
/** Default wall-clock timeout for a signing request in milliseconds. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
/** Default replay nonce retention window in milliseconds (5 minutes). */
export const DEFAULT_REPLAY_WINDOW_MS = 5 * 60 * 1000;

export interface SigningRequest {
  /** Opaque caller credential (e.g. bearer token). Never logged. */
  credential?: string;
  /** Unique per-request nonce used for replay protection. */
  nonce: string;
  /** Serialized request payload; size is bounded by maxRequestBytes. */
  payload: Uint8Array;
}

export interface SigningAuditRecord {
  nonce: string;
  outcome: "signed" | "denied" | "error";
  reason?: string;
  timestamp: number;
}

/** Durable audit sink. Implementations must persist records before resolving. */
export interface SigningAuditSink {
  record(entry: SigningAuditRecord): Promise<void>;
}

/** Authentication hook. Return true only for a valid, authorized caller. */
export type SigningAuthenticator = (credential: string | undefined) => boolean | Promise<boolean>;

export interface SigningServiceOptions {
  /** Authentication hook. When absent, all requests are denied (default-deny). */
  authenticate?: SigningAuthenticator;
  /** Durable audit sink. When absent, all requests are denied (fail-closed). */
  audit?: SigningAuditSink;
  maxRequestBytes?: number;
  requestTimeoutMs?: number;
  replayWindowMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

export type SigningOutcome =
  | { ok: true; signature: AttestationSignature }
  | { ok: false; status: number; reason: string };

/**
 * Bounded, replay-safe, audited remote signing service.
 *
 * The caller supplies a `sign` function that performs the actual attestation
 * signing; this wrapper enforces operational controls around it. The wrapper
 * never logs or returns the credential or raw signing material.
 */
export class RemoteSigningService {
  private readonly authenticate?: SigningAuthenticator;
  private readonly audit?: SigningAuditSink;
  private readonly maxRequestBytes: number;
  private readonly requestTimeoutMs: number;
  private readonly replayWindowMs: number;
  private readonly now: () => number;
  private readonly seenNonces = new Map<string, number>();

  constructor(options: SigningServiceOptions = {}) {
    this.authenticate = options.authenticate;
    this.audit = options.audit;
    this.maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.replayWindowMs = options.replayWindowMs ?? DEFAULT_REPLAY_WINDOW_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** Readiness check: service is ready only when auth and audit are wired. */
  isReady(): boolean {
    return typeof this.authenticate === "function" && typeof this.audit === "object" && this.audit !== null;
  }

  async handle(
    request: SigningRequest,
    sign: (payload: Uint8Array) => AttestationSignature | Promise<AttestationSignature>,
  ): Promise<SigningOutcome> {
    const timestamp = this.now();

    // Default-deny: no authenticator configured means nothing is authorized.
    if (typeof this.authenticate !== "function") {
      return this.deny(request, timestamp, 401, "authentication not configured");
    }

    // Bounded request size.
    if (!request.payload || request.payload.length > this.maxRequestBytes) {
      return this.deny(request, timestamp, 413, "request too large");
    }

    // Replay handling: reject empty or previously seen nonces.
    if (!request.nonce || this.isReplay(request.nonce, timestamp)) {
      return this.deny(request, timestamp, 409, "replayed or missing nonce");
    }

    // Authentication failure is denied before any signing work.
    let authorized = false;
    try {
      authorized = await this.authenticate(request.credential);
    } catch {
      authorized = false;
    }
    if (!authorized) {
      return this.deny(request, timestamp, 401, "unauthorized");
    }

    // Record the nonce only after auth so unauthenticated probes cannot poison it.
    this.rememberNonce(request.nonce, timestamp);

    // Bounded wall-clock timeout around the signing operation.
    let signature: AttestationSignature;
    try {
      signature = await this.withTimeout(Promise.resolve().then(() => sign(request.payload)));
    } catch (err) {
      const reason = err instanceof Error && err.message === "timeout" ? "timeout" : "signing failed";
      const status = reason === "timeout" ? 504 : 500;
      return this.deny(request, timestamp, status, reason);
    }

    // Fail-closed audit: a signature is only returned if the audit record persists.
    const audited = await this.recordAudit({ nonce: request.nonce, outcome: "signed", timestamp });
    if (!audited) {
      return { ok: false, status: 503, reason: "audit unavailable" };
    }

    return { ok: true, signature };
  }

  private isReplay(nonce: string, timestamp: number): boolean {
    this.pruneNonces(timestamp);
    return this.seenNonces.has(nonce);
  }

  private rememberNonce(nonce: string, timestamp: number): void {
    this.seenNonces.set(nonce, timestamp);
  }

  private pruneNonces(timestamp: number): void {
    const cutoff = timestamp - this.replayWindowMs;
    for (const [nonce, seenAt] of this.seenNonces) {
      if (seenAt < cutoff) this.seenNonces.delete(nonce);
    }
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), this.requestTimeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  private async recordAudit(entry: SigningAuditRecord): Promise<boolean> {
    if (!this.audit) return false;
    try {
      await this.audit.record(entry);
      return true;
    } catch {
      return false;
    }
  }

  private async deny(
    request: SigningRequest,
    timestamp: number,
    status: number,
    reason: string,
  ): Promise<SigningOutcome> {
    // Best-effort audit of denials; never block the deny path on audit failure.
    await this.recordAudit({ nonce: request.nonce ?? "", outcome: "denied", reason, timestamp });
    return { ok: false, status, reason };
  }
}
