import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { OracleDeskEvent } from "./decode.js";
import { Dispatcher, ProcessedLru } from "./dispatch.js";
import { FakeEventsRpc, testDecoder, trade } from "./testing.js";

async function events(specs: [bigint, number][]): Promise<OracleDeskEvent[]> {
  const rpc = await FakeEventsRpc.create();
  specs.forEach(([market, ledger]) => rpc.emit(trade(market, BigInt(ledger), ledger)));
  const page = await rpc.getEvents({ filters: [{ type: "contract" }], startLedger: 1, limit: 1_000 } as never);
  const d = await testDecoder();
  return page.events.map((e) => d.decode(e)!);
}

const noSleep = async () => undefined;

test("events of one market run in order while different markets run concurrently", async () => {
  // Interleaved: market 0..3, five events each.
  const batch = await events(Array.from({ length: 20 }, (_, i) => [BigInt(i % 4), 10 + i] as [bigint, number]));
  const order = new Map<string, bigint[]>();
  let running = 0;
  let peak = 0;
  const dispatcher = new Dispatcher({
    concurrency: 3,
    sleep: noSleep,
    handlers: [
      {
        name: "slow",
        kinds: ["Trade"],
        async handle(e) {
          if (e.kind !== "Trade") return;
          running++;
          peak = Math.max(peak, running);
          // Deterministic, uneven delays so lanes finish out of step.
          await new Promise((r) => setTimeout(r, Number((e.collateral * 7n) % 5n)));
          order.set(String(e.marketId), [...(order.get(String(e.marketId)) ?? []), e.collateral]);
          running--;
        },
      },
    ],
  });
  await dispatcher.dispatch(batch);
  for (const [market, seen] of order) {
    assert.deepEqual(seen, [...seen].sort((a, b) => Number(a - b)), `market ${market} out of order`);
    assert.equal(seen.length, 5);
  }
  assert.equal(peak, 3, "three markets in flight at once, never more");
});

test("a processed event is not delivered twice", async () => {
  const [e] = await events([[1n, 10]]);
  const calls: string[] = [];
  const lru = new ProcessedLru(2);
  const dispatcher = new Dispatcher({ lru, sleep: noSleep, handlers: [{ name: "h", kinds: ["Trade"], handle: async (x) => void calls.push(x.id) }] });
  await dispatcher.dispatch([e]);
  await dispatcher.dispatch([e]);
  assert.deepEqual(calls, [e.id]);
  lru.add("a");
  lru.add("b");
  assert.equal(lru.has(e.id), false, "the LRU forgets the oldest id at capacity");
});

test("a transient handler failure is retried with backoff", async () => {
  const [e] = await events([[1n, 10]]);
  const waits: number[] = [];
  let attempts = 0;
  const dispatcher = new Dispatcher({
    maxAttempts: 4,
    backoffBaseMs: 100,
    sleep: async (ms) => void waits.push(ms),
    deadLetterPath: join(mkdtempSync(join(tmpdir(), "dl-")), "dead-letter.jsonl"),
    handlers: [{ name: "flaky", kinds: ["Trade"], handle: async () => { if (++attempts < 3) throw new Error("rpc down"); } }],
  });
  await dispatcher.dispatch([e]);
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [100, 200]);
});

test("after retries are exhausted the event is dead-lettered and the batch still completes", async () => {
  const batch = await events([[1n, 10], [2n, 11]]);
  const path = join(mkdtempSync(join(tmpdir(), "dl-")), "nested", "dead-letter.jsonl");
  const handled: bigint[] = [];
  const dispatcher = new Dispatcher({
    maxAttempts: 3,
    sleep: noSleep,
    deadLetterPath: path,
    handlers: [
      {
        name: "poisoned",
        kinds: ["Trade"],
        async handle(e) {
          if (e.kind === "Trade" && e.marketId === 1n) throw new Error("cannot handle market 1");
          if (e.kind === "Trade") handled.push(e.marketId);
        },
      },
    ],
  });
  await dispatcher.dispatch(batch);
  assert.deepEqual(handled, [2n]);
  const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].handler, "poisoned");
  assert.equal(lines[0].attempts, 3);
  assert.equal(lines[0].event.marketId, "1");
  assert.match(lines[0].error, /cannot handle market 1/);
  assert.ok(dispatcher.lru.has(batch[0].id), "a dead-lettered event is not redelivered forever");
});

test("handlers only see the kinds they subscribe to", async () => {
  const [e] = await events([[1n, 10]]);
  let called = false;
  await new Dispatcher({ handlers: [{ name: "final", kinds: ["MarketResolved"], handle: async () => void (called = true) }] }).dispatch([e]);
  assert.equal(called, false);
});

// --- Chaos: ambiguous transaction outcomes ---------------------------------
//
// These tests model the failure modes an agent sees when a submit succeeds but
// the read-back (or the reverse) is partitioned, when finality lags, when the
// event stream duplicates an event, and when the process restarts mid-flight.
// The invariant under test is that retries never cause a *duplicate economic
// action*: the handler may be invoked again, but the economic side effect must
// be applied at most once per event id.

/**
 * A tiny economic ledger keyed by event id. `apply` is idempotent: a second
 * application of the same event id is a no-op, mirroring how an on-chain
 * action keyed by a unique id cannot be re-executed. `attempts` counts every
 * call so we can prove retries happened without duplicating the effect.
 */
class EconomicLedger {
  readonly applied = new Map<string, bigint>();
  attempts = 0;
  apply(id: string, amount: bigint): void {
    this.attempts++;
    if (this.applied.has(id)) return;
    this.applied.set(id, amount);
  }
  total(): bigint {
    let sum = 0n;
    for (const v of this.applied.values()) sum += v;
    return sum;
  }
}

/**
 * Simulates a submit/read partition. `submitOk` controls whether the write
 * lands; `readOk` controls whether the confirmation can be observed. A submit
 * that lands but whose read fails is the classic ambiguous outcome: the caller
 * cannot tell success from failure and must retry safely.
 */
class PartitionedSubmitter {
  submitOk = true;
  readOk = true;
  submits = 0;
  reads = 0;
  async submit(): Promise<{ landed: boolean }> {
    this.submits++;
    if (!this.submitOk) throw new Error("submit partition: write rejected");
    return { landed: true };
  }
  async read(): Promise<{ confirmed: boolean }> {
    this.reads++;
    if (!this.readOk) throw new Error("read partition: confirmation unavailable");
    return { confirmed: true };
  }
}

test("chaos: submit succeeds but read fails, retry does not duplicate the economic action", async () => {
  const [e] = await events([[1n, 10]]);
  const ledger = new EconomicLedger();
  const net = new PartitionedSubmitter();
  net.readOk = false; // submit lands, confirmation is partitioned away
  let attempts = 0;
  const dispatcher = new Dispatcher({
    maxAttempts: 4,
    sleep: noSleep,
    deadLetterPath: join(mkdtempSync(join(tmpdir(), "dl-")), "dead-letter.jsonl"),
    handlers: [
      {
        name: "settle",
        kinds: ["Trade"],
        async handle(ev) {
          if (ev.kind !== "Trade") return;
          attempts++;
          await net.submit();
          // Read-back is partitioned on the first attempt; the retry observes it.
          if (attempts === 1) await net.read();
          ledger.apply(ev.id, ev.collateral);
        },
      },
    ],
  });
  await dispatcher.dispatch([e]);
  assert.equal(attempts, 2, "the ambiguous outcome forced exactly one retry");
  assert.equal(net.submits, 2, "submit was retried");
  assert.equal(ledger.applied.size, 1, "only one economic action landed");
  assert.equal(ledger.total(), e.kind === "Trade" ? e.collateral : 0n);
});

test("chaos: submit fails but read succeeds, retry does not duplicate the economic action", async () => {
  const [e] = await events([[1n, 10]]);
  const ledger = new EconomicLedger();
  const net = new PartitionedSubmitter();
  net.submitOk = false; // write is partitioned away, read still answers
  let attempts = 0;
  const dispatcher = new Dispatcher({
    maxAttempts: 4,
    sleep: noSleep,
    deadLetterPath: join(mkdtempSync(join(tmpdir(), "dl-")), "dead-letter.jsonl"),
    handlers: [
      {
        name: "settle",
        kinds: ["Trade"],
        async handle(ev) {
          if (ev.kind !== "Trade") return;
          attempts++;
          if (attempts === 1) {
            await assert.rejects(net.submit());
            return; // no economic action on the failed submit
          }
          await net.submit();
          ledger.apply(ev.id, ev.collateral);
        },
      },
    ],
  });
  await dispatcher.dispatch([e]);
  assert.equal(attempts, 2);
  assert.equal(ledger.applied.size, 1, "the failed submit did not double-apply");
});

test("chaos: delayed finality does not duplicate the economic action on retry", async () => {
  const [e] = await events([[1n, 10]]);
  const ledger = new EconomicLedger();
  let attempts = 0;
  const dispatcher = new Dispatcher({
    maxAttempts: 4,
    sleep: noSleep,
    deadLetterPath: join(mkdtempSync(join(tmpdir(), "dl-")), "dead-letter.jsonl"),
    handlers: [
      {
        name: "settle",
        kinds: ["Trade"],
        async handle(ev) {
          if (ev.kind !== "Trade") return;
          attempts++;
          // Confirmation lags: the first attempt times out waiting for finality.
          if (attempts === 1) throw new Error("finality timeout");
          ledger.apply(ev.id, ev.collateral);
        },
      },
    ],
  });
  await dispatcher.dispatch([e]);
  assert.equal(attempts, 2, "the lagging confirmation forced a retry");
  assert.equal(ledger.applied.size, 1, "delayed finality did not double-apply");
});

test("chaos: duplicate events are handled idempotently", async () => {
  const [e] = await events([[1n, 10]]);
  const ledger = new EconomicLedger();
  const lru = new ProcessedLru(64);
  const dispatcher = new Dispatcher({
    lru,
    sleep: noSleep,
    handlers: [{ name: "settle", kinds: ["Trade"], handle: async (ev) => { if (ev.kind === "Trade") ledger.apply(ev.id, ev.collateral); } }],
  });
  // The same event arrives three times (reorg replay / duplicate stream).
  await dispatcher.dispatch([e]);
  await dispatcher.dispatch([e]);
  await dispatcher.dispatch([e]);
  assert.equal(ledger.attempts, 1, "the LRU suppressed duplicate deliveries");
  assert.equal(ledger.applied.size, 1);
});

test("chaos: restart during in-flight work does not re-execute the economic action", async () => {
  const [e] = await events([[1n, 10]]);
  const ledger = new EconomicLedger();
  const lru = new ProcessedLru(64);
  // First process: the handler applies the economic action then "crashes"
  // before the dispatcher can record completion. We simulate the crash by
  // throwing after the effect lands, so the event is retried.
  let crashed = false;
  const first = new Dispatcher({
    lru,
    maxAttempts: 2,
    sleep: noSleep,
    deadLetterPath: join(mkdtempSync(join(tmpdir(), "dl-")), "dead-letter.jsonl"),
    handlers: [
      {
        name: "settle",
        kinds: ["Trade"],
        async handle(ev) {
          if (ev.kind !== "Trade") return;
          ledger.apply(ev.id, ev.collateral);
          if (!crashed) {
            crashed = true;
            throw new Error("process restart mid-flight");
          }
        },
      },
    ],
  });
  await first.dispatch([e]);
  // Second process: a fresh dispatcher replays the same event from the stream.
  const second = new Dispatcher({
    lru,
    sleep: noSleep,
    handlers: [{ name: "settle", kinds: ["Trade"], handle: async (ev) => { if (ev.kind === "Trade") ledger.apply(ev.id, ev.collateral); } }],
  });
  await second.dispatch([e]);
  assert.equal(ledger.applied.size, 1, "recovery did not re-execute the economic action");
  assert.equal(ledger.total(), e.kind === "Trade" ? e.collateral : 0n);
});
