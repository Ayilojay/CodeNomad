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
// Multisig transaction signing coordination (#69)
//
// A multisig envelope binds a set of participants to a single transaction
// payload via a payload hash. Signatures are collected incrementally until a
// threshold is reached. The coordinator enforces:
//
// - Bounded collection: at most `participants.length` signatures are accepted
//   and the threshold must be a positive integer no greater than the number of
//   participants.
// - Duplicate rejection: a participant may only contribute one signature per
//   envelope; a second submission from the same participant is rejected.
// - Payload binding: every signature is verified against the envelope's payload
//   hash, so an altered payload (or a signature produced for a different
//   payload) is rejected.
// - Expiry: envelopes carry an explicit `expiresAt` timestamp. Stale or expired
//   envelopes are rejected on submission and reported as `expired` in status.
// - Status reporting never discloses participant secrets: only public keys and
//   the set of participants that have signed are exposed.
//
// Operational notes:
// - Envelopes are persisted through a pluggable `MultisigEnvelopeStore`. The
//   in-memory store is provided for tests and single-process agents; durable
//   deployments supply their own store.
// - The safe dry-run default is preserved: this module only coordinates
//   signatures and never submits a transaction on-chain.
// ---------------------------------------------------------------------------

/** Default envelope lifetime in milliseconds (10 minutes). */
export const DEFAULT_MULTISIG_ENVELOPE_TTL_MS = 10 * 60 * 1000;

const MULTISIG_DOMAIN = Buffer.from("oracledesk-multisig-v1", "ascii");

export interface MultisigEnvelope {
  /** Stable envelope identifier. */
  id: string;
  /** Participant public keys (32-byte Ed25519) authorized to sign. */
  participants: Uint8Array[];
  /** Number of distinct signatures required to complete the envelope. */
  threshold: number;
  /** Raw transaction payload being signed. */
  payload: Uint8Array;
  /** sha256(payload), used to bind signatures to the exact payload. */
  payloadHash: Uint8Array;
  /** Absolute expiry timestamp in milliseconds since epoch. */
  expiresAt: number;
  /** Collected signatures keyed by hex-encoded participant public key. */
  signatures: Map<string, Uint8Array>;
}

export type MultisigStatus = "pending" | "complete" | "expired";

export interface MultisigStatusReport {
  id: string;
  status: MultisigStatus;
  threshold: number;
  /** Hex-encoded public keys of participants that have signed. */
  signedBy: string[];
  /** Hex-encoded public keys of participants that have not yet signed. */
  pending: string[];
  expiresAt: number;
}

/** Durable envelope store. Implementations must persist before resolving. */
export interface MultisigEnvelopeStore {
  save(envelope: MultisigEnvelope): Promise<void> | void;
  load(id: string): Promise<MultisigEnvelope | undefined> | MultisigEnvelope | undefined;
}

/** Simple in-memory store for tests and single-process agents. */
export class InMemoryMultisigEnvelopeStore implements MultisigEnvelopeStore {
  private readonly envelopes = new Map<string, MultisigEnvelope>();

  save(envelope: MultisigEnvelope): void {
    this.envelopes.set(envelope.id, envelope);
  }

  load(id: string): MultisigEnvelope | undefined {
    return this.envelopes.get(id);
  }
}

function hexKey(publicKey: Uint8Array): string {
  return Buffer.from(publicKey).toString("hex");
}

function hashPayload(payload: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(Buffer.from(payload)).digest());
}

function buildMultisigMessage(payloadHash: Uint8Array): Buffer {
  if (payloadHash.length !== 32) {
    throw new Error(`payloadHash must be 32 bytes, got ${payloadHash.length}`);
  }
  return Buffer.concat([MULTISIG_DOMAIN, Buffer.from(payloadHash)]);
}

export interface CreateMultisigEnvelopeParams {
  id: string;
  participants: Uint8Array[];
  threshold: number;
  payload: Uint8Array;
  /** Absolute expiry timestamp in ms. Defaults to now + DEFAULT_MULTISIG_ENVELOPE_TTL_MS. */
  expiresAt?: number;
  /** Current time in ms; injectable for tests. */
  now?: number;
}

export function createMultisigEnvelope(params: CreateMultisigEnvelopeParams): MultisigEnvelope {
  const now = params.now ?? Date.now();
  const expiresAt = params.expiresAt ?? now + DEFAULT_MULTISIG_ENVELOPE_TTL_MS;
  if (!Number.isInteger(params.threshold) || params.threshold <= 0) {
    throw new Error(`threshold must be a positive integer, got ${params.threshold}`);
  }
  if (params.threshold > params.participants.length) {
    throw new Error(
      `threshold ${params.threshold} exceeds participant count ${params.participants.length}`,
    );
  }
  const seen = new Set<string>();
  for (const p of params.participants) {
    if (p.length !== 32) {
      throw new Error(`participant public key must be 32 bytes, got ${p.length}`);
    }
    const k = hexKey(p);
    if (seen.has(k)) {
      throw new Error(`duplicate participant ${k}`);
    }
    seen.add(k);
  }
  if (expiresAt <= now) {
    throw new Error(`expiresAt ${expiresAt} must be in the future (now ${now})`);
  }
  return {
    id: params.id,
    participants: params.participants.map((p) => new Uint8Array(p)),
    threshold: params.threshold,
    payload: new Uint8Array(params.payload),
    payloadHash: hashPayload(params.payload),
    expiresAt,
    signatures: new Map(),
  };
}

/**
 * Sign the multisig message for an envelope's payload hash. The returned
 * signature is bound to the payload hash, so it cannot be replayed against a
 * different payload.
 */
export function signMultisigPayload(
  keypair: Keypair,
  payloadHash: Uint8Array,
): AttestationSignature {
  const pubkey = new Uint8Array(keypair.rawPublicKey());
  const msg = buildMultisigMessage(payloadHash);
  const sig = new Uint8Array(keypair.sign(msg));
  return { publicKey: pubkey, signature: sig };
}

function verifyMultisigSignature(
  publicKey: Uint8Array,
  signature: Uint8Array,
  payloadHash: Uint8Array,
): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  const s = BigInt(`0x${Buffer.from(signature.slice(32)).reverse().toString("hex")}`);
  if (s >= GROUP_ORDER) return false;
  const msg = buildMultisigMessage(payloadHash);
  const key = Keypair.fromPublicKey(StrKey.encodeEd25519PublicKey(Buffer.from(publicKey)));
  return key.verify(msg, Buffer.from(signature));
}

export interface SubmitMultisigSignatureParams {
  envelope: MultisigEnvelope;
  publicKey: Uint8Array;
  signature: Uint8Array;
  /** Current time in ms; injectable for tests. */
  now?: number;
}

/**
 * Validate and record a participant signature on an envelope. Throws on any
 * rejection (expired envelope, unknown participant, duplicate signature,
 * altered payload / invalid signature). Returns the updated envelope.
 */
export function submitMultisigSignature(
  params: SubmitMultisigSignatureParams,
): MultisigEnvelope {
  const now = params.now ?? Date.now();
  const { envelope } = params;
  if (now >= envelope.expiresAt) {
    throw new Error(`envelope ${envelope.id} expired at ${envelope.expiresAt}`);
  }
  const key = hexKey(params.publicKey);
  const isParticipant = envelope.participants.some((p) => hexKey(p) === key);
  if (!isParticipant) {
    throw new Error(`public key ${key} is not a participant of envelope ${envelope.id}`);
  }
  if (envelope.signatures.has(key)) {
    throw new Error(`duplicate signature from participant ${key}`);
  }
  if (envelope.signatures.size >= envelope.participants.length) {
    throw new Error(`envelope ${envelope.id} already has the maximum number of signatures`);
  }
  if (!verifyMultisigSignature(params.publicKey, params.signature, envelope.payloadHash)) {
    throw new Error(`invalid signature from participant ${key} (payload mismatch or bad signature)`);
  }
  envelope.signatures.set(key, new Uint8Array(params.signature));
  return envelope;
}

/**
 * Report envelope status without disclosing participant secrets. Only public
 * keys and the set of signers are exposed.
 */
export function getMultisigStatus(
  envelope: MultisigEnvelope,
  now: number = Date.now(),
): MultisigStatusReport {
  const signedBy: string[] = [];
  const pending: string[] = [];
  for (const p of envelope.participants) {
    const k = hexKey(p);
    if (envelope.signatures.has(k)) {
      signedBy.push(k);
    } else {
      pending.push(k);
    }
  }
  let status: MultisigStatus;
  if (now >= envelope.expiresAt) {
    status = "expired";
  } else if (envelope.signatures.size >= envelope.threshold) {
    status = "complete";
  } else {
    status = "pending";
  }
  return {
    id: envelope.id,
    status,
    threshold: envelope.threshold,
    signedBy,
    pending,
    expiresAt: envelope.expiresAt,
  };
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
  record(entry: SigningAuditRecord): Promise<void> | void;
}
