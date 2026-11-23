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
// Least-privilege signer policy generation (#67)
//
// A signer policy is generated from an explicit deployment/workflow manifest.
// Each manifest entry names a contract, a function, and the argument values
// that the agent is permitted to sign. The generator derives a stable argument
// hash for every entry and emits a signer allowlist keyed by
// (contract, function, argumentHash).
//
// Operational notes:
// - The manifest is explicit: nothing is permitted unless it appears in the
//   manifest. There is no wildcard or implicit allow.
// - The generated policy is a pure data structure. It never submits a
//   transaction and never bypasses on-chain risk controls; it only describes
//   which invocations an off-chain signer may authorize. The safe dry-run
//   default is preserved.
// - `diffSignerPolicy` renders a reviewable, line-oriented diff of each
//   contract/function/argument-hash entry so reviewers can inspect additions
//   and removals before a policy is adopted.
// ---------------------------------------------------------------------------

/** A single permitted invocation declared in a deployment/workflow manifest. */
export interface SignerPolicyManifestEntry {
  /** Contract address (C...) the invocation targets. */
  contract: string;
  /** Contract function name. */
  function: string;
  /** Argument values, in call order, that identify the invocation. */
  args: ReadonlyArray<string | number | bigint | boolean>;
}

/** Explicit deployment/workflow manifest consumed by the generator. */
export interface SignerPolicyManifest {
  entries: ReadonlyArray<SignerPolicyManifestEntry>;
}

/** A single allowlist rule keyed by contract, function, and argument hash. */
export interface SignerPolicyRule {
  contract: string;
  function: string;
  argumentHash: string;
}

/** Generated signer allowlist. */
export interface SignerPolicy {
  rules: ReadonlyArray<SignerPolicyRule>;
}

/** A single line in a reviewable signer policy diff. */
export interface SignerPolicyDiffLine {
  kind: "added" | "removed" | "unchanged";
  contract: string;
  function: string;
  argumentHash: string;
  /** Rendered diff line, e.g. `+ C...::buy(0xabc...)`. */
  text: string;
}

/**
 * Derive a stable argument hash for a manifest entry.
 *
 * Values are serialized with an explicit type tag so that e.g. the number `1`
 * and the string `"1"` do not collide. The hash is the hex-encoded sha256 of
 * the canonical serialization.
 */
export function hashSignerPolicyArgs(
  args: ReadonlyArray<string | number | bigint | boolean>,
): string {
  const canonical = args.map((arg) => {
    if (typeof arg === "bigint") return `bigint:${arg.toString()}`;
    if (typeof arg === "number") {
      if (!Number.isFinite(arg)) {
        throw new Error(`argument must be finite, got ${String(arg)}`);
      }
      return `number:${arg.toString()}`;
    }
    if (typeof arg === "boolean") return `boolean:${arg ? "true" : "false"}`;
    return `string:${arg}`;
  });
  return createHash("sha256").update(canonical.join("\u0000")).digest("hex");
}

function ruleKey(rule: SignerPolicyRule): string {
  return `${rule.contract}\u0000${rule.function}\u0000${rule.argumentHash}`;
}

/**
 * Generate a least-privilege signer allowlist from an explicit manifest.
 *
 * Duplicate entries collapse to a single rule. Entries with an empty contract
 * or function are rejected so a malformed manifest cannot silently widen the
 * allowlist.
 */
export function generateSignerPolicy(manifest: SignerPolicyManifest): SignerPolicy {
  const seen = new Set<string>();
  const rules: SignerPolicyRule[] = [];
  for (const entry of manifest.entries) {
    if (!entry.contract) {
      throw new Error("manifest entry is missing a contract address");
    }
    if (!entry.function) {
      throw new Error(`manifest entry for ${entry.contract} is missing a function name`);
    }
    const rule: SignerPolicyRule = {
      contract: entry.contract,
      function: entry.function,
      argumentHash: hashSignerPolicyArgs(entry.args),
    };
    const key = ruleKey(rule);
    if (seen.has(key)) continue;
    seen.add(key);
    rules.push(rule);
  }
  rules.sort((a, b) => ruleKey(a).localeCompare(ruleKey(b)));
  return { rules };
}

/**
 * Render a reviewable diff between two signer policies.
 *
 * Each contract/function/argument-hash entry is shown on its own line with a
 * `+` (added), `-` (removed), or ` ` (unchanged) prefix so reviewers can
 * inspect exactly what a policy change permits.
 */
export function diffSignerPolicy(
  previous: SignerPolicy,
  next: SignerPolicy,
): SignerPolicyDiffLine[] {
  const prevByKey = new Map(previous.rules.map((r) => [ruleKey(r), r]));
  const nextByKey = new Map(next.rules.map((r) => [ruleKey(r), r]));
  const allKeys = new Set<string>([...prevByKey.keys(), ...nextByKey.keys()]);

  const lines: SignerPolicyDiffLine[] = [];
  for (const key of [...allKeys].sort((a, b) => a.localeCompare(b))) {
    const prev = prevByKey.get(key);
    const nextRule = nextByKey.get(key);
    const rule = (nextRule ?? prev)!;
    const kind: SignerPolicyDiffLine["kind"] = nextRule && prev ? "unchanged" : nextRule ? "added" : "removed";
    const prefix = kind === "added" ? "+" : kind === "removed" ? "-" : " ";
    lines.push({
      kind,
      contract: rule.contract,
      function: rule.function,
      argumentHash: rule.argumentHash,
      text: `${prefix} ${rule.contract}::${rule.function}(${rule.argumentHash})`,
    });
  }
  return lines;
}

/**
 * Check whether an invocation is permitted by a generated signer policy.
 *
 * Returns `false` for any invocation not explicitly present in the allowlist,
 * including when the contract or function matches but the argument hash does
 * not.
 */
export function isSignerPolicyPermitted(
  policy: SignerPolicy,
  invocation: SignerPolicyManifestEntry,
): boolean {
  const argumentHash = hashSignerPolicyArgs(invocation.args);
  return policy.rules.some(
    (rule) =>
      rule.contract === invocation.contract &&
      rule.function === invocation.function &&
      rule.argumentHash === argumentHash,
  );
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
  /** ISO ti