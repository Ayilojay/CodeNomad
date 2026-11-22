import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraderAgent } from "./trader.js";
import type { LedgerStore } from "../src/ledger.js";

type SubmitResult = { hash: string };

/**
 * Chaos harness for ambiguous transaction outcomes.
 *
 * The trader agent must never perform a duplicate economic action when a
 * submit/read partition, delayed finality, duplicate event, or restart during
 * in-flight work makes the outcome of a transaction ambiguous. These tests
 * inject those faults and assert the ledger + retry logic stays idempotent.
 */

function makeLedger(dir: string): LedgerStore {
  return {
    path: join(dir, "ledger.json"),
    load: () => (existsSync(join(dir, "ledger.json")) ? JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8")) : { intents: {} }),
    save: (state: unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require("node:fs").writeFileSync(join(dir, "ledger.json"), JSON.stringify(state));
    },
  } as unknown as LedgerStore;
}

describe("trader chaos: ambiguous transaction outcomes", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "trader-chaos-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not duplicate economic action when submit succeeds but read fails", async () => {
    const ledger = makeLedger(dir);
    let submits = 0;
    const agent = new TraderAgent({
      ledger,
      submit: async (): Promise<SubmitResult> => {
        submits += 1;
        return { hash: "tx-submit-ok" };
      },
      read: async () => {
        throw new Error("read partition: horizon unreachable");
      },
    });

    const intent = { id: "intent-1", action: "swap", amount: "10" };
    await expect(agent.execute(intent)).rejects.toThrow(/read partition/);
    // Retry after the read partition heals: the intent is already recorded as
    // submitted, so the economic action must not be re-submitted.
    await agent.execute(intent);
    expect(submits).toBe(1);
  });

  it("does not duplicate economic action when read succeeds but submit fails", async () => {
    const ledger = makeLedger(dir);
    let submits = 0;
    const agent = new TraderAgent({
      ledger,
      submit: async (): Promise<SubmitResult> => {
        submits += 1;
        if (submits === 1) throw new Error("submit partition: timeout");
        return { hash: "tx-submit-ok" };
      },
      read: async () => ({ status: "not_found" }),
    });

    const intent = { id: "intent-2", action: "swap", amount: "10" };
    await expect(agent.execute(intent)).rejects.toThrow(/submit partition/);
    await agent.execute(intent);
    expect(submits).toBe(2);
    // Only one economic action should be recorded as committed.
    const state = ledger.load() as { intents: Record<string, { status: string }> };
    expect(state.intents["intent-2"].status).toBe("submitted");
  });

  it("does not duplicate economic action under delayed finality", async () => {
    const ledger = makeLedger(dir);
    let submits = 0;
    let reads = 0;
    const agent = new TraderAgent({
      ledger,
      submit: async (): Promise<SubmitResult> => {
        submits += 1;
        return { hash: "tx-delayed" };
      },
      read: async () => {
        reads += 1;
        // Confirmation lags: first reads report pending, then success.
        return reads < 3 ? { status: "pending" } : { status: "success" };
      },
    });

    const intent = { id: "intent-3", action: "swap", amount: "10" };
    await agent.execute(intent);
    await agent.execute(intent);
    await agent.execute(intent);
    expect(submits).toBe(1);
  });

  it("handles duplicate events idempotently", async () => {
    const ledger = makeLedger(dir);
    let submits = 0;
    const agent = new TraderAgent({
      ledger,
      submit: async (): Promise<SubmitResult> => {
        submits += 1;
        return { hash: "tx-dup" };
      },
      read: async () => ({ status: "success" }),
    });

    const intent = { id: "intent-4", action: "swap", amount: "10" };
    const event = { intentId: "intent-4", hash: "tx-dup", status: "success" };
    await agent.execute(intent);
    await agent.onEvent(event);
    await agent.onEvent(event);
    await agent.onEvent(event);
    expect(submits).toBe(1);
    const state = ledger.load() as { intents: Record<string, { status: string }> };
    expect(state.intents["intent-4"].status).toBe("confirmed");
  });

  it("does not re-execute economic action after restart during in-flight work", async () => {
    const ledger = makeLedger(dir);
    let submits = 0;
    const submit = async (): Promise<SubmitResult> => {
      submits += 1;
      return { hash: "tx-restart" };
    };

    const first = new TraderAgent({
      ledger,
      submit,
      read: async () => {
        throw new Error("crash: process killed mid-flight");
      },
    });
    const intent = { id: "intent-5", action: "swap", amount: "10" };
    await expect(first.execute(intent)).rejects.toThrow(/crash/);

    // Simulate restart: a fresh agent instance loads the persisted ledger.
    const restarted = new TraderAgent({
      ledger,
      submit,
      read: async () => ({ status: "success" }),
    });
    await restarted.execute(intent);
    expect(submits).toBe(1);
  });
});

describe("trader sequence reconciliation: outcome classification", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "trader-seq-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeAgent(overrides: Record<string, unknown> = {}) {
    const ledger = makeLedger(dir);
    let submits = 0;
    const agent = new TraderAgent({
      ledger,
      submit: async (): Promise<SubmitResult> => {
        submits += 1;
        return { hash: `tx-${submits}` };
      },
      read: async () => ({ status: "success" }),
      ...overrides,
    });
    return { agent, ledger, submits: () => submits };
  }

  it("classifies a sequence conflict and rebuilds only after proving the prior intent did not land", async () => {
    const { agent, submits } = makeAgent({
      submit: async (): Promise<SubmitResult> => {
        throw new Error("tx_bad_seq: sequence conflict");
      },
      read: async () => ({ status: "not_found" }),
    });
    const intent = { id: "intent-seq", action: "swap", amount: "10" };
    const outcome = await agent.reconcile(intent);
    expect(outcome.kind).toBe("sequence_conflict");
    expect(outcome.rebuild).toBe(true);
    expect(submits()).toBe(0);
  });

  it("does not rebuild on sequence conflict when the prior intent is observed on-chain", async () => {
    const { agent } = makeAgent({
      submit: async (): Promise<SubmitResult> => {
        throw new Error("tx_bad_seq: sequence conflict");
      },
      read: async () => ({ status: "success", hash: "tx-landed" }),
    });
    const intent = { id: "intent-seq-landed", action: "swap", amount: "10" };
    const outcome = await agent.reconcile(intent);
    expect(outcome.kind).toBe("accepted_unobserved");
    expect(outcome.rebuild).toBe(false);
  });

  it("classifies an expired transaction and rebuilds after proving it did not land", async () => {
    const { agent } = makeAgent({
      submit: async (): Promise<SubmitResult> => {
        throw new Error("tx_too_late: transaction expired");
      },
      read: async () => ({ status: "not_found" }),
    });
    const intent = { id: "intent-expired", action: "swap", amount: "10" };
    const outcome = await agent.reconcile(intent);
    expect(outcome.kind).toBe("expired");
    expect(outcome.rebuild).toBe(true);
  });

  it("classifies accepted-but-unobserved and does not rebuild", async () => {
    const { agent } = makeAgent({
      submit: async (): Promise<SubmitResult> => ({ hash: "tx-accepted" }),
      read: async () => ({ status: "pending" }),
    });
    const intent = { id: "intent-accepted", action: "swap", amount: "10" };
    const outcome = await agent.reconcile(intent);
    expect(outcome.kind).toBe("accepted_unobserved");
    expect(outcome.rebuild).toBe(false);
  });

  it("classifies a final failure and does not rebuild", async () => {
    const { agent } = makeAgent({
      submit: async (): Promise<SubmitResult> => {
        throw new Error("tx_failed: op underfunded");
      },
      read: async () => ({ status: "failed" }),
    });
    const intent = { id: "intent-failed", action: "swap", amount: "10" };
    const outcome = await agent.reconcile(intent);
    expect(outcome.kind).toBe("final_failure");
    expect(outcome.rebuild).toBe(false);
  });

  it("treats a duplicate submit response as accepted-but-unobserved without rebuilding", async () => {
    const { agent } = makeAgent({
      submit: async (): Promise<SubmitResult> => {
        throw new Error("tx_duplicate: already submitted");
      },
      read: async () => ({ status: "pending" }),
    });
    const intent = { id: "intent-dup", action: "swap", amount: "10" };
    const outcome = await agent.reconcile(intent);
    expect(outcome.kind).toBe("accepted_unobserved");
    expect(outcome.rebuild).toBe(false);
  });
});

describe("trader calibrated fair-value: uncertainty bounds and edge gating", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "trader-calib-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeAgent(overrides: Record<string, unknown> = {}) {
    const ledger = makeLedger(dir);
    let submits = 0;
    const agent = new TraderAgent({
      ledger,
      submit: async (): Promise<SubmitResult> => {
        submits += 1;
        return { hash: `tx-${submits}` };
      },
      read: async () => ({ status: "success" }),
      ...overrides,
    });
    return { agent, ledger, submits: () => submits };
  }

  it("rejects stale fair-value inputs before proposing a trade", async () => {
    const { agent, submits } = makeAgent({
      now: () => 1_000_000,
      maxFairValueAgeMs: 5_000,
      minEdgeBps: 10,
      feeBps: 5,
    });
    const estimate = {
      fairValue: 1.0,
      confidence: 0.9,
      observedAt: 1_000_000 - 60_000, // 60s old, well past 5s freshness window
    };
    const decision = await agent.proposeTrade({
      id: "intent-stale",
      action: "swap",
      amount: "10",
      marketPrice: 0.9,
      estimate,
    });
    expect(decision.proposed).toBe(false);
    expect(decision.reason).toMatch(/stale/i);
    expect(submits()).toBe(0);
  });

  it("treats zero confidence as maximum uncertainty and blocks the trade", async () => {
    const { agent, submits } = makeAgent({
      now: () => 1_000_000,
      maxFairValueAgeMs: 5_000,
      minEdgeBps: 10,
      feeBps: 5,
    });
    const decision = await agent.proposeTrade({
      id: "intent-lowconf",
      action: "swap",
      amount: "10",
      marketPrice: 0.5,
      estimate: { fairValue: 1.0, confidence: 0, observedAt: 1_000_000 },
    });
    expect(decision.proposed).toBe(false);
    expect(decision.reason).toMatch(/confidence|uncertainty/i);
    expect(submits()).toBe(0);
  });

  it("treats full confidence as zero uncertainty and allows a clear edge", async () => {
    const { agent } = makeAgent({
      now: () => 1_000_000,
      maxFairValueAgeMs: 5_000,
      minEdgeBps: 10,
      feeBps: 5,
    });
    const decision = await agent.proposeTrade({
      id: "intent-highconf",
      action: "swap",
      amount: "10",
      marketPrice: 0.5,
      estimate: { fairValue: 1.0, confidence: 1, observedAt: 1_000_000 },
    });
    expect(decision.proposed).toBe(true);
    expect(decision.edgeBps).toBeGreaterThanOrEqual(10);
  });
});
