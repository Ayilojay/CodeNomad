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
// Transaction journal for uncertain submissions (#51)
//
// Before a transaction is sent, the agent records the intent (network, source
// account, and the transaction hash) together with a submission state. After
// sending, the state is updated. If the process restarts while a submission is
// in an uncertain state (e.g. `submitted` but not yet confirmed), the journal
// is reconciled by hash against chain state instead of blindly retrying.
//
// Operational notes:
// - The journal is persisted through a pluggable `TransactionJournalStore`.
//   The in-memory store is provided for tests and single-process agents;
//   durable deployments supply their own store.
// - The safe dry-run default is preserved: this module only records and
//   reconciles intents and never submits a transaction on-chain.
// - Reconciliation never blindly retries an unresolved intent. An intent whose
//   hash cannot be found on-chain is reported as `unresolved` and left for an
//   operator to inspect; it is never re-sent automatically.
// ---------------------------------------------------------------------------

/**
 * Submission state of a journaled transaction intent.
 *
 * - `pending`     recorded before sending; not yet submitted.
 * - `submitted`   sent to the network; outcome not yet known (uncertain).
 * - `confirmed`   found on-chain and successful.
 * - `failed`      found on-chain and failed.
 * - `unresolved`  reconciliation could not find the hash on-chain; never retried.
 */
export type TransactionSubmissionState =
  | "pending"
  | "submitted"
  | "confirmed"
  | "failed"
  | "unresolved";

export interface TransactionJournalEntry {
  /** Stable journal identifier. */
  id: string;
  /** Network passphrase the intent targets. */
  networkPassphrase: string;
  /** Source account (G... address) that signs the transaction. */
  sourceAccount: string;
  /** Hex-encoded transaction hash. */
  transactionHash: string;
  /** Current submission state. */
  state: TransactionSubmissionState;
  /** ISO timestamp when the intent was first recorded. */
  createdAt: string;
  /** ISO timestamp of the most recent state transition. */
  updatedAt: string;
}

/** Pluggable persistence for journal entries. */
export interface TransactionJournalStore {
  save(entry: TransactionJournalEntry): void;
  get(id: string): TransactionJournalEntry | undefined;
  list(): TransactionJournalEntry[];
}

/** In-memory journal store for tests and single-process agents. */
export class InMemoryTransactionJournalStore implements TransactionJournalStore {
  private readonly entries = new Map<string, TransactionJournalEntry>();

  save(entry: TransactionJournalEntry): void {
    this.entries.set(entry.id, { ...entry });
  }

  get(id: string): TransactionJournalEntry | undefined {
    const entry = this.entries.get(id);
    return entry ? { ...entry } : undefined;
  }

  list(): TransactionJournalEntry[] {
    return [...this.entries.values()].map((entry) => ({ ...entry }));
  }
}

/** Chain-state lookup used to reconcile an uncertain submission by hash. */
export interface ChainStateLookup {
  /**
   * Look up a transaction by hash on the given network.
   *
   * Returns `undefined` when the hash is not (yet) known on-chain, otherwise
   * the observed outcome.
   */
  lookup(
    networkPassphrase: string,
    transactionHash: string,
  ): Promise<{ success: boolean } | undefined>;
}

/** States that are considered uncertain and eligible for reconciliation. */
const UNCERTAIN_STATES: ReadonlySet<TransactionSubmissionState> = new Set([
  "pending",
  "submitted",
]);

export interface RecordIntentInput {
  id: string;
  networkPassphrase: string;
  sourceAccount: string;
  transactionHash: string;
}

/**
 * Persist a transaction intent before sending. The entry starts in the
 * `pending` state so a crash before submission is still recoverable.
 */
export function recordTransactionIntent(
  store: TransactionJournalStore,
  input: RecordIntentInput,
  now: Date = new Date(),
): TransactionJournalEntry {
  if (!input.id) throw new Error("journal id is required");
  if (!input.networkPassphrase) throw new Error("networkPassphrase is required");
  if (!input.sourceAccount) throw new Error("sourceAccount is required");
  if (!input.transactionHash) throw new Error("transactionHash is required");

  const timestamp = now.toISOString();
  const entry: TransactionJournalEntry = {
    id: input.id,
    networkPassphrase: input.networkPassphrase,
    sourceAccount: input.sourceAccount,
    transactionHash: input.transactionHash,
    state: "pending",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  store.save(entry);
  return entry;
}

/**
 * Update the submission state of a journaled intent after sending.
 *
 * Only forward transitions out of an uncertain state are permitted; a
 * `confirmed` or `failed` entry is terminal and cannot be re-opened.
 */
export function updateTransactionState(
  store: TransactionJournalStore,
  id: string,
  state: TransactionSubmissionState,
  now: Date = new Date(),
): TransactionJournalEntry {
  const existing = store.get(id);
  if (!existing) throw new Error(`journal entry not found: ${id}`);
  if (!UNCERTAIN_STATES.has(existing.state)) {
    throw new Error(
      `journal entry ${id} is terminal (${existing.state}); cannot transition to ${state}`,
    );
  }
  const updated: TransactionJournalEntry = {
    ...existing,
    state,
    updatedAt: now.toISOString(),
  };
  store.save(updated);
  return updated;
}

export interface ReconcileResult {
  /** Entries that were reconciled to a terminal state. */
  reconciled: TransactionJournalEntry[];
  /** Entries whose hash could not be found on-chain; never retried. */
  unresolved: TransactionJournalEntry[];
}

/**
 * Reconcile uncertain journal entries by hash against chain state.
 *
 * Entries in a terminal state are skipped. For each uncertain entry the hash
 * is looked up on-chain: a found transaction is reconciled to `confirmed` or
 * `failed`, while a missing transaction is marked `unresolved` and left for an
 * operator. Unresolved intents are never blindly retried.
 */
export async function reconcileTransactionJournal(
  store: TransactionJournalStore,
  lookup: ChainStateLookup,
  now: Date = new Date(),
): Promise<ReconcileResult> {
  const reconciled: TransactionJournalEntry[] = [];
  const unresolved: TransactionJournalEntry[] = [];

  for (const entry of store.list()) {
    if (!UNCERTAIN_STATES.has(entry.state)) continue;

    const observed = await lookup.lookup(entry.networkPassphrase, entry.transactionHash);
    const nextState: TransactionSubmissionState = observed
      ? observed.success
        ? "confirmed"
        : "failed"
      : "unresolved";

    const updated: TransactionJournalEntry = {
      ...entry,
      state: nextState,
      updatedAt: now.toISOString(),
    };
    store.save(updated);

    if (nextState === "unresolved") {
      unresolved.push(updated);
    } else {
      reconciled.push(updated);
    }
  }

  return { reconciled, unresolved };
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
  /** ISO timestamp after which the envelope is no longer valid. */
  expiresAt: string;
  /** Collected signatures keyed by hex-encoded participant public key. */
  signatures: Map<string, Uint8Array>;
}
