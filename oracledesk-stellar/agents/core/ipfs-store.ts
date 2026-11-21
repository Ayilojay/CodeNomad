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
 * One gateway attempt while resolving trace content. `missing` means the
 * gateway reported the content is not present (404/410); `error` means the
 * attempt failed for another reason (timeout, network, non-2xx). `tampered`
 * means bytes were served but did not hash to the expected `trace_hash`.
 */
export type TraceGatewayAttemptStatus = "verified" | "missing" | "tampered" | "error";

export interface TraceGatewayAttempt {
  gateway: string;
  status: TraceGatewayAttemptStatus;
  /** Present only when `status === "verified"`. */
  bytes?: Uint8Array;
  reason?: string;
}

/**
 * Result of a multi-gateway trace retrieval. `verified` carries the exact
 * bytes; `missing` means every gateway reported the content absent; `tampered`
 * means at least one gateway served bytes that failed verification (and none
 * verified); `unavailable` means no gateway could be reached. Never returns
 * unverified bytes as success.
 */
export type TraceRetrievalStatus = "verified" | "missing" | "tampered" | "unavailable";

export interface TraceRetrievalResult {
  status: TraceRetrievalStatus;
  cid: string;
  traceHash: string;
  /** Present only when `status === "verified"`. */
  bytes?: Uint8Array;
  reason?: string;
  attempts: TraceGatewayAttempt[];
}

export interface TraceGateway {
  /** Base URL of an IPFS gateway, e.g. `https://ipfs.io`. */
  url: string;
  /** Optional display name; defaults to the URL. */
  name?: string;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function gatewayUrl(base: string, cid: string): string {
  return `${base.replace(/\/+$/, "")}/ipfs/${cid}`;
}

/**
 * Fetches trace content from a single gateway under a bounded timeout and
 * verifies the served bytes against `traceHash`. Distinguishes missing content
 * (404/410) from tampered content (bytes present but hash mismatch).
 */
async function fetchFromGateway(
  gateway: TraceGateway,
  ref: { cid: string; traceHash: string },
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<TraceGatewayAttempt> {
  const name = gateway.name ?? gateway.url;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const res = await fetch(gatewayUrl(gateway.url, ref.cid), { signal: controller.signal });
    if (res.status === 404 || res.status === 410) {
      return { gateway: name, status: "missing", reason: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { gateway: name, status: "error", reason: `HTTP ${res.status}` };
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const digestHex = createHash("sha256").update(bytes).digest("hex");
    if (digestHex !== ref.traceHash.toLowerCase()) {
      return {
        gateway: name,
        status: "tampered",
        reason: `served bytes hash to ${digestHex}, expected ${ref.traceHash}`,
      };
    }
    return { gateway: name, status: "verified", bytes };
  } catch (err) {
    return { gateway: name, status: "error", reason: errorText(err) };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Resolves trace content by trying each configured gateway in order under a
 * bounded per-attempt timeout, verifying exact bytes against `traceHash`
 * before returning them. Returns the first verified result; otherwise reports
 * `tampered` (bytes served but unverifiable), `missing` (all gateways absent),
 * or `unavailable` (no gateway reachable). Never returns unverified bytes.
 */
export async function retrieveTraceContent(
  gateways: TraceGateway[],
  ref: { cid: string; traceHash: string },
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<TraceRetrievalResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const attempts: TraceGatewayAttempt[] = [];
  for (const gateway of gateways) {
    if (opts.signal?.aborted) break;
    const attempt = await fetchFromGateway(gateway, ref, timeoutMs, opts.signal);
    attempts.push(attempt);
    if (attempt.status === "verified") {
      return { status: "verified", cid: ref.cid, traceHash: ref.traceHash, bytes: attempt.bytes, attempts };
    }
  }
  const base = { cid: ref.cid, traceHash: ref.traceHash, attempts };
  if (attempts.some((a) => a.status === "tampered")) {
    return { ...base, status: "tampered", reason: "served bytes failed hash verification" };
  }
  if (attempts.length > 0 && attempts.every((a) => a.status === "missing")) {
    return { ...base, status: "missing", reason: "content not found on any gateway" };
  }
  return { ...base, status: "unavailable", reason: "no gateway could serve the content" };
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

    while (status.status === "queued" || status.status === "pinning") {
      await new Promise((r) => setTimeout(r, this.pollMs));
      if (signal.aborted) throw new Error(`${this.name}: aborted while polling pin status`);
      const poll = await fetch(this.url(`/pins/${status.requestid}`), { headers: this.headers(), signal });
      if (!poll.ok) await failForStatus(this.name, poll);
      status = (await poll.json()) as { requestid: string; status: PinStatus; pin?: { cid?: string } };
      if (status.pin?.cid) assertSameCid(this.name, status.pin.cid, expectedCid);
    }
    if (status.status === "failed") throw new Error(`${this.name}: pin failed`);
    return { cid: expectedCid, confirmed: status.status === "pinned" };
  }
}
