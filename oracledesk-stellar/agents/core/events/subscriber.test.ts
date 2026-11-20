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

// --- Chaos: ambiguous transaction outcomes ---------------------------------
//
// These tests model the failure modes an agent faces when a submit/read
// partition, delayed finality, duplicate events, or a restart during in-flight
// work make the outcome of an economic action ambiguous. The invariant under
// test is that retries never cause a duplicate economic action: the persisted
// processed-id LRU plus the acknowledged-only checkpoint must make every
// redelivery idempotent.

async function chaosRig() {
  const checkpoints = new MemoryCheckpointStore();
  const rpc = await FakeEventsRpc.create();
  const actions: string[] = [];
  const run = async () => {
    const lru = new ProcessedLru(100, (await checkpoints.load()).processed);
    const dispatcher = new Dispatcher({
      lru,
      handlers: [{ name: "economic", kinds: ["Trade"], handle: async (e) => void actions.push(e.id) }],
    });
    return new EventSubscriber({
      rpc,
      decoder: await testDecoder(),
      checkpoints,
      onBatch: (e) => dispatcher.dispatch(e),
      onResync: async () => undefined,
      processedIds: () => lru.toJSON(),
    });
  };
  return { rpc, checkpoints, actions, run };
}

test("chaos: submit succeeds but the read fails, retry does not duplicate the action", async () => {
  const rig = await chaosRig();
  await (await rig.run()).pollOnce();
  const id = rig.rpc.emit(trade(1n, 1n, 1_001));
  // The submit landed on-chain, but the read that would confirm it fails.
  const original = rig.rpc.getEvents.bind(rig.rpc);
  let reads = 0;
  (rig.rpc as unknown as { getEvents: typeof rig.rpc.getEvents }).getEvents = async (req) => {
    if (reads++ === 0) throw new Error("read partition");
    return original(req);
  };
  await assert.rejects((await rig.run()).pollOnce(), /read partition/);
  assert.deepEqual(rig.actions, [], "no action recorded while the read is partitioned");
  // The partition heals; the retry re-reads the same event exactly once.
  await (await rig.run()).pollOnce();
  assert.deepEqual(rig.actions, [id]);
  // A further retry (e.g. another ambiguous read) must not re-execute.
  await (await rig.run()).pollOnce();
  assert.deepEqual(rig.actions, [id]);
});

test("chaos: read succeeds but the submit is ambiguous, retry does not duplicate the action", async () => {
  const rig = await chaosRig();
  await (await rig.run()).pollOnce();
  const id = rig.rpc.emit(trade(1n, 1n, 1_001));
  // The handler performs the economic action, then the acknowledgement is lost
  // (submit succeeded but the caller never saw the confirmation).
  const lru = new ProcessedLru(100, (await rig.checkpoints.load()).processed);
  let crash = true;
  const dispatcher = new Dispatcher({
    lru,
    handlers: [
      {
        name: "economic",
        kinds: ["Trade"],
        handle: async (e) => {
          rig.actions.push(e.id);
          if (crash) {
            crash = false;
            throw new Error("submit ack lost");
          }
        },
      },
    ],
  });
  const sub = new EventSubscriber({
    rpc: rig.rpc,
    decoder: await testDecoder(),
    checkpoints: rig.checkpoints,
    onBatch: (e) => dispatcher.dispatch(e),
    onResync: async () => undefined,
    processedIds: () => lru.toJSON(),
  });
  await assert.rejects(sub.pollOnce(), /submit ack lost/);
  // The retry redelivers the event; the LRU suppresses the duplicate action.
  await (await rig.run()).pollOnce();
  assert.deepEqual(rig.actions, [id], "the economic action ran exactly once");
});

test("chaos: delayed finality does not cause a duplicate action on retry", async () => {
  const rig = await chaosRig();
  await (await rig.run()).pollOnce();
  const id = rig.rpc.emit(trade(1n, 1n, 1_001));
  // Confirmation lags: the first poll sees the event but the checkpoint write
  // is delayed, so the cursor is not advanced and the event is redelivered.
  const saved = rig.checkpoints.saved;
  const originalSave = rig.checkpoints.save.bind(rig.checkpoints);
  let delay = true;
  rig.checkpoints.save = async (state) => {
    if (delay) {
      delay = false;
      // Simulate a lagging finality: persist the processed ids but not the cursor.
      await originalSave({ ...state, cursor: saved.cursor, lastLedger: saved.lastLedger });
      return;
    }
    await originalSave(state);
  };
  await (await rig.run()).pollOnce();
  await (await rig.run()).pollOnce();
  assert.deepEqual(rig.actions, [id], "delayed finality did not duplicate the action");
});

test("chaos: duplicate events are handled idempotently", async () => {
  const rig = await chaosRig();
  await (await rig.run()).pollOnce();
  const id = rig.rpc.emit(trade(1n, 1n, 1_001));
  await (await rig.run()).pollOnce();
  // The RPC redelivers the same event (duplicate event stream).
  rig.rpc.emit(trade(1n, 1n, 1_001));
  await (await rig.run()).pollOnce();
  assert.deepEqual(rig.actions, [id], "duplicate events produced a single action");
});

test("chaos: restart during in-flight work does not re-execute the action", async () => {
  const rig = await chaosRig();
  await (await rig.run()).pollOnce();
  const id = rig.rpc.emit(trade(1n, 1n, 1_001));
  // The action runs, then the process restarts before the checkpoint is saved.
  const lru = new ProcessedLru(100, (await rig.checkpoints.load()).processed);
  const dispatcher = new Dispatcher({
    lru,
    handlers: [
      {
        name: "economic",
        kinds: ["Trade"],
        handle: async (e) => {
          rig.actions.push(e.id);
          // Persist the processed id, then crash before the cursor advances.
          await rig.checkpoints.save({ ...rig.checkpoints.saved, processed: lru.toJSON() });
          throw new Error("restart during in-flight work");
        },
      },
    ],
  });
  const sub = new EventSubscriber({
    rpc: rig.rpc,
    decoder: await testDecoder(),
    checkpoints: rig.checkpoints,
    onBatch: (e) => dispatcher.dispatch(e),
    onResync: async () => undefined,
    processedIds: () => lru.toJSON(),
  });
  await assert.rejects(sub.pollOnce(), /restart during in-flight work/);
  // After the restart the cursor is stale, so the event is redelivered; the
  // persisted processed ids suppress the duplicate economic action.
  await (await rig.run()).pollOnce();
  assert.deepEqual(rig.actions, [id], "restart did not re-execute the action");
});
