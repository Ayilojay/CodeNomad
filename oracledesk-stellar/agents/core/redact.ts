const SENSITIVE_KEY =
  /(?:secret|private.?key|seed|password|passphrase|token|authorization|credential|api.?key|access.?key|signature|signed.?xdr|envelope.?xdr)/i;
const STELLAR_SECRET = /\bS[A-Z2-7]{55}\b/g;
const PEM_PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const QUERY_SECRET = /([?&](?:token|secret|key|api[_-]?key|password|signature)=)[^&#\s]+/gi;

export const REDACTED = "[REDACTED]";

/**
 * Confidentiality boundaries for reasoning-registry traces.
 *
 * Public (safe to publish):
 * - On-chain registry metadata: agent id, reasoning CID, timestamp, hashes.
 * - IPFS CID itself (content-addressed pointer, not the payload).
 * - x402 response envelopes: status, price, payment proof references.
 * - Structured logs after redaction is applied.
 *
 * Private (must never be serialized into traces):
 * - Stellar secret keys (S...), PEM private keys, bearer tokens, credentials.
 * - Query-string secrets (token/secret/key/password/signature).
 * - Raw buffers and any field whose key matches SENSITIVE_KEY.
 *
 * Encryption boundary: trace payloads are redacted before serialization; any
 * content that must remain confidential is encrypted off-chain and only its
 * CID is published. Redaction is the last line of defense, not a substitute
 * for encryption.
 */
export const PUBLIC_TRACE_FIELDS = [
  "agentId",
  "reasoningCid",
  "timestamp",
  "contentHash",
] as const;

export function redactString(value: string): string {
  return value
    .replace(STELLAR_SECRET, REDACTED)
    .replace(PEM_PRIVATE_KEY, REDACTED)
    .replace(BEARER, "Bearer [REDACTED]")
    .replace(QUERY_SECRET, `$1${REDACTED}`);
}

export function redact<T>(value: T): T {
  const visited = new WeakMap<object, unknown>();
  const visit = (current: unknown, key?: string): unknown => {
    if (key && SENSITIVE_KEY.test(key)) return REDACTED;
    if (typeof current === "string") return redactString(current);
    if (current === null || typeof current !== "object") return current;
    if (Buffer.isBuffer(current)) return REDACTED;
    const cached = visited.get(current);
    if (cached !== undefined) return cached;
    if (Array.isArray(current)) {
      const copy: unknown[] = [];
      visited.set(current, copy);
      for (const item of current) copy.push(visit(item));
      return copy;
    }
    const copy: Record<string, unknown> = {};
    visited.set(current, copy);
    for (const [childKey, child] of Object.entries(current)) {
      copy[childKey] = visit(child, childKey);
    }
    return copy;
  };
  return visit(value) as T;
}

/**
 * Serialize a trace for publication, applying redaction first so secrets and
 * private keys never enter the serialized output.
 */
export function serializeTrace(value: unknown): string {
  return JSON.stringify(redact(value));
}
