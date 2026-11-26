import {
  BASE_FEE,
  Contract,
  Operation,
  SorobanDataBuilder,
  Transaction,
  TransactionBuilder,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { SorobanPendingError } from "./errors.js";
import { createJournalRecord, type TransactionJournal } from "./journal.js";
import { verifySignedTransaction } from "./signers/local.js";
import { submitSorobanTransaction, transactionFromJournal } from "./submit.js";

export interface KeeperOptions {
  server: Pick<rpc.Server, "getAccount" | "simulateTransaction" | "sendTransaction" | "getTransaction">;
  marketCore: string;
  source: string;
  networkPassphrase: string;
  limit: number;
  maxFee: bigint;
  journal: TransactionJournal;
  sign?: (unsignedXdr: string) => Promise<string>;
  report: (outcome: { marketId?: string; status: string; detail?: string }) => void;
  checkpoint: (cursor: bigint) => Promise<void>;
}

const skipped = new Map([
  [7, "missing"],
  [11, "awaiting-resolution"],
  [28, "redemption-window-open"],
  [29, "already-finalized"],
  [30, "legacy"],
]);

function archivedKeys(sim: rpc.Api.SimulateTransactionSuccessResponse): xdr.LedgerKey[] {
  const data = sim.transactionData.build();
  const extension = data.ext();
  if (extension.switch() !== 1) return [];
  const readWrite = data.resources().footprint().readWrite();
  return extension.resourceExt().archivedSorobanEntries().map((index) => {
    const key = readWrite[index];
    if (!key) throw new Error("RPC returned an archived index outside the footprint");
    return key;
  });
}

/** Walks a bounded page of the contiguous market ID range. The settlement
 * simulation is the eligibility check, using the network's ledger timestamp. */
export async function runSettlementKeeper(options: KeeperOptions, cursor: bigint): Promise<void> {
  const { server, marketCore, source, networkPassphrase, sign, journal, report } = options;
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
    throw new Error("market batch limit must be between 1 and 100");
  }
  if (cursor < 0n) throw new Error("market cursor cannot be negative");
  const core = new Contract(marketCore);
  const build = async (op: xdr.Operation, data?: xdr.SorobanTransactionData) => {
    const account = await server.getAccount(source);
    const builder = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase });
    if (data) builder.setSorobanData(data);
    return builder.addOperation(op).setTimeout(90).build();
  };
  const broadcast = (id: string, transaction: Transaction) =>
    submitSorobanTransaction({ id, transaction, server, journal, maxAttempts: 2, maxPollsPerAttempt: 5, retryDelayMs: 1_000 });

  if (sign) {
    for (const entry of (await journal.latestById()).values()) {
      if (entry.stage === "confirmed" || entry.stage === "failed") continue;
      const tx = transactionFromJournal(entry.envelopeXdr, networkPassphrase);
      if (tx.source !== source || tx.hash().toString("hex") !== entry.hash) {
        throw new Error("journal envelope does not match the source or network");
      }
      const result = await server.getTransaction(entry.hash);
      if (result.status === "NOT_FOUND" && Number(tx.timeBounds?.maxTime) > Date.now() / 1_000) {
        await broadcast(entry.id, tx);
      } else {
        const stage = result.status === "SUCCESS" ? "confirmed" : "failed";
        await journal.append(createJournalRecord({ ...entry, stage, detail: result.status }));
      }
      report({ status: "reconciled", detail: entry.id });
    }
  }

  const submit = async (id: string, tx: Transaction) => {
    if (!sign) throw new Error("external signer is required");
    if (BigInt(tx.fee) > options.maxFee) throw new Error("transaction fee exceeds the operator cap");
    const signed = await sign(tx.toXDR());
    await broadcast(id, verifySignedTransaction(signed, tx.hash().toString("hex"), source, networkPassphrase));
  };

  const restore = async (
    id: string,
    simulation: rpc.Api.SimulateTransactionSuccessResponse,
    keys: xdr.LedgerKey[],
  ) => {
    const op = Operation.restoreFootprint({});
    if (rpc.Api.isSimulationRestore(simulation)) {
      await submit(id, await build(op, simulation.restorePreamble.transactionData.build()));
      return;
    }
    const raw = await build(op, new SorobanDataBuilder().setFootprint([], keys).build());
    const result = await server.simulateTransaction(raw);
    if (!rpc.Api.isSimulationSuccess(result) || rpc.Api.isSimulationRestore(result)) {
      throw new Error("standalone restore simulation failed");
    }
    await submit(id, rpc.assembleTransaction(raw, result).build());
  };

  const countTx = await build(core.call("market_count"));
  let count = await server.simulateTransaction(countTx);
  if (rpc.Api.isSimulationSuccess(count)) {
    const keys = archivedKeys(count);
    if (rpc.Api.isSimulationRestore(count) || keys.length > 0) {
      if (!sign) {
        report({ status: "inventory-restore-required" });
        return;
      }
      await restore("restore:inventory", count, keys);
      report({ status: "inventory-restored" });
      count = await server.simulateTransaction(await build(core.call("market_count")));
    }
  }
  if (!rpc.Api.isSimulationSuccess(count) || rpc.Api.isSimulationRestore(count)
      || archivedKeys(count).length > 0 || !count.result) {
    throw new Error("market_count simulation failed after discovery");
  }
  const marketCount = count.result.retval.u64().toBigInt();
  const start = cursor < marketCount ? cursor : 0n;
  const end = start + BigInt(options.limit);
  for (let id = start; id < marketCount && id < end; id += 1n) {
    const marketId = id.toString();
    const inspect = async () => {
      const tx = await build(core.call("finalize_market", xdr.ScVal.scvU64(xdr.Uint64.fromString(marketId))));
      return { tx, simulation: await server.simulateTransaction(tx) };
    };
    try {
      let { tx, simulation } = await inspect();
      if (rpc.Api.isSimulationSuccess(simulation)) {
        const keys = archivedKeys(simulation);
        if (rpc.Api.isSimulationRestore(simulation) || keys.length > 0) {
          if (sign) {
            await restore(`restore:${marketId}`, simulation, keys);
            report({ marketId, status: "restored" });
            ({ tx, simulation } = await inspect());
          }
        }
      }
      if (rpc.Api.isSimulationError(simulation)) {
        const code = /Error\(Contract,\s*#(\d+)\)/.exec(simulation.error);
        const status = code && skipped.get(Number(code[1]));
        report({ marketId, status: status || "simulation-failed", detail: simulation.error });
      } else if (rpc.Api.isSimulationRestore(simulation) || archivedKeys(simulation).length > 0) {
        report({ marketId, status: "restore-required" });
      } else if (simulation.result) {
        if (sign) await submit(`finalize:${marketId}`, rpc.assembleTransaction(tx, simulation).build());
        report({ marketId, status: sign ? "finalized" : "eligible" });
      } else {
        report({ marketId, status: "simulation-failed", detail: "missing simulation result" });
      }
    } catch (error) {
      report({ marketId, status: "failed", detail: String(error) });
      if (error instanceof SorobanPendingError) throw error;
      // A journal or transport error can occur after broadcast. Reconcile
      // any unfinished envelope before assigning another source sequence.
      if (sign) {
        const entries = [...(await journal.latestById()).values()];
        if (entries.some((entry) => entry.stage !== "confirmed" && entry.stage !== "failed")) {
          throw error;
        }
      }
    }
    await options.checkpoint(id + 1n === marketCount ? 0n : id + 1n);
  }
}
