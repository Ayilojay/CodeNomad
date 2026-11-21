import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { OracleDeskEvent } from "./decode.js";
import { Dispatcher, ProcessedLru } from "./dispatch.js";
import { checkFilters, EventSubscriber, FileCheckpointStore, MemoryCheckpointStore, RpcFilterError } from "./subscriber.js";
import { FakeEventsRpc, IDS, testDecoder, trade } from "./testing.js";

async function setup(opts: { pageLimit?: number; maxBackfillPages?: number; startLedger?: number; checkpoints?: MemoryCheckpointStore } = {}) {
  const rpc = await FakeEventsRpc.create();
  const checkpoints = opts.checkpoints ?? new MemoryCheckpointStore();
  const batches: OracleDeskEvent[][] = [];
  const resyncs: string[] = [];
  const logs: { event: string; fields?: Record<string, unknown> }[] = [];
  let failNext = 0;
  const sub = new EventSubscriber({
    rpc,
    decoder: await testDecoder(),
    checkpoints,
    pageLimit: opts.pageLimit,
    maxBackfillPages: opts.maxBackfillPages,
    startLedger: opts.startLedger,
    onBatch: async (events) => {
      if (failNext > 0) {
        failNext--;
        throw new Error("handler crashed");
      }
      batches.push(events);
    },
    onResync: async (reason) => void resyncs.push(reason),
    log: (event, fields) => void logs.push({ event, fields }),
  });
  return { rpc, checkpoints, batches, resyncs, logs, sub, failOnce: () => void (failNext = 1) };
}

test("with no checkpoint it starts at the latest ledger instead of replaying history", async () => {
  const s = await setup();
  s.rpc.emit(trade(1n, 1n, 900));
  s.rpc.latest = 1_000;
  assert.equal(await s.sub.pollOnce(), 0);
  assert.deepEqual(s.checkpoints.saved, { cursor: undefined, lastLedger: 1_000, processed: [] });
  s.rpc.emit(trade(1n, 2n, 1_001));
  assert.equal(await s.sub.pollOnce(), 1);
  assert.equal(s.batches[0][0].kind === "Trade" && s.batches[0][0].collateral, 2n);
});

test("configured backfill starts at its checkpoint and is bounded by pages per poll", async () => {
  const s = await setup({ pageLimit: 1, maxBackfillPages: 2, startLedger: 998 });
  s.rpc.emit(trade(1n, 1n, 998));
  s.rpc.emit(trade(2n, 1n, 999));
  s.rpc.emit(trade(3n, 1n, 1_000));
  assert.equal(await s.sub.pollOnce(), 2);
  assert.equal(s.rpc.requests.length, 2);
  assert.equal((s.rpc.requests[0] as { startLedger: number }).startLedger, 998);
  assert.equal(s.checkpoints.saved.lastLedger, 998);
  assert.equal(await s.sub.pollOnce(), 1);
  assert.equal(s.batches.flat().length, 3);
});

test("configured backfill refuses a start ledger ahead of the RPC tip", async () => {
  const s = await setup({ startLedger: 1_002 });
  await assert.rejects(s.sub.pollOnce(), /ahead of latest ledger/);
  assert.deepEqual(s.checkpoints.saved, { processed: [] });
});

test("the checkpoint advances only after the batch is acknowledged; a crash redelivers it", async () => {
  const s = await setup();
  await s.sub.pollOnce();
  s.rpc.emit(trade(1n, 5n, 1_001));
  const before = structuredClone(s.checkpoints.saved);
  s.failOnce();
  await assert.rejects(s.sub.pollOnce(), /handler crashed/);
  assert.deepEqual(s.checkpoints.saved, before, "nothing acknowledged, nothing saved");
  assert.equal(await s.sub.pollOnce(), 1, "the same event is delivered again");
  assert.equal(s.batches.length, 1);
  assert.notDeepEqual(s.checkpoints.saved.cursor, before.cursor);
});

test("checkpoints survive a restart through the file store", async () => {
  const dir = mkdtempSync(join(tmpdir(), "events-"));
  const key = { network: "testnet", contractIds: Object.values(IDS) };
  const rpc = await FakeEventsRpc.create();
  const delivered: string[] = [];
  const make = () =>
    testDecoder().then(
      (decoder) =>
        new EventSubscriber({
          rpc,
          decoder,
          checkpoints: new FileCheckpointStore(dir, key),
          onBatch: async (events) => void delivered.push(...events.map((e) => e.id)),
          onResync: async () => undefined,
        }),
    );
  await (await make()).pollOnce();
  const first = rpc.emit(trade(1n, 1n, 1_001));
  await (await make()).pollOnce();
  const second = rpc.emit(trade(1n, 1n, 1_002));
  await (await make()).pollOnce();
  assert.deepEqual(delivered, [first, second]);
  const file = new FileCheckpointStore(dir, key).path;
  assert.match(file, /testnet-[0-9a-f]{16}\.json$/);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).lastLedger, 1_002);
});

test("duplicate deliveries are suppressed by the persisted LRU of processed ids", async () => {
  const checkpoints = new MemoryCheckpointStore();
  const rpc = await FakeEventsRpc.create();
  const seen: string[] = [];
  const run = async () => {
    const lru = new ProcessedLru(100, (await checkpoints.load()).processed);
    const dispatcher = new Dispatcher({ lru, handlers: [{ name: "count", kinds: ["Trade"], handle: async (e) => void seen.push(e.id) }] });
    return new EventSubscriber({ rpc, decoder: await testDecoder(), checkpoints, onBatch: (e) => dispatcher.dispatch(e), onResync: async () => undefined, processedIds: () => lru.toJSON() });
  };
  await (await run()).pollOnce();
  const id = rpc.emit(trade(1n, 1n, 1_001));
  await (await run()).pollOnce();
  // A restart that lost the cursor (but kept the processed ids) re-reads the ledger.
  checkpoints.saved = { ...checkpoints.saved, cursor: undefined, lastLedger: 1_000 };
  await (await run()).pollOnce();
  assert.deepEqual(seen, [id]);
  assert.ok(checkpoints.saved.processed.includes(id));
});

test("a retention gap alerts and resyncs without advancing the checkpoint over missing ledgers", async () => {
  const s = await setup();
  await s.sub.pollOnce();
  const checkpointBeforeGap = structuredClone(s.checkpoints.saved);
  // The agent is down while RPC retention moves past its checkpoint.
  s.rpc.latest = 5_000;
  s.rpc.oldest = 3_000;
  s.rpc.emit(trade(1n, 1n, 4_000));
  await s.sub.pollOnce();
  assert.equal(s.resyncs.length, 1);
  assert.match(s.resyncs[0], /retention/);
  assert.equal(s.batches.length, 0, "the stale window is not partially replayed");
  assert.deepEqual(s.checkpoints.saved, checkpointBeforeGap, "an incomplete range remains unacknowledged");
  assert.ok(s.logs.some((l) => l.event === "EVENTS_BACKFILL_BLOCKED"));
});

test("an RPC retention error leaves an uninitialized configured backfill checkpoint untouched", async () => {
  const s = await setup({ startLedger: 50 });
  s.rpc.oldest = 3_000;
  s.rpc.latest = 5_000;
  assert.equal(await s.sub.pollOnce(), 0);
  assert.deepEqual(s.checkpoints.saved, { processed: [] });
  assert.equal(s.resyncs.length, 1);
  assert.ok(s.logs.some((l) => l.event === "EVENTS_BACKFILL_BLOCKED"));
});

test("idle polls advance the checkpoint so quiet periods are not mistaken for gaps", async () => {
  const s = await setup();
  await s.sub.pollOnce();
  for (const latest of [2_000, 3_000, 4_000]) {
    s.rpc.latest = latest;
    s.rpc.oldest = latest - 1_500;
    await s.sub.pollOnce();
    assert.equal(s.checkpoints.saved.lastLedger, latest);
  }
  assert.deepEqual(s.resyncs, []);
});

test("pages are fetched until caught up, each acknowledged before the next", async () => {
  const s = await setup({ pageLimit: 2 });
  await s.sub.pollOnce();
  for (let i = 0; i < 5; i++) s.rpc.emit(trade(BigInt(i), 1n, 1_001 + i));
  assert.equal(await s.sub.pollOnce(), 5);
  assert.deepEqual(s.batches.map((b) => b.length), [2, 2, 1]);
  assert.ok(s.rpc.requests.every((r) => (r as { limit: number }).limit === 2));
  assert.equal(s.checkpoints.saved.lastLedger, 1_005);
});

test("backfill stops at its per-poll page bound and continues from its cursor", async () => {
  const s = await setup({ pageLimit: 2, maxBackfillPages: 2 });
  await s.sub.pollOnce();
  for (let i = 0; i < 5; i++) s.rpc.emit(trade(BigInt(i), 1n, 1_001 + i));
  assert.equal(await s.sub.pollOnce(), 4);
  assert.equal(s.batches.flat().length, 4);
  assert.equal(await s.sub.pollOnce(), 1);
  assert.equal(s.batches.flat().length, 5);
});

// --- Chaos / stress scenarios: oracle delay, same-ledger movement, close-time races, RPC outages ---

async function chaosSetup(opts: { pageLimit?: number; maxBackfillPages?: number; startLedger?: number } = {}) {
  const rpc = await FakeEventsRpc.create();
  const checkpoints = new MemoryCheckpointStore();
  const batches: OracleDeskEvent[][] = [];
  const resyncs: string[] = [];
  const logs: { event: string; fields?: Record<string, unknown> }[] = [];
  const sub = new EventSubscriber({
    rpc,
    decoder: await testDecoder(),
    checkpoints,
    pageLimit: opts.pageLimit,
    maxBackfillPages: opts.maxBackfillPages,
    startLedger: opts.startLedger,
    onBatch: async (events) => void batches.push(events),
    onResync: async (reason) => void resyncs.push(reason),
    log: (event, fields) => void logs.push({ event, fields }),
  });
  return { rpc, checkpoints, batches, resyncs, logs, sub };
}

test("chaos: same-ledger price movement is delivered in order without loss", async () => {
  const s = await chaosSetup({ pageLimit: 10 });
  await s.sub.pollOnce();
  // Two price updates land in the same ledger; both must be observed.
  const a = s.rpc.emit(trade(1n, 100n, 1_001));
  const b = s.rpc.emit(trade(1n, 250n, 1_001));
  assert.equal(await s.sub.pollOnce(), 2);
  assert.deepEqual(s.batches.flat().map((e) => e.id), [a, b]);
  assert.equal(s.checkpoints.saved.lastLedger, 1_001);
});

test("chaos: delayed events are replayed once the feed catches up, not dropped", async () => {
  const s = await chaosSetup();
  await s.sub.pollOnce();
  // The oracle feed lags: the ledger tip advances but no events are visible yet.
  s.rpc.latest = 1_010;
  assert.equal(await s.sub.pollOnce(), 0);
  assert.equal(s.checkpoints.saved.lastLedger, 1_010);
  // The delayed event finally surfaces at a later ledger and is delivered.
  const id = s.rpc.emit(trade(1n, 42n, 1_011));
  assert.equal(await s.sub.pollOnce(), 1);
  assert.deepEqual(s.batches.flat().map((e) => e.id), [id]);
});

test("chaos: close-time transition events are delivered exactly once across a restart", async () => {
  const s = await chaosSetup();
  await s.sub.pollOnce();
  const close = s.rpc.emit(trade(1n, 1n, 1_001));
  assert.equal(await s.sub.pollOnce(), 1);
  // A restart that lost the cursor must not double-process the close transition.
  s.checkpoints.saved = { ...s.checkpoints.saved, cursor: undefined, lastLedger: 1_000 };
  await s.sub.pollOnce();
  assert.deepEqual(s.batches.flat().map((e) => e.id), [close]);
});

test("chaos: unavailable RPC fails the poll without advancing the checkpoint (bounded retries)", async () => {
  const s = await chaosSetup();
  await s.sub.pollOnce();
  const before = structuredClone(s.checkpoints.saved);
  const original = s.rpc.getEvents.bind(s.rpc);
  let calls = 0;
  (s.rpc as unknown as { getEvents: typeof original }).getEvents = async () => {
    calls++;
    throw new Error("rpc unavailable");
  };
  await assert.rejects(s.sub.pollOnce(), /rpc unavailable/);
  // A single poll issues a bounded number of RPC calls; it does not spin.
  assert.ok(calls <= 1, `expected bounded RPC calls, saw ${calls}`);
  assert.deepEqual(s.checkpoints.saved, before, "an unavailable RPC leaves the checkpoint unacknowledged");
  // Once the RPC recovers, the pending event is delivered.
  (s.rpc as unknown as { getEvents: typeof original }).getEvents = original;
  const id = s.rpc.emit(trade(1n, 7n, 1_001));
  assert.equal(await s.sub.pollOnce(), 1);
  assert.deepEqual(s.batches.flat().map((e) => e.id), [id]);
});

test("chaos: a stale feed during a close-time race never advances past unacknowledged ledgers", async () => {
  const s = await chaosSetup();
  await s.sub.pollOnce();
  const before = structuredClone(s.checkpoints.saved);
  // Retention moves past the checkpoint while the feed is stale (agent was down).
  s.rpc.latest = 9_000;
  s.rpc.oldest = 8_000;
  s.rpc.emit(trade(1n, 1n, 8_500));
  await s.sub.pollOnce();
  assert.equal(s.resyncs.length, 1);
  assert.match(s.resyncs[0], /retention/);
  assert.equal(s.batches.length, 0, "no out-of-policy trade is emitted from a stale window");
  assert.deepEqual(s.checkpoints.saved, before);
});
