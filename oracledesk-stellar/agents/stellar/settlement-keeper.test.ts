import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  Account, Keypair, Networks, SorobanDataBuilder, StrKey, Transaction, xdr, type rpc,
} from "@stellar/stellar-sdk";
import { createJournalRecord, TransactionJournal } from "./journal.js";
import { runSettlementKeeper, type KeeperOptions } from "./settlement-keeper.js";

const source = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 17));
const marketCore = StrKey.encodeContract(Buffer.alloc(32, 9));
const meta = { id: "fake", latestLedger: 10, events: [], _parsed: true };
const result = (retval: xdr.ScVal): rpc.Api.SimulateTransactionSuccessResponse => ({
  ...meta,
  transactionData: new SorobanDataBuilder(),
  minResourceFee: "0",
  result: { auth: [], retval },
});

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "settlement-keeper-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const simulated: string[] = [];
  const sent: Transaction[] = [];
  const reports: string[] = [];
  const cursors: bigint[] = [];
  const journal = new TransactionJournal(join(dir, "transactions.jsonl"));
  let restored = false;
  const options: KeeperOptions = {
    marketCore,
    source: source.publicKey(),
    networkPassphrase: Networks.TESTNET,
    limit: 2,
    maxFee: 10_000n,
    journal,
    report: ({ status }) => reports.push(status),
    checkpoint: async (cursor) => { cursors.push(cursor); },
    server: {
      getAccount: async () => new Account(source.publicKey(), String(sent.length)),
      simulateTransaction: async (envelope) => {
        assert.ok(envelope instanceof Transaction);
        const operation = envelope.operations[0];
        assert.equal(operation.type, "invokeHostFunction");
        if (operation.type !== "invokeHostFunction") throw new Error("unexpected operation");
        const call = operation.func.invokeContract();
        const fn = call.functionName().toString();
        if (fn === "market_count") {
          simulated.push(fn);
          return result(xdr.ScVal.scvU64(xdr.Uint64.fromString("3")));
        }
        assert.equal(fn, "finalize_market");
        const id = call.args()[0].u64().toString();
        simulated.push(id);
        if (id === "1") return { ...meta, error: "Error(Contract, #28)" };
        const success = result(xdr.ScVal.scvVoid());
        if (id === "0" && !restored) {
          return {
            ...success,
            result: { auth: [], retval: xdr.ScVal.scvVoid() },
            restorePreamble: {
              transactionData: new SorobanDataBuilder(),
              minResourceFee: "0",
            },
          };
        }
        return success;
      },
      sendTransaction: async (envelope) => {
        assert.ok(envelope instanceof Transaction);
        sent.push(envelope);
        if (envelope.operations[0].type === "restoreFootprint") restored = true;
        return {
          status: "PENDING",
          hash: envelope.hash().toString("hex"),
          latestLedger: 10,
          latestLedgerCloseTime: 0,
        };
      },
      getTransaction: async (hash) => ({
        status: "SUCCESS",
        txHash: hash,
      }) as Awaited<ReturnType<rpc.Server["getTransaction"]>>,
    },
  };
  const sign = async (unsigned: string) => {
    const tx = new Transaction(unsigned, Networks.TESTNET);
    tx.sign(source);
    return tx.toXDR();
  };
  return { options, sign, simulated, sent, reports, cursors };
}

test("dry-run reports archived and ineligible markets within the scan bound", async (t) => {
  const f = await fixture(t);
  await runSettlementKeeper(f.options, 0n);
  assert.deepEqual(f.simulated, ["market_count", "0", "1"]);
  assert.deepEqual(f.reports, ["restore-required", "redemption-window-open"]);
  assert.deepEqual(f.cursors, [1n, 2n]);
  assert.deepEqual(f.sent, []);
});

test("keeper restores separately, re-simulates, and settles using a fresh sequence", async (t) => {
  const f = await fixture(t);
  await runSettlementKeeper({ ...f.options, sign: f.sign }, 0n);
  assert.deepEqual(f.simulated, ["market_count", "0", "0", "1"]);
  assert.deepEqual(f.sent.map((tx) => tx.operations[0].type), ["restoreFootprint", "invokeHostFunction"]);
  assert.deepEqual(f.sent.map((tx) => tx.sequence), ["1", "2"]);
  assert.deepEqual(f.reports, ["restored", "finalized", "redemption-window-open"]);
  assert.equal((await f.options.journal.latestById()).get("finalize:0")?.stage, "confirmed");
});

test("restart reconciles a confirmed envelope and continues from its checkpoint", async (t) => {
  const f = await fixture(t);
  const opts = { ...f.options, sign: f.sign };
  await runSettlementKeeper(opts, 2n);
  const entry = (await opts.journal.latestById()).get("finalize:2");
  assert.ok(entry);
  await opts.journal.append(createJournalRecord({ ...entry, stage: "uncertain" }));
  await runSettlementKeeper(opts, 1n);
  assert.deepEqual(f.simulated, ["market_count", "2", "market_count", "1", "2"]);
  assert.equal(f.reports.filter((status) => status === "reconciled").length, 1);
  assert.equal(f.cursors.at(-1), 0n);
});

test("fee cap blocks signing and submission while the cursor advances", async (t) => {
  const f = await fixture(t);
  const sign = async (): Promise<string> => { assert.fail("signer must not run"); };
  await runSettlementKeeper({ ...f.options, maxFee: 1n, sign }, 2n);
  assert.deepEqual(f.reports, ["failed"]);
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.cursors, [0n]);
});
