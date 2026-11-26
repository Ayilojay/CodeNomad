import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Keypair, StrKey, rpc } from "@stellar/stellar-sdk";
import { TransactionJournal } from "../stellar/journal.js";
import { runSettlementKeeper } from "../stellar/settlement-keeper.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function externalSigner(path: string, unsignedXdr: string): Promise<string> {
  return new Promise((fulfill, reject) => {
    const child = spawn(path, [], { stdio: ["pipe", "pipe", "inherit"], timeout: 60_000, killSignal: "SIGKILL" });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (data: string) => {
      output += data;
      if (output.length > 128_000) child.kill("SIGKILL");
    });
    child.once("error", reject);
    child.stdin.on("error", reject);
    child.once("close", (code) => {
      if (code === 0 && output.trim()) fulfill(output.trim());
      else reject(new Error("external signer failed"));
    });
    child.stdin.end(`${unsignedXdr}\n`);
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--submit")) {
    throw new Error("usage: npm run settlement-keeper -- [--submit]");
  }
  const live = args[0] === "--submit";
  const source = required("KEEPER_SOURCE");
  Keypair.fromPublicKey(source);
  const marketCore = required("KEEPER_MARKET_CORE");
  if (!StrKey.isValidContract(marketCore)) throw new Error("invalid KEEPER_MARKET_CORE");
  const rpcUrl = new URL(required("KEEPER_RPC_URL"));
  const allowHttp = ["localhost", "127.0.0.1", "[::1]"].includes(rpcUrl.hostname);
  const dir = resolve(required("KEEPER_STATE_DIR"), live ? "live" : "dry-run");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const cursorPath = resolve(dir, "cursor");
  const outcomePath = resolve(dir, "outcomes.jsonl");
  const cursor = await readFile(cursorPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return "0";
  });
  const signer = live ? required("KEEPER_SIGNER") : undefined;
  const maxFee = BigInt(live ? required("KEEPER_MAX_FEE") : "0");
  if (live && maxFee <= 0n) throw new Error("KEEPER_MAX_FEE must be positive");
  let log = Promise.resolve();
  try {
    await runSettlementKeeper({
      server: new rpc.Server(rpcUrl.toString(), { allowHttp, timeout: 15_000 }),
      source,
      marketCore,
      networkPassphrase: required("KEEPER_NETWORK_PASSPHRASE"),
      limit: Number(process.env.KEEPER_LIMIT ?? "20"),
      maxFee,
      journal: new TransactionJournal(resolve(dir, "transactions.jsonl")),
      sign: signer ? (xdr) => externalSigner(signer, xdr) : undefined,
      report: (outcome) => {
        const line = JSON.stringify({ at: new Date().toISOString(), ...outcome });
        console.log(line);
        log = log.then(() => appendFile(outcomePath, `${line}\n`, { mode: 0o600 }));
      },
      checkpoint: async (next) => {
        await log;
        await writeFile(`${cursorPath}.tmp`, next.toString(), { mode: 0o600 });
        await rename(`${cursorPath}.tmp`, cursorPath);
      },
    }, BigInt(cursor));
  } finally {
    await log;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
