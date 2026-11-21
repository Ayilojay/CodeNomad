import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  IpfsTraceStore,
  KuboProvider,
  MAX_TRACE_BYTES,
  PinningServiceProvider,
  rawCidForBytes,
  sameCid,
  TraceGatewayError,
  TracePinError,
  TraceStoreIntegrityError,
} from "./ipfs-store.js";
import { buildTrace, LocalTraceStore } from "./trace.js";
import { createTraceStore } from "./trace-store-factory.js";

type Handler = (req: IncomingMessage, res: ServerResponse, body: Buffer) => void | Promise<void>;

/** A node:http server on an ephemeral port; returns its base URL. */
async function serve(t: test.TestContext, handler: Handler): Promise<string> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => void handler(req, res, Buffer.concat(chunks)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const sha256Hex = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const TRACE = buildTrace({
  agent: "trader",
  marketId: 1,
  action: "buy",
  reasoning: "edge clears threshold — prix élevé ✓",
  inputs: { fairValueBps: 6200 },
  timestamp: 1_700_000_000,
});
const TRACE_BYTES = new TextEncoder().encode(TRACE.json);

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

/** kubo `add` mock returning `hashFor(body)`; records query strings. */
async function kubo(t: test.TestContext, hashFor: () => string | Promise<string>, status = 200) {
  const queries: URLSearchParams[] = [];
  const url = await serve(t, async (req, res) => {
    const u = new URL(req.url!, "http://x");
    assert.equal(u.pathname, "/api/v0/add");
    queries.push(u.searchParams);
    if (status !== 200) return json(res, status, { Message: "boom" });
    res.end(`${JSON.stringify({ Name: "trace.json", Hash: await hashFor(), Size: "1" })}\n`);
  });
  return { url, queries };
}

/** Gateway mock serving `body` for any CID (optionally after a delay). */
async function gateway(t: test.TestContext, body: () => Uint8Array, opts: { delayMs?: number } = {}) {
  let hits = 0;
  const url = await serve(t, (_req, res) => {
    hits++;
    setTimeout(() => res.end(Buffer.from(body())), opts.delayMs ?? 0);
  });
  return { url: `${url}/ipfs`, hits: () => hits };
}

/** Gateway mock that 404s (missing content) for any CID. */
async function missingGateway(t: test.TestContext) {
  let hits = 0;
  const url = await serve(t, (_req, res) => {
    hits++;
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });
  return { url: `${url}/ipfs`, hits: () => hits };
}

const fast = { retries: 2, backoffBaseMs: 1, pinTimeoutMs: 2_000 };

test("rawCidForBytes digest equals sha256 hex of the bytes", async () => {
  const { cid, digestHex } = await rawCidForBytes(TRACE_BYTES);
  assert.equal(digestHex, sha256Hex(TRACE_BYTES));
  assert.equal(digestHex, TRACE.hash);
  assert.match(cid, /^bafkrei[a-z2-7]{52}$/);
});

test("known vector: CID for '{}' matches pinned bafkrei... string", async () => {
  // `ipfs add --cid-version=1 --raw-leaves` of the 2 bytes `{}`; equally
  // base32("b", 0x01 0x55 0x12 0x20 || sha256("{}")).
  const { cid } = await rawCidForBytes(new TextEncoder().encode("{}"));
  assert.equal(cid, "bafkreicecnx2gvntm6fbcrvnc336qze6st5u7qq7457igegamd3bzkx7ri");
});

test("sameCid compares by value, not string encoding", async () => {
  const { cid } = await rawCidForBytes(new TextEncoder().encode("{}"));
  const { CID } = await import("multiformats/cid");
  const { base58btc } = await import("multiformats/bases/base58");
  assert.ok(sameCid(cid, CID.parse(cid).toString(base58btc)));
  assert.ok(!sameCid(cid, (await rawCidForBytes(new TextEncoder().encode("[]"))).cid));
  assert.ok(!sameCid(cid, "not-a-cid"));
});

test("put pins with mandatory kubo flags, verifies the gateway, and returns the local CID", async (t) => {
  const { cid } = await rawCidForBytes(TRACE_BYTES);
  const k = await kubo(t, () => cid);
  const gw = await gateway(t, () => TRACE_BYTES);
  const store = new IpfsTraceStore({ providers: [new KuboProvider({ apiUrl: k.url })], gatewayUrl: gw.url, ...fast });
  assert.deepEqual(await store.put(TRACE.hash, TRACE.json), { cid });
  const q = k.queries[0]!;
  assert.equal(q.get("cid-version"), "1");
  assert.equal(q.get("raw-leaves"), "true");
  assert.equal(q.get("hash"), "sha2-256");
  assert.equal(q.get("chunker"), "size-1048576");
  assert.equal(gw.hits(), 1);
});

test("put rejects when provider returns a different CID", async (t) => {
  // e.g. kubo without --raw-leaves: a CID for other content/codec.
  const wrong = (await rawCidForBytes(new TextEncoder().encode("other"))).cid;
  const k = await kubo(t, () => wrong);
  const gw = await gateway(t, () => TRACE_BYTES);
  const store = new IpfsTraceStore({ providers: [new KuboProvider({ apiUrl: k.url })], gatewayUrl: gw.url, ...fast });
  await assert.rejects(store.put(TRACE.hash, TRACE.json), TraceStoreIntegrityError);
  assert.equal(k.queries.length, 1, "a CID mismatch is not retried");
  assert.equal(gw.hits(), 0);
});

test("put rejects when hash argument does not match json bytes", async (t) => {
  const k = await kubo(t, () => "unused");
  const store = new IpfsTraceStore({ providers: [new KuboProvider({ apiUrl: k.url })], gatewayUrl: k.url, ...fast });
  await assert.rejects(store.put("00".repeat(32), TRACE.json), TraceStoreIntegrityError);
  // Re-serializing (e.g. escaping non-ASCII) changes the bytes, so it fails too.
  const escaped = TRACE.json.replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  assert.notEqual(escaped, TRACE.json);
  await assert.rejects(store.put(TRACE.hash, escaped), TraceStoreIntegrityError);
  assert.equal(k.queries.length, 0);
});

test("put rejects traces larger than one block", async (t) => {
  const k = await kubo(t, () => "unused");
  const store = new IpfsTraceStore({ providers: [new KuboProvider({ apiUrl: k.url })], gatewayUrl: k.url, ...fast });
  const big = "x".repeat(MAX_TRACE_BYTES + 1);
  await assert.rejects(store.put(sha256Hex(big), big), /limit/);
});

test("put succeeds with minPins=1 when one of two providers fails", async (t) => {
  const { cid } = await rawCidForBytes(TRACE_BYTES);
  const k = await kubo(t, () => cid);
  const svc = await serve(t, (_req, res) => json(res, 503, { error: { reason: "DOWN" } }));
  const gw = await gateway(t, () => TRACE_BYTES);
  const store = new IpfsTraceStore({
    providers: [new KuboProvider({ apiUrl: k.url }), new PinningServiceProvider({ endpoint: svc, token: "secret" })],
    minPins: 1,
    gatewayUrl: gw.url,
    ...fast,
  });
  assert.deepEqual(await store.put(TRACE.hash, TRACE.json), { cid });
});

test("put fails with TracePinError listing attempts when minPins not met", async (t) => {
  const { cid } = await rawCidForBytes(TRACE_BYTES);
  const k = await kubo(t, () => cid);
  const svc = await serve(t, (_req, res) => json(res, 503, {}));
  const gw = await gateway(t, () => TRACE_BYTES);
  const store = new IpfsTraceStore({
    providers: [new KuboProvider({ apiUrl: k.url }), new PinningServiceProvider({ endpoint: svc, token: "s3cr3t-token" })],
    minPins: 2,
    gatewayUrl: gw.url,
    ...fast,
  });
  const err = await store.put(TRACE.hash, TRACE.json).then(
    () => assert.fail("expected TracePinError"),
    (e: unknown) => e,
  );
  assert.ok(err instanceof TracePinError);
  assert.deepEqual(
    err.attempts.map((a) => [a.provider, a.attempt, a.ok]).sort(),
    [
      ["kubo", 1, true],
      ["pinning-service", 1, false],
      ["pinning-service", 2, false],
    ],
  );
  assert.ok(!JSON.stringify(err.attempts).includes("s3cr3t-token"), "token must never appear in errors");
  assert.equal(gw.hits(), 0, "no gateway check when pins are missing");
});

test("get returns verified bytes from the first healthy gateway", async (t) => {
  const { cid } = await rawCidForBytes(TRACE_BYTES);
  const gw = await gateway(t, () => TRACE_BYTES);
  const store = new IpfsTraceStore({ providers: [], gatewayUrl: gw.url, ...fast });
  const bytes = await store.get(cid);
  assert.deepEqual(Buffer.from(bytes), Buffer.from(TRACE_BYTES));
  assert.equal(gw.hits(), 1);
});

test("get falls through to a later gateway when earlier ones are missing", async (t) => {
  const { cid } = await rawCidForBytes(TRACE_BYTES);
  const miss1 = await missingGateway(t);
  const miss2 = await missingGateway(t);
  const good = await gateway(t, () => TRACE_BYTES);
  const store = new IpfsTraceStore({ providers: [], gatewayUrls: [miss1.url, miss2.url, good.url], ...fast });
  const bytes = await store.get(cid);
  assert.deepEqual(Buffer.from(bytes), Buffer.from(TRACE_BYTES));
  assert.equal(miss1.hits(), 1);
  assert.equal(miss2.hits(), 1);
  assert.equal(good.hits(), 1);
});

test("get reports missing content when every gateway 404s", async (t) => {
  const { cid } = await rawCidForBytes(TRACE_BYTES);
  const miss1 = await missingGateway(t);
  const miss2 = await missingGateway(t);
  const store = new IpfsTraceStore({ providers: [], gatewayUrls: [miss1.url, miss2.url], ...fast });
  const err = await store.get(cid).then(
    () => assert.fail("expected TraceGatewayError"),
    (e: unknown) => e,
  );
  assert.ok(err instanceof TraceGatewayError);
  assert.equal(err.reason, "missing");
  assert.equal(miss1.hits(), 1);
  assert.equal(miss2.hits(), 1);
});

test("get rejects tampered content and never returns it as success", async (t) => {
  const { cid } = await rawCidForBytes(TRACE_BYTES);
  const tampered = new TextEncoder().encode(TRACE.json.replace("buy", "sell"));
  const gw = await gateway(t, () => tampered);
  const store = new IpfsTraceStore({ providers: [], gatewayUrl: gw.url, ...fast });
  const err = await store.get(cid).then(
    () => assert.fail("expected TraceGatewayError"),
    (e: unknown) => e,
  );
  assert.ok(err instanceof TraceGatewayError);
  assert.equal(err.reason, "tampered");
});

test("get distinguishes tampered from missing across gateways", async (t) => {
  const { cid } = await rawCidForBytes(TRACE_BYTES);
  const tampered = new TextEncoder().encode(TRACE.json.replace("buy", "sell"));
  const bad = await gateway(t, () => tampered);
  const miss = await missingGateway(t);
  const store = new IpfsTraceStore({ providers: [], gatewayUrls: [miss.url, bad.url], ...fast });
  const err = await store.get(cid).then(
    () => assert.fail("expected TraceGatewayError"),
    (e: unknown) => e,
  );
  assert.ok(err instanceof TraceGatewayError);
  assert.equal(err.reason, "tampered", "tampered content outranks missing");
});

test("get bounds each gateway attempt with a timeout and moves on", async (t) => {
  const { cid } = await rawCidForBytes(TRACE_BYTES);
  const slow = await gateway(t, () => TRACE_BYTES, { delayMs: 5_000 });
  const good = await gateway(t, () => TRACE_BYTES);
  const store = new IpfsTraceStore({
    providers: [],
    gatewayUrls: [slow.url, good.url],
    gatewayTimeoutMs: 100,
    ...fast,
  });
  const bytes = await store.get(cid);
  assert.deepEqual(Buffer.from(bytes), Buffer.from(TRACE_BYTES));
  assert.equal(good.hits(), 1);
});

test("get reports missing when all gateways time out", async (t) => {
  const { cid } = await rawCidForBytes(TRACE_BYTES);
  const slow = await gateway(t, () => TRACE_BYTES, { delayMs: 5_000 });
  const store = new IpfsTraceStore({ providers: [], gatewayUrl: slow.url, gatewayTimeoutMs: 100, ...fast });
  const err = await store.get(cid).then(
    () => assert.fail("expected TraceGatewayError"),
    (e: unknown) => e,
  );
  assert.ok(err instanceof TraceGatewayError);
  assert.equal(err.reason, "missing");
});
