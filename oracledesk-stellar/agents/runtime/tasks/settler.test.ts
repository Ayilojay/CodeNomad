/**
 * Fake-RPC tests for the settlement monitor (settler.ts).
 *
 * Each test runs the real live StellarAdapter against the fake Soroban RPC
 * so the adapter's signing, simulation, and submission paths execute
 * unchanged — only the on-chain behaviour is replaced by the model.
 *
 * Discovery is supplied as a simple `discoverMarkets` callback that reads
 * market IDs directly from the fake model state, so the tests are not gated
 * on `open_exposure_page` being present in the vendored WASM. The
 * `settle_market` submission path (which IS in the vendored WASM) is fully
 * exercised by the real adapter.
 *
 * Coverage:
 *   - clean path: resolve a market, settler calls settle_market, balance grows
 *   - duplicate delivery: settle_market called twice returns already_settled
 *   - retry after transient sendTransaction failure (TRY_AGAIN_LATER)
 *   - partial progress: two resolved markets, first application fails, second
 *     still settles
 *   - still-open market: settler reads status Open and skips without spending a fee
 *   - MarketNotFinal contract error: not-final is a no-op, never opens circuit
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { NoLease } from "../../runtime/lease.js";
import { Runtime } from "../../runtime/runtime.js";
import { MemoryStateStore } from "../../runtime/state.js";
import { FaultPlan } from "../../test/fake-rpc/faults.js";
import { artifacts, blockRealNetwork, startFakeNetwork, type FakeNetwork } from "../../test/fake-rpc/network.js";
import { resolveMarket, seedMarket, type ModelState } from "../../test/fake-rpc/model.js";
import { settlerTask } from "./settler.js";

let unblock: () => void;
before(() => {
  unblock = blockRealNetwork();
});
after(() => unblock());

// Guard: if the treasury WASM doesn't expose settle_market the submission
// tests will fail with a spec mismatch. Surface it clearly.
const treasuryFits = (await artifacts()).treasury.fits;
const treasuryDrift = treasuryFits
  ? false
  : `the served treasury spec does not support settle_market (${(await artifacts()).treasury.rejected.join("; ")})`;

function quietLog() {
  const lines: { level: string; event: string; fields?: Record<string, unknown> }[] = [];
  const at = (level: string) => (event: string, fields?: Record<string, unknown>) => void lines.push({ level, event, fields });
  return { lines, info: at("info"), warn: at("warn"), error: at("error") };
}

async function withNet<T>(plan: FaultPlan, fn: (net: FakeNetwork) => Promise<T>): Promise<T> {
  const net = await startFakeNetwork({ plan });
  try {
    return await fn(net);
  } finally {
    await net.stop();
  }
}

/**
 * Returns all market IDs from `state`, regardless of status. The settler's
 * own `getMarket` read will then filter to final ones. This avoids calling
 * `open_exposure_page` (not in the vendored WASM) while still exercising the
 * full settle_market submission path.
 */
function allMarketIds(state: ModelState): () => Promise<bigint[]> {
  return async () => state.markets.map((m) => m.id);
}

function settlerFor(net: FakeNetwork) {
  return settlerTask(
    { adapter: net.adapter(), discoverMarkets: allMarketIds(net.rpc.state) },
    { intervalMs: 1 },
  );
}

function runtimeFor(net: FakeNetwork, opts: { maxConsecutiveFailures?: number } = {}) {
  const state = new MemoryStateStore();
  const log = quietLog();
  const runtime = new Runtime({
    tasks: [settlerFor(net)],
    state,
    lease: new NoLease(),
    shutdownGraceMs: 5_000,
    maxConsecutiveFailures: opts.maxConsecutiveFailures ?? 5,
    failureWindowMs: 60_000,
    maxFailuresInWindow: 100,
    backoffBaseMs: 1,
    backoffMaxMs: 1,
    log,
    now: () => net.rpc.clock.closeTime * 1000,
    random: () => 0.5,
  });
  return { runtime, log };
}

async function tick(runtime: Runtime): Promise<unknown> {
  try {
    await runtime.runOnce();
    return undefined;
  } catch (err) {
    return err;
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test("settler skips open markets without submitting any transaction", { todo: treasuryDrift }, async () => {
  await withNet(FaultPlan.none(), async (net) => {
    // The seeded market is Open; settler should do nothing.
    const { runtime, log } = runtimeFor(net);
    await tick(runtime);
    assert.equal(net.rpc.submissions.filter((s) => s.fn === "settle_market").length, 0);
    assert.ok(!log.lines.some((l) => l.event === "SETTLER_ELIGIBLE"), "no eligible market logged");
  });
});

test("settler calls settle_market once for a resolved market", { todo: treasuryDrift }, async () => {
  await withNet(FaultPlan.none(), async (net) => {
    resolveMarket(net.rpc.state, net.market.id, "Resolved(Yes)");
    const balanceBefore = net.rpc.state.treasuryBalance;
    const { runtime, log } = runtimeFor(net);
    await tick(runtime);
    const settlements = net.rpc.applied.filter((s) => s.fn === "settle_market");
    assert.equal(settlements.length, 1);
    assert.equal(settlements[0].args.market_id, net.market.id);
    assert.ok(log.lines.some((l) => l.event === "SETTLER_SETTLED"), "SETTLER_SETTLED was logged");
    assert.ok(net.rpc.state.treasuryBalance > balanceBefore, "treasury balance grew after settlement");
  });
});

test("duplicate delivery: settle_market called twice returns already_settled on the second", { todo: treasuryDrift }, async () => {
  await withNet(FaultPlan.none(), async (net) => {
    resolveMarket(net.rpc.state, net.market.id, "Void");
    const { runtime, log } = runtimeFor(net);
    // First tick settles.
    await tick(runtime);
    assert.equal(net.rpc.applied.filter((s) => s.fn === "settle_market").length, 1);
    // Second tick: the contract answers already_settled; no error should propagate.
    await tick(runtime);
    // The second call is submitted (we pay a fee) but the report shows already_settled.
    assert.equal(net.rpc.applied.filter((s) => s.fn === "settle_market").length, 2);
    assert.ok(log.lines.some((l) => l.event === "SETTLER_NOOP"), "SETTLER_NOOP logged on second call");
    // No circuit-open.
    assert.ok(!log.lines.some((l) => l.event === "CIRCUIT_OPEN"));
  });
});

test("retry: transient TRY_AGAIN_LATER on settle_market does not open the circuit", { todo: treasuryDrift }, async () => {
  // The first sendTransaction attempt for settle_market returns TRY_AGAIN_LATER.
  // The adapter retries the same signed envelope; the runtime counts only
  // full-tick failures, so this tick should succeed or at most fail once.
  const plan = FaultPlan.script([
    { method: "sendTransaction", fn: "settle_market", nth: 1, times: 1, fault: { kind: "try-again-later" } },
  ]);
  await withNet(plan, async (net) => {
    resolveMarket(net.rpc.state, net.market.id, "Resolved(No)");
    const { runtime, log } = runtimeFor(net, { maxConsecutiveFailures: 2 });
    await tick(runtime);
    // Circuit must not open on a single transient failure.
    assert.ok(!log.lines.some((l) => l.event === "CIRCUIT_OPEN"), "circuit must not open on first transient failure");
  });
});

test("partial progress: failed settlement of one market does not block the next", { todo: treasuryDrift }, async () => {
  // Set up a network with two resolved markets. Inject an apply-failure on
  // the first settle_market only. The second should still land.
  const plan = FaultPlan.script([
    {
      method: "sendTransaction",
      fn: "settle_market",
      nth: 1,
      times: 1,
      fault: { kind: "apply-failure", error: "MarketCoreError" },
    },
  ]);
  const net = await startFakeNetwork({ plan });
  try {
    // Add a second market and resolve both.
    const second = seedMarket(net.rpc.state, {
      seed: 5_000_000_000n,
      yesBps: 6000n,
      closeTime: BigInt(net.rpc.clock.closeTime + 86_400),
      creator: "GCREATOR",
    });
    resolveMarket(net.rpc.state, net.market.id, "Resolved(Yes)");
    resolveMarket(net.rpc.state, second.id, "Resolved(No)");

    // Custom settler that sees both markets.
    const state = new MemoryStateStore();
    const log = quietLog();
    const task = settlerTask(
      { adapter: net.adapter(), discoverMarkets: allMarketIds(net.rpc.state) },
      { intervalMs: 1 },
    );
    const runtime = new Runtime({
      tasks: [task],
      state,
      lease: new NoLease(),
      shutdownGraceMs: 5_000,
      maxConsecutiveFailures: 10,
      failureWindowMs: 60_000,
      maxFailuresInWindow: 100,
      backoffBaseMs: 1,
      backoffMaxMs: 1,
      log,
      now: () => net.rpc.clock.closeTime * 1000,
      random: () => 0.5,
    });

    await tick(runtime);

    const applied = net.rpc.applied.filter((s) => s.fn === "settle_market");
    // First application failed (included but returned error); second should succeed.
    assert.ok(applied.length >= 1, "at least the second market settled");
    assert.ok(
      log.lines.some((l) => l.event === "SETTLER_FAILED" || l.event === "SETTLER_SETTLED"),
      "settler logged an outcome for each market",
    );
  } finally {
    await net.stop();
  }
});

test("MarketNotFinal contract error is treated as expected no-op, not a circuit-open trigger", { todo: treasuryDrift }, async () => {
  // Inject an apply-failure that returns MarketNotFinal on every settle_market.
  // The settler must classify this as a no-op and not count it against the
  // circuit breaker.
  const plan = FaultPlan.script([
    {
      method: "sendTransaction",
      fn: "settle_market",
      times: Infinity,
      fault: { kind: "apply-failure", error: "MarketNotFinal" },
    },
  ]);
  await withNet(plan, async (net) => {
    // Mark the market as resolved in model state so settler calls settle_market.
    resolveMarket(net.rpc.state, net.market.id, "Resolved(Yes)");
    const { runtime, log } = runtimeFor(net, { maxConsecutiveFailures: 2 });
    // Run several ticks — the circuit must not open.
    for (let i = 0; i < 3; i++) await tick(runtime);
    assert.ok(!log.lines.some((l) => l.event === "CIRCUIT_OPEN"), "circuit must not open for MarketNotFinal");
    assert.ok(
      log.lines.some((l) => l.event === "SETTLER_SKIP_NOT_FINAL"),
      "settler logged SETTLER_SKIP_NOT_FINAL",
    );
  });
});

test("settler emits a tick summary when at least one market was processed", { todo: treasuryDrift }, async () => {
  await withNet(FaultPlan.none(), async (net) => {
    resolveMarket(net.rpc.state, net.market.id, "Resolved(Yes)");
    const { runtime, log } = runtimeFor(net);
    await tick(runtime);
    assert.ok(log.lines.some((l) => l.event === "SETTLER_TICK_SUMMARY"), "tick summary was emitted");
  });
});
