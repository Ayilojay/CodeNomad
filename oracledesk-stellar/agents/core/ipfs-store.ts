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
 * Retention & archival (issue #39): on-chain metadata, signed traces and
 * Merkle batches are retained for the lifetime of the registry contract
 * (Soroban TTL is extended by the registry). Referenced off-chain content is
 * retained only while pinned; {@link buildArchiveManifest} produces a
 * deterministic, hash-verifiable manifest of a batch's content so operators
 * can archive and later restore it. See {@link verifyArchiveManifest} and
 * {@link restoreFromArchive} for the recovery procedure when a gateway is
 * unavailable.
 */
import { createHash } from "node:crypto";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import type { TraceStore } from "./trace.js";

/** One IPFS block: kubo's `chunker=size-1048576` keeps the root a raw leaf. */
export const MAX_TRACE_BYTES = 1024 * 1024;

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
 * One archived trace reference inside an {@link ArchiveManifest}. `cid` and
 * `traceHash` are the on-chain values; `bytes` is the archived content.
 */
export interface ArchiveEntry {
  cid: string;
  traceHash: string;
  bytes: Uint8Array;
}

/**
 * Deterministic, hash-verifiable manifest of a trace batch's referenced
 * content. Entries are sorted by CID so the manifest is stable regardless of
 * input order; `manifestHash` is `sha256` over the canonical JSON of the
 * sorted `{cid, traceHash}` list, so it can be recomputed and compared
 * without trusting the archive.
 */
export interface ArchiveManifest {
  version: 1;
  batchId: string;
  entries: { cid: string; traceHash: string }[];
  manifestHash: string;
}

function canonicalManifestPayload(batchId: string, entries: { cid: string; traceHash: string }[]): string {
  return JSON.stringify({ version: 1, batchId, entries });
}

/**
 * Builds a deterministic archive manifest for a batch. Entries are sorted by
 * CID and each `traceHash` is checked against the archived bytes, so a
 * manifest can never describe content that does not match its hash.
 */
export function buildArchiveManifest(batchId: string, entries: ArchiveEntry[]): ArchiveManifest {
  const sorted = [...entries].sort((a, b) => (a.cid < b.cid ? -1 : a.cid > b.cid ? 1 : 0));
  const refs = sorted.map((e) => {
    const digestHex = createHash("sha256").update(e.bytes).digest("hex");
    if (digestHex !== e.traceHash.toLowerCase()) {
      throw new TraceStoreIntegrityError(
        `archive entry ${e.cid} hashes to ${digestHex}, expected ${e.traceHash}`,
      );
    }
    return { cid: e.cid, traceHash: e.traceHash.toLowerCase() };
  });
  const manifestHash = createHash("sha256")
    .update(canonicalManifestPayload(batchId, refs))
    .digest("hex");
  return { version: 1, batchId, entries: refs, manifestHash };
}

/**
 * Recomputes the manifest hash and compares it to the recorded value. Returns
 * `true` only when the manifest is internally consistent and unmodified.
 */
export function verifyArchiveManifest(manifest: ArchiveManifest): boolean {
  const refs = [...manifest.entries].sort((a, b) => (a.cid < b.cid ? -1 : a.cid > b.cid ? 1 : 0));
  const expected = createHash("sha256")
    .update(canonicalManifestPayload(manifest.batchId, refs))
    .digest("hex");
  return expected === manifest.manifestHash;
}

/**
 * Recovery procedure when a gateway is unavailable: restore archived content
 * by re-pinning each entry through the supplied store, verifying the manifest
 * first. Returns the CIDs that were successfully restored. Throws
 * {@link TraceStoreIntegrityError} if the manifest fails verification.
 */
export async function restoreFromArchive(
  manifest: ArchiveManifest,
  entries: ArchiveEntry[],
  store: TraceStore,
): Promise<string[]> {
  if (!verifyArchiveManifest(manifest)) {
    throw new TraceStoreIntegrityError(`archive manifest for batch ${manifest.batchId} failed verification`);
  }
  const byCid = new Map(entries.map((e) => [e.cid, e]));
  const restored: string[] = [];
  for (const ref of manifest.entries) {
    const entry = byCid.get(ref.cid);
    if (!entry) continue;
    const { cid } = await store.put(entry.bytes);
    if (!sameCid(cid, ref.cid)) {
      throw new TraceStoreIntegrityError(`restored CID ${cid} does not match archived ${ref.cid}`);
    }
    restored.push(cid);
  }
  return restored;
}

export interface PinResult {
  cid: string;
  /** false when a pinning service only accepted (queued) the request. */
  confirmed: boolean;
}

export interface PinProvider {
  name: string;
  pin(bytes: Uint8Array, expectedCid: string, signal: AbortSignal): Promise<PinResult>;
}

function assertSameCid(provider: string, got: string, expected: string): void {
  if (!sameCid(got, expected)) {
    throw new TraceStoreIntegrityError(`${provider} returned CID ${got}, expected ${expected}`);
  }
}

async function failForStatus(provider: string, res: Response): Promise<never> {
  const body = (await res.text().catch(() => "")).slice(0, 200);
  throw new Error(`${provider}: HTTP ${res.status}${body ? ` ${body}` : ""}`);
}

/** kubo HTTP RPC `/api/v0/add` as a single raw-leaf block. */
export class KuboProvider implements PinProvider {
  readonly name: string;

  constructor(private readonly o: { apiUrl: string; authHeader?: string; name?: string }) {
    this.name = o.name ?? "kubo";
  }

  async pin(bytes: Uint8Array, expectedCid: string, signal: AbortSignal): Promise<PinResult> {
    const url = new URL("api/v0/add", this.o.apiUrl.endsWith("/") ? this.o.apiUrl : `${this.o.apiUrl}/`);
    // Mandatory: default `add` flags produce a dag-pb/UnixFS CID whose
    // digest is not sha256(bytes). The CID check below catches drift.
    for (const [k, v] of Object.entries({
      "cid-version": "1",
      "raw-leaves": "true",
      hash: "sha2-256",
      pin: "true",
      chunker: "size-1048576",
    })) {
      url.searchParams.set(k, v);
    }
    const form = new FormData();
    form.append("file", new Blob([bytes]), "trace.json");
    const headers: Record<string, string> = {};
    if (this.o.authHeader) headers.Authorization = this.o.authHeader;
    const res = await fetch(url, { method: "POST", body: form, headers, signal });
    if (!res.ok) await failForStatus(this.name, res);
    const lines = (await res.text()).split("\n").filter((l) => l.trim() !== "");
    const last = lines.length ? (JSON.parse(lines[lines.length - 1]!) as { Hash?: string }) : {};
    if (!last.Hash) throw new Error(`${this.name}: add response has no Hash`);
    assertSameCid(this.name, last.Hash, expectedCid);
    return { cid: expectedCid, confirmed: true };
  }
}

type PinStatus = "queued" | "pinning" | "pinned" | "failed";

/**
 * IPFS Pinning Service API (`POST /pins`, `GET /pins/{requestid}`). Pins by
 * CID, so the content must already be reachable — typically through the
 * kubo node, whose multiaddrs can be passed as `origins`.
 */
export class PinningServiceProvider implements PinProvider {
  readonly name: string;
  private readonly pollMs: number;

  constructor(
    private readonly o: {
      endpoint: string;
      token: string;
      origins?: string[];
      acceptQueued?: boolean;
      pollIntervalMs?: number;
      name?: string;
    },
  ) {
    this.name = o.name ?? "pinning-service";
    this.pollMs = o.pollIntervalMs ?? 2_000;
  }

  private url(path: string): string {
    return `${this.o.endpoint.replace(/\/+$/, "")}${path}`;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.o.token}`, "Content-Type": "application/json" };
  }

  async pin(_bytes: Uint8Array, expectedCid: string, signal: AbortSignal): Promise<PinResult> {
    const body: Record<string, unknown> = { cid: expectedCid, name: `oracledesk-trace-${expectedCid}` };
    if (this.o.origins?.length) body.origins = this.o.origins;
    const res = await fetch(this.url("/pins"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) await failForStatus(this.name, res);
    let status = (await res.json()) as { requestid: string; status: PinStatus; pin?: { cid?: string } };
    if (!status.requestid) throw new Error(`${this.name}: response has no requestid`);
    if (status.pin?.cid) assertSameCid(this.name, status.pin.cid, expectedCid);

    while (status.st

/* … truncated 2311 chars — edit only what you need near the top … */
