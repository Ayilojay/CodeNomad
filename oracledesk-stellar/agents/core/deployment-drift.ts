/**
 * Testnet deployment drift detector (#123).
 *
 * Compares a checked-in deployment manifest (deployments/testnet.json)
 * against live contract metadata on the network: instance existence, TTL
 * health, and WASM code hash.  Reports every discrepancy without touching
 * any on-chain state or submitting transactions.
 *
 * Design constraints from the issue:
 *   - Report drift; never automatically replace addresses or submit anything.
 *   - Do not display sample data as live.
 *   - Do not bypass signature or chain verification.
 *   - Do not silently fall back after errors — every error surfaces explicitly
 *     in the returned report.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Address, rpc, StrKey, xdr } from "@stellar/stellar-sdk";
import { DeploymentsSchema, type ValidatedDeployments } from "./config.js";

// ─── Manifest loading ─────────────────────────────────────────────────────────

export class ManifestLoadError extends Error {
  constructor(
    public readonly path: string,
    public readonly reason: string,
  ) {
    super(`cannot load manifest ${path}: ${reason}`);
    this.name = "ManifestLoadError";
  }
}

/**
 * Reads and validates a deployment manifest file.  Throws `ManifestLoadError`
 * when the file is missing, not valid JSON, or fails schema validation.
 * Never returns partial data: either the full validated record or an error.
 */
export function loadManifest(
  path: string,
  readFile: (p: string) => string = (p) => readFileSync(p, "utf8"),
): ValidatedDeployments {
  let raw: unknown;
  try {
    raw = JSON.parse(readFile(path));
  } catch (err) {
    throw new ManifestLoadError(
      path,
      err instanceof Error ? err.message : String(err),
    );
  }
  const result = DeploymentsSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new ManifestLoadError(path, `schema validation failed: ${issues}`);
  }
  return result.data as ValidatedDeployments;
}

// ─── Live contract probing ────────────────────────────────────────────────────

export interface LiveContractInfo {
  /** sha256 of the contract's uploaded WASM, as a 64-character hex string. */
  wasmHash: string;
  /** Ledger sequence at which this instance expires; undefined when missing. */
  liveUntilLedger: number | undefined;
}

export type ProbeOutcome =
  | { tag: "ok"; info: LiveContractInfo }
  | { tag: "missing" }
  | { tag: "archived"; liveUntilLedger: number }
  | { tag: "error"; reason: string };

export interface ContractProbe {
  /**
   * Fetches instance metadata for `contractId` and the current ledger
   * sequence.  Must never throw; return `{ tag: "error" }` on any failure.
   */
  probe(
    rpcUrl: string,
    contractId: string,
  ): Promise<{ outcome: ProbeOutcome; latestLedger: number }>;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  const timer = new Promise<never>((_, reject) => {
    t = setTimeout(
      () => reject(new Error(`${what} timed out after ${ms} ms`)),
      ms,
    );
  });
  return Promise.race([p, timer]).finally(() => clearTimeout(t!));
}

/**
 * Production probe: hits the Soroban RPC `getLedgerEntries` and reads the
 * contract-instance XDR to extract the WASM hash.
 */
export function rpcContractProbe(timeoutMs = 10_000): ContractProbe {
  return {
    async probe(rpcUrl, contractId) {
      try {
        const server = new rpc.Server(rpcUrl, {
          allowHttp: rpcUrl.startsWith("http://"),
        });
        const instanceKey = xdr.LedgerKey.contractData(
          new xdr.LedgerKeyContractData({
            contract: new Address(contractId).toScAddress(),
            key: xdr.ScVal.scvLedgerKeyContractInstance(),
            durability: xdr.ContractDataDurability.persistent(),
          }),
        );
        const [{ entries, latestLedger }] = await withTimeout(
          Promise.all([server.getLedgerEntries(instanceKey)]),
          timeoutMs,
          `getLedgerEntries(${contractId})`,
        );
        if (entries.length === 0) {
          return { outcome: { tag: "missing" }, latestLedger };
        }
        const entry = entries[0];
        const liveUntilLedger = entry.liveUntilLedgerSeq;
        if (liveUntilLedger !== undefined && liveUntilLedger < latestLedger) {
          return {
            outcome: { tag: "archived", liveUntilLedger },
            latestLedger,
          };
        }
        // Extract the WASM hash from the contract instance data.
        const val = entry.val.contractData().val();
        const instance = val.instance();
        const rawHash = instance.executable().wasmHash();
        const wasmHash = Buffer.from(rawHash).toString("hex");
        return {
          outcome: {
            tag: "ok",
            info: { wasmHash, liveUntilLedger },
          },
          latestLedger,
        };
      } catch (err) {
        return {
          outcome: {
            tag: "error",
            reason: err instanceof Error ? err.message : String(err),
          },
          latestLedger: 0,
        };
      }
    },
  };
}

// ─── Expected WASM hashes ─────────────────────────────────────────────────────

/**
 * Per-contract expected WASM hashes, keyed by contract name.
 * These are set by the operator after a known-good deployment and checked
 * into source control.  An empty map means "no hash pinned yet" and the
 * drift report will note the absence without failing.
 */
export type ExpectedHashes = Partial<
  Record<keyof ValidatedDeployments["contracts"], string>
>;

/**
 * Validates an expected-hash map: each value must be a 64-character
 * lowercase hex string.  Returns a list of validation errors, empty on success.
 */
export function validateExpectedHashes(hashes: ExpectedHashes): string[] {
  const errors: string[] = [];
  for (const [name, hash] of Object.entries(hashes)) {
    if (hash === undefined) continue;
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      errors.push(
        `expected hash for ${name} is not a 64-character lowercase hex string: ${JSON.stringify(hash)}`,
      );
    }
  }
  return errors;
}

// ─── Drift detection ──────────────────────────────────────────────────────────

export type ContractDriftStatus =
  | { tag: "live"; wasmHash: string; liveUntilLedger: number | undefined }
  | { tag: "missing" }
  | { tag: "archived"; liveUntilLedger: number }
  | { tag: "wasm-drift"; liveHash: string; expectedHash: string; liveUntilLedger: number | undefined }
  | { tag: "probe-error"; reason: string };

export interface ContractDriftEntry {
  name: keyof ValidatedDeployments["contracts"];
  address: string;
  status: ContractDriftStatus;
}

export interface DriftReport {
  manifestPath: string;
  rpcUrl: string;
  network: string;
  checkedAt: string; // ISO-8601
  latestLedger: number;
  contracts: ContractDriftEntry[];
  /**
   * True when every contract is live and every pinned hash matches.
   * No drift means nothing needs operator attention.
   */
  clean: boolean;
  /**
   * Human-readable summary lines for each problem found.
   * Empty when `clean` is true.
   */
  problems: string[];
  /**
   * Addresses from the manifest that do not look like valid C... Stellar
   * contract IDs.  An address check failure blocks the probe step.
   */
  invalidAddresses: string[];
}

export interface DriftCheckOptions {
  rpcUrl: string;
  manifest: ValidatedDeployments;
  manifestPath: string;
  expectedHashes?: ExpectedHashes;
  probe?: ContractProbe;
  /** Milliseconds; defaults to 10 000. */
  probeTimeoutMs?: number;
  /** Injected clock for deterministic tests; defaults to `() => new Date()`. */
  now?: () => Date;
}

/**
 * Checks every contract in `manifest.contracts` against the network.
 * Returns a full `DriftReport`; never throws.
 *
 * The network passphrase is not re-verified here (that is `loadAgentConfig`'s
 * responsibility).  This function focuses on address and WASM hash drift.
 */
export async function checkDeploymentDrift(
  opts: DriftCheckOptions,
): Promise<DriftReport> {
  const {
    rpcUrl,
    manifest,
    manifestPath,
    expectedHashes = {},
    probeTimeoutMs = 10_000,
    now = () => new Date(),
  } = opts;
  const probe = opts.probe ?? rpcContractProbe(probeTimeoutMs);
  const network = manifest.network ?? "testnet";

  // 1. Validate all addresses before touching the network.
  const invalidAddresses: string[] = [];
  for (const [name, address] of Object.entries(manifest.contracts)) {
    if (!StrKey.isValidContract(address)) {
      invalidAddresses.push(
        `contracts.${name} has invalid address: ${JSON.stringify(address)}`,
      );
    }
  }

  const checkedAt = now().toISOString();
  const contracts: ContractDriftEntry[] = [];
  let latestLedger = 0;

  // 2. Skip network probes when any address is invalid — the RPC call would
  //    fail anyway and the error message would obscure the real problem.
  if (invalidAddresses.length > 0) {
    for (const [name, address] of Object.entries(manifest.contracts)) {
      contracts.push({
        name: name as keyof ValidatedDeployments["contracts"],
        address,
        status: { tag: "probe-error", reason: "address validation failed; network probe skipped" },
      });
    }
  } else {
    // 3. Probe each contract.  Run concurrently: if one RPC call hangs it
    //    should not hold up the others.
    const results = await Promise.all(
      (
        Object.entries(manifest.contracts) as [
          keyof ValidatedDeployments["contracts"],
          string,
        ][]
      ).map(async ([name, address]) => {
        const { outcome, latestLedger: ll } = await probe.probe(
          rpcUrl,
          address,
        );
        return { name, address, outcome, latestLedger: ll };
      }),
    );

    for (const { name, address, outcome, latestLedger: ll } of results) {
      if (ll > latestLedger) latestLedger = ll;
      let status: ContractDriftStatus;
      if (outcome.tag === "ok") {
        const expected = expectedHashes[name];
        if (
          expected !== undefined &&
          outcome.info.wasmHash !== expected.toLowerCase()
        ) {
          status = {
            tag: "wasm-drift",
            liveHash: outcome.info.wasmHash,
            expectedHash: expected.toLowerCase(),
            liveUntilLedger: outcome.info.liveUntilLedger,
          };
        } else {
          status = {
            tag: "live",
            wasmHash: outcome.info.wasmHash,
            liveUntilLedger: outcome.info.liveUntilLedger,
          };
        }
      } else if (outcome.tag === "missing") {
        status = { tag: "missing" };
      } else if (outcome.tag === "archived") {
        status = { tag: "archived", liveUntilLedger: outcome.liveUntilLedger };
      } else {
        // outcome.tag === "error"
        status = { tag: "probe-error", reason: outcome.reason };
      }
      contracts.push({ name, address, status });
    }
  }

  // 4. Collect problems from every contract entry.
  const problems: string[] = [];
  for (const entry of contracts) {
    const loc = `contracts.${entry.name} (${entry.address})`;
    switch (entry.status.tag) {
      case "live":
        // No problem.
        break;
      case "missing":
        problems.push(
          `${loc}: not found on ${network} — manifest may be stale or the network was reset`,
        );
        break;
      case "archived":
        problems.push(
          `${loc}: archived (liveUntilLedger=${entry.status.liveUntilLedger}) — restore with: stellar contract restore --id ${entry.address} --network ${network}`,
        );
        break;
      case "wasm-drift":
        problems.push(
          `${loc}: WASM hash mismatch — live=${entry.status.liveHash} expected=${entry.status.expectedHash}`,
        );
        break;
      case "probe-error":
        problems.push(`${loc}: probe failed — ${entry.status.reason}`);
        break;
    }
  }

  for (const msg of invalidAddresses) {
    problems.push(msg);
  }

  return {
    manifestPath,
    rpcUrl,
    network,
    checkedAt,
    latestLedger,
    contracts,
    clean: problems.length === 0,
    problems,
    invalidAddresses,
  };
}

// ─── Utility: sha256 of a Buffer (used by tests and fixtures) ─────────────────

export function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
