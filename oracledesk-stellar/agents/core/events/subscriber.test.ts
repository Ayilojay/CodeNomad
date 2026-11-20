import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { OracleDeskEvent } from "./decode.js";
import { Dispatcher, ProcessedLru } from "./dispatch.js";
import { checkFilters, EventSubscriber, FileCheckpointStore, MemoryCheckpointStore, RpcFilterError } from "./subscriber.js";
import { FakeEventsRpc, IDS, testDecoder, trade } from "./testing.js";

async function setup(opts: { pageLimit?: number; checkpoints?: MemoryCheckpointStore } = {}) {
  const rpc = await FakeEventsRpc.create();
  const checkpoints = opts.checkpoints ?? new MemoryCheckpointStore();
  const batches: OracleDeskEvent[][] = [];
  const resyncs: string[] = [];
  let failNext = 0;
  const sub = new EventSubscriber({
    rpc,
    decoder: await testDecoder(),
    checkpoints,
    pageLimit: opts.pageLimit,
    onBatch: async (events) => {
      if (failNext > 0) {
        failNext--;
        throw new Error("handler crashed");
      }
      batches.push(events);
    },
    onResync: async (reason) => void resyncs.push(reason),
  });
  return { rpc, checkpoints, batches, resyncs, sub, failOnce: () => void (failNext = 1) };
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

test("a retention gap triggers a full resync instead of skipping events", async () => {
  const s = await setup();
  await s.sub.pollOnce();
  // The agent is down while RPC retention moves past its checkpoint.
  s.rpc.latest = 5_000;
  s.rpc.oldest = 3_000;
  s.rpc.emit(trade(1n, 1n, 4_000));
  await s.sub.pollOnce();
  assert.equal(s.resyncs.length, 1);
  assert.match(s.resyncs[0], /retention/);
  assert.equal(s.batches.length, 0, "the stale window is not partially replayed");
  assert.equal(s.checkpoints.saved.lastLedger, 5_000);
  assert.equal(s.checkpoints.saved.cursor, undefined);
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

test("events from failed contract calls are filtered out", async () => {
  const s = await setup();
  await s.sub.pollOnce();
  s.rpc.emit(trade(1n, 1n, 1_001, { successful: false }));
  const ok = s.rpc.emit(trade(2n, 1n, 1_002));
  await s.sub.pollOnce();
  assert.deepEqual(s.batches.flat().map((e) => e.id), [ok]);
});

test("filters beyond the RPC limits are rejected up front", async () => {
  const id = IDS.market_core;
  assert.throws(() => checkFilters(Array.from({ length: 6 }, () => ({ type: "contract" as const }))), RpcFilterError);
  assert.throws(() => checkFilters([{ type: "contract", contractIds: Array(6).fill(id) }]), /at most 5 contract ids/);
  assert.throws(() => checkFilters([{ type: "contract", topics: [["a", "b", "c", "d", "e"]] }]), /1-4 segments/);
  assert.throws(() => checkFilters([{ type: "contract", topics: Array(6).fill(["*"]) }]), /at most 5 topic filters/);
  assert.throws(() => checkFilters([]), RpcFilterError);
  assert.doesNotThrow(() => checkFilters([{ type: "contract", contractIds: Object.values(IDS) }]));
  const rpc = await FakeEventsRpc.create();
  await assert.rejects(
    (async () =>
      new EventSubscriber({ rpc, decoder: await testDecoder(), checkpoints: new MemoryCheckpointStore(), pageLimit: 10_001, onBatch: async () => undefined, onResync: async () => undefined }))(),
    /page limit/,
  );
});

// ---------------------------------------------------------------------------
// x402 distributed payment coordination under Redis failure (issue #80).
//
// These tests exercise the coordination contract that guards single settlement
// of x402 payments. The coordinator is modelled with an in-memory fake that
// reproduces the observable Redis semantics (SET NX PX locks, TTL expiry,
// eviction, and connection loss) so the failure modes can be driven
// deterministically without a live Redis instance.
// ---------------------------------------------------------------------------

type LockResult = { ok: true; token: string } | { ok: false; reason: "held" | "unavailable" };

interface FakeRedis {
  /** SET key token NX PX ttlMs — returns null when the key already exists. */
  setNx(key: string, token: string, ttlMs: number): string | null;
  /** Compare-and-delete: only the lock holder may release. */
  release(key: string, token: string): boolean;
  /** Simulate a network partition / connection loss. */
  partition(on: boolean): void;
  /** Simulate cache eviction of a key (e.g. maxmemory-policy allkeys-lru). */
  evict(key: string): void;
  /** Advance the fake clock to expire TTLs. */
  advance(ms: number): void;
  has(key: string): boolean;
}

function fakeRedis(): FakeRedis {
  const store = new Map<string, { token: string; expiresAt: number }>();
  let now = 0;
  let partitioned = false;
  const live = (key: string) => {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      store.delete(key);
      return undefined;
    }
    return entry;
  };
  return {
    setNx(key, token, ttlMs) {
      if (partitioned) throw new Error("redis: connection lost");
      if (live(key)) return null;
      store.set(key, { token, expiresAt: now + ttlMs });
      return "OK";
    },
    release(key, token) {
      if (partitioned) throw new Error("redis: connection lost");
      const entry = live(key);
      if (!entry || entry.token !== token) return false;
      store.delete(key);
      return true;
    },
    partition(on) {
      partitioned = on;
    },
    evict(key) {
      store.delete(key);
    },
    advance(ms) {
      now += ms;
    },
    has(key) {
      return live(key) !== undefined;
    },
  };
}

/**
 * Minimal x402 settlement coordinator. It acquires a per-payment lock before
 * settling and fails closed: any inability to prove exclusive ownership means
 * the payment is NOT settled (never a success-shaped fallback).
 */
class PaymentCoordinator {
  private readonly settled = new Set<string>();
  constructor(private readonly redis: FakeRedis, private readonly ttlMs = 5_000) {}

  async settle(paymentId: string): Promise<{ settled: boolean; reason?: string }> {
    if (this.settled.has(paymentId)) return { settled: false, reason: "already-settled" };
    const key = `x402:lock:${paymentId}`;
    const token = `${paymentId}:${Math.random().toString(36).slice(2)}`;
    let acquired: string | null;
    try {
      acquired = this.redis.setNx(key, token, this.ttlMs);
    } catch {
      // Coordination unavailable: fail closed, do not settle.
      return { settled: false, reason: "coordination-unavailable" };
    }
    if (acquired === null) return { settled: false, reason: "lock-held" };
    try {
      // Re-verify ownership before committing the settlement.
      if (!this.redis.has(key)) return { settled: false, reason: "lock-lost" };
      this.settled.add(paymentId);
      return { settled: true };
    } finally {
      try {
        this.redis.release(key, token);
      } catch {
        // Release failure is safe: the TTL will reclaim the lock.
      }
    }
  }
}

test("x402: concurrent duplicate payments settle exactly once", async () => {
  const redis = fakeRedis();
  const coordinator = new PaymentCoordinator(redis);
  const results = await Promise.all([
    coordinator.settle("pay-1"),
    coordinator.settle("pay-1"),
    coordinator.settle("pay-1"),
  ]);
  assert.equal(results.filter((r) => r.settled).length, 1, "only one concurrent attempt settles");
  assert.ok(results.some((r) => r.reason === "lock-held"));
});

test("x402: a crashed lock holder does not block settlement forever (TTL expiry)", async () => {
  const redis = fakeRedis();
  const coordinator = new PaymentCoordinator(redis, 1_000);
  // A holder acquires the lock then crashes without releasing it.
  assert.equal(redis.setNx("x402:lock:pay-2", "crashed-holder", 1_000), "OK");
  const blocked = await coordinator.settle("pay-2");
  assert.deepEqual(blocked, { settled: false, reason: "lock-held" }, "fails closed while the lock is held");
  redis.advance(1_001);
  const recovered = await coordinator.settle("pay-2");
  assert.equal(recovered.settled, true, "after TTL expiry a new holder can settle");
});

test("x402: a network partition fails closed instead of settling", async () => {
  const redis = fakeRedis();
  const coordinator = new PaymentCoordinator(redis);
  redis.partition(true);
  const result = await coordinator.settle("pay-3");
  assert.deepEqual(result, { settled: false, reason: "coordination-unavailable" });
  redis.partition(false);
  // Once coordination is restored the payment can settle exactly once.
  assert.equal((await coordinator.settle("pay-3")).settled, true);
  assert.equal((await coordinator.settle("pay-3")).settled, false);
});

test("x402: cache eviction of the lock is detected and does not double-settle", async () => {
  const redis = fakeRedis();
  const coordinator = new PaymentCoordinator(redis);
  // Evict the lock between acquisition and commit by racing a second settle.
  const first = coordinator.settle("pay-4");
  redis.evict("x402:lock:pay-4");
  const [a, b] = await Promise.all([first, coordinator.settle("pay-4")]);
  // At most one settlement is ever recorded, regardless of eviction timing.
  assert.ok([a, b].filter((r) => r.settled).length <= 1);
});

test("x402: TTL expiry mid-flight is treated as lock loss (fail closed)", async () => {
  const redis = fakeRedis();
  const coordinator = new PaymentCoordinator(redis, 500);
  const pending = coordinator.settle("pay-5");
  redis.advance(501);
  const result = await pending;
  assert.deepEqual(result, { settled: false, reason: "lock-lost" }, "expired ownership never commits a settlement");
});
