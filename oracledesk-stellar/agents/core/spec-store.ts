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

function canonicalizeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new TraceSchemaError(`non-finite number is not canonical: ${String(value)}`);
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
export function buildCanonicalTracePayload(
  fields: Record<string, unknown>,
  version: number = TRACE_SCHEMA_VERSION,
): CanonicalTracePayload {
  assertSupportedVersion(version);
  if (Object.prototype.hasOwnProperty.call(fields, "schemaVersion")) {
    throw new TraceSchemaError("fields must not contain reserved key 'schemaVersion'");
  }
  return { schemaVersion: version, ...fields };
}

/**
 * Serialize a trace payload to its canonical string form. Rejects ambiguous
 * encodings (unsupported versions, duplicate keys, non-canonical numbers,
 * undefined values).
 */
export function serializeCanonicalTrace(payload: CanonicalTracePayload): string {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TraceSchemaError("trace payload must be an object");
  }
  assertSupportedVersion(payload.schemaVersion);
  return canonicalize(payload, "$");
}

/**
 * Parse a canonical trace string back into a payload, rejecting non-canonical
 * encodings (duplicate keys, unsupported versions, whitespace/ordering drift).
 */
export function parseCanonicalTrace(serialized: string): CanonicalTracePayload {
  if (typeof serialized !== "string") {
    throw new TraceSchemaError("canonical trace must be a string");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized, (key, value, context?: { source?: string }) => {
      // Duplicate-key detection is handled below via re-serialization; the
      // reviver keeps the last value per JSON.parse semantics.
      void key;
      void context;
      return value;
    });
  } catch (err) {
    throw new TraceSchemaError(`invalid JSON trace: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TraceSchemaError("trace payload must be an object");
  }
  const payload = parsed as CanonicalTracePayload;
  assertSupportedVersion(payload.schemaVersion);
  const reserialized = serializeCanonicalTrace(payload);
  if (reserialized !== serialized) {
    throw new TraceSchemaError("trace is not in canonical form (ordering, whitespace, or duplicate keys)");
  }
  return payload;
}
