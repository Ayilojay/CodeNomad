/**
 * Tests for deployment drift detection (#123).
 *
 * All tests are deterministic: no network calls, no filesystem access beyond
 * what is injected.  The `ContractProbe` interface is implemented inline as
 * a simple function so each test controls exactly what the "network" returns.
 *
 * Coverage targets:
 *   - manifest validation (missing fields, bad addresses, schema errors)
 *   - clean deployment (every contract live, hashes match)
 *   - stale address (contract missing on the network)
 *   - archived contract (instance TTL lapsed)
 *   - WASM hash drift (live hash differs from pinned expected hash)
 *   - probe transport error (RPC unreachable)
 *   - mixed results across contracts
 *   - invalid address in manifest (blocks network probes)
 *   - expected-hash validation
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { StrKey } from "@stellar/stellar-sdk";
import {
  checkDeploymentDrift,
  loadManifest,
  ManifestLoadError,
  validateExpectedHashes,
  type ContractDriftEntry,
  type ContractProbe,
  type DriftCheckOptions,
  type LiveContractInfo,
  type ProbeOutcome,
} from "./deployment-drift.js";
import type { ValidatedDeployments } from "./config.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function contractId(n: number): string {
  return StrKey.encodeContract(Buffer.alloc(32, n));
}

function wasmHash(n: number): string {
  return createHash("sha256").update(Buffer.alloc(32, n)).digest("hex");
}

/** A minimal valid manifest with five contracts. */
function manifest(
  overrides: Partial<ValidatedDeployments> = {},
): ValidatedDeployments {
  return {
    deployer: StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 9)),
    agent: StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 1)),
    contracts: {
      usdc: contractId(10),
      market_core: contractId(11),
      resolver: contractId(12),
      treasury: contractId(13),
      reasoning_registry: contractId(14),
    },
    network: "testnet",
    wired: true,
    agent_registered: true,
    ...overrides,
  } as ValidatedDeployments;
}

type ContractName = keyof ValidatedDeployments["contracts"];
const CONTRACT_NAMES: ContractName[] = [
  "usdc",
  "market_core",
  "resolver",
  "treasury",
  "reasoning_registry",
];

/** Builds a `ContractProbe` that returns a fixed outcome for every contract. */
function uniformProbe(outcome: ProbeOutcome, latestLedger = 1000): ContractProbe {
  return {
    async probe(_rpcUrl, _contractId) {
      return { outcome, latestLedger };
    },
  };
}

/** Builds a `ContractProbe` keyed by contract address. */
function mappedProbe(
  map: Map<string, ProbeOutcome>,
  latestLedger = 1000,
): ContractProbe {
  return {
    async probe(_rpcUrl, contractId) {
      const outcome = map.get(contractId);
      if (!outcome) {
        return {
          outcome: { tag: "error", reason: `unexpected contractId ${contractId}` },
          latestLedger,
        };
      }
      return { outcome, latestLedger };
    },
  };
}

function baseOpts(
  m: ValidatedDeployments = manifest(),
  probe: ContractProbe = uniformProbe({ tag: "missing" }),
): DriftCheckOptions {
  return {
    rpcUrl: "https://soroban-testnet.stellar.org",
    manifest: m,
    manifestPath: "deployments/testnet.json",
    probe,
    now: () => new Date("2024-01-15T12:00:00Z"),
  };
}

function findEntry(entries: ContractDriftEntry[], name: ContractName) {
  const e = entries.find((c) => c.name === name);
  assert.ok(e, `entry for ${name} not found`);
  return e;
}

// ─── loadManifest ─────────────────────────────────────────────────────────────

test("loadManifest accepts a valid testnet.json", () => {
  const m = manifest();
  const data = JSON.stringify(m);
  const result = loadManifest("deployments/testnet.json", () => data);
  assert.equal(result.network, "testnet");
  assert.equal(result.contracts.usdc, contractId(10));
});

test("loadManifest throws ManifestLoadError when file is not found", () => {
  assert.throws(
    () =>
      loadManifest("deployments/testnet.json", () => {
        throw new Error("ENOENT: no such file");
      }),
    (err) => {
      assert.ok(err instanceof ManifestLoadError);
      assert.match(err.message, /ENOENT/);
      return true;
    },
  );
});

test("loadManifest throws ManifestLoadError when JSON is malformed", () => {
  assert.throws(
    () => loadManifest("deployments/testnet.json", () => "{ not json }"),
    ManifestLoadError,
  );
});

test("loadManifest throws ManifestLoadError when deployer is missing", () => {
  const bad = { contracts: manifest().contracts };
  assert.throws(
    () => loadManifest("deployments/testnet.json", () => JSON.stringify(bad)),
    ManifestLoadError,
  );
});

test("loadManifest throws ManifestLoadError when a contract address is invalid", () => {
  const bad = {
    ...manifest(),
    contracts: { ...manifest().contracts, usdc: "not-a-contract-id" },
  };
  assert.throws(
    () => loadManifest("deployments/testnet.json", () => JSON.stringify(bad)),
    ManifestLoadError,
  );
});

test("loadManifest does not silently ignore unknown fields (looseObject passthrough)", () => {
  const extra = { ...manifest(), extra_unknown_field: "value" };
  // DeploymentsSchema uses looseObject so extra fields pass — this is intentional.
  const result = loadManifest("deployments/testnet.json", () =>
    JSON.stringify(extra),
  );
  assert.ok(result);
});

// ─── validateExpectedHashes ───────────────────────────────────────────────────

test("validateExpectedHashes accepts a valid hex map", () => {
  const errors = validateExpectedHashes({
    usdc: wasmHash(10),
    market_core: wasmHash(11),
  });
  assert.deepEqual(errors, []);
});

test("validateExpectedHashes rejects short or non-hex values", () => {
  const errors = validateExpectedHashes({
    usdc: "tooshort",
    market_core: "GG".repeat(32), // non-hex
  });
  assert.equal(errors.length, 2);
  assert.match(errors[0], /usdc/);
  assert.match(errors[1], /market_core/);
});

test("validateExpectedHashes allows partial maps (only pin what you know)", () => {
  const errors = validateExpectedHashes({ usdc: wasmHash(10) });
  assert.deepEqual(errors, []);
});

test("validateExpectedHashes allows an empty map", () => {
  assert.deepEqual(validateExpectedHashes({}), []);
});

// ─── checkDeploymentDrift: clean state ───────────────────────────────────────

test("clean deployment: all contracts live, no pinned hashes → clean report", async () => {
  const hash = wasmHash(42);
  const probe = uniformProbe({
    tag: "ok",
    info: { wasmHash: hash, liveUntilLedger: 2000 },
  });
  const report = await checkDeploymentDrift({ ...baseOpts(manifest(), probe) });
  assert.equal(report.clean, true);
  assert.deepEqual(report.problems, []);
  assert.deepEqual(report.invalidAddresses, []);
  assert.equal(report.contracts.length, 5);
  for (const entry of report.contracts) {
    assert.equal(entry.status.tag, "live");
  }
});

test("clean deployment: all contracts live, all hashes match → clean report", async () => {
  const m = manifest();
  const hashes: Record<ContractName, string> = {
    usdc: wasmHash(10),
    market_core: wasmHash(11),
    resolver: wasmHash(12),
    treasury: wasmHash(13),
    reasoning_registry: wasmHash(14),
  };
  const probe = mappedProbe(
    new Map(
      CONTRACT_NAMES.map((name) => [
        m.contracts[name],
        {
          tag: "ok" as const,
          info: { wasmHash: hashes[name], liveUntilLedger: 2000 } satisfies LiveContractInfo,
        },
      ]),
    ),
  );
  const report = await checkDeploymentDrift({
    ...baseOpts(m, probe),
    expectedHashes: hashes,
  });
  assert.equal(report.clean, true);
  assert.deepEqual(report.problems, []);
});

// ─── checkDeploymentDrift: missing contract ───────────────────────────────────

test("missing contract produces a problem and sets status to missing", async () => {
  const m = manifest();
  const probeMap = new Map<string, ProbeOutcome>(
    CONTRACT_NAMES.map((name) => [
      m.contracts[name],
      name === "market_core"
        ? { tag: "missing" as const }
        : { tag: "ok" as const, info: { wasmHash: wasmHash(0), liveUntilLedger: 2000 } },
    ]),
  );
  const report = await checkDeploymentDrift({
    ...baseOpts(m, mappedProbe(probeMap)),
  });
  assert.equal(report.clean, false);
  assert.equal(report.problems.length, 1);
  assert.match(report.problems[0], /market_core/);
  assert.match(report.problems[0], /not found/);
  const entry = findEntry(report.contracts, "market_core");
  assert.equal(entry.status.tag, "missing");
});

// ─── checkDeploymentDrift: archived contract ──────────────────────────────────

test("archived contract produces a problem with restore command", async () => {
  const m = manifest();
  const treasuryAddr = m.contracts.treasury;
  const probeMap = new Map<string, ProbeOutcome>(
    CONTRACT_NAMES.map((name) => [
      m.contracts[name],
      name === "treasury"
        ? { tag: "archived" as const, liveUntilLedger: 500 }
        : { tag: "ok" as const, info: { wasmHash: wasmHash(0), liveUntilLedger: 2000 } },
    ]),
  );
  const report = await checkDeploymentDrift({
    ...baseOpts(m, mappedProbe(probeMap)),
  });
  assert.equal(report.clean, false);
  assert.equal(report.problems.length, 1);
  assert.match(report.problems[0], /treasury/);
  assert.match(report.problems[0], /archived/);
  assert.match(report.problems[0], /stellar contract restore/);
  assert.match(report.problems[0], new RegExp(treasuryAddr));
  const entry = findEntry(report.contracts, "treasury");
  assert.equal(entry.status.tag, "archived");
});

// ─── checkDeploymentDrift: WASM hash drift ────────────────────────────────────

test("WASM drift produces a problem with both hashes", async () => {
  const m = manifest();
  const liveHash = wasmHash(99);
  const pinnedHash = wasmHash(42);
  const probe = uniformProbe({
    tag: "ok",
    info: { wasmHash: liveHash, liveUntilLedger: 2000 },
  });
  const report = await checkDeploymentDrift({
    ...baseOpts(m, probe),
    expectedHashes: { usdc: pinnedHash },
  });
  assert.equal(report.clean, false);
  const driftProblems = report.problems.filter((p) => p.includes("usdc"));
  assert.equal(driftProblems.length, 1);
  assert.match(driftProblems[0], /WASM hash mismatch/);
  assert.match(driftProblems[0], new RegExp(liveHash));
  assert.match(driftProblems[0], new RegExp(pinnedHash));
  const entry = findEntry(report.contracts, "usdc");
  assert.equal(entry.status.tag, "wasm-drift");
});

test("WASM hash comparison is case-insensitive (uppercase expected hash)", async () => {
  const m = manifest();
  const hash = wasmHash(42);
  const probe = uniformProbe({
    tag: "ok",
    info: { wasmHash: hash, liveUntilLedger: 2000 },
  });
  const report = await checkDeploymentDrift({
    ...baseOpts(m, probe),
    // Supply the expected hash in uppercase — should still match.
    expectedHashes: { market_core: hash.toUpperCase() },
  });
  // Only market_core has a pinned hash and it should match (after normalization).
  const entry = findEntry(report.contracts, "market_core");
  assert.equal(entry.status.tag, "live");
});

// ─── checkDeploymentDrift: probe transport error ──────────────────────────────

test("probe error surfaces as a problem without throwing", async () => {
  const probe = uniformProbe({
    tag: "error",
    reason: "ECONNREFUSED 127.0.0.1:8000",
  });
  const report = await checkDeploymentDrift({ ...baseOpts(manifest(), probe) });
  assert.equal(report.clean, false);
  assert.equal(report.problems.length, 5);
  for (const problem of report.problems) {
    assert.match(problem, /probe failed/);
    assert.match(problem, /ECONNREFUSED/);
  }
  for (const entry of report.contracts) {
    assert.equal(entry.status.tag, "probe-error");
  }
});

test("individual contract probe error does not block other contracts", async () => {
  const m = manifest();
  const probeMap = new Map<string, ProbeOutcome>(
    CONTRACT_NAMES.map((name) => [
      m.contracts[name],
      name === "resolver"
        ? { tag: "error" as const, reason: "RPC timeout" }
        : { tag: "ok" as const, info: { wasmHash: wasmHash(0), liveUntilLedger: 2000 } },
    ]),
  );
  const report = await checkDeploymentDrift({
    ...baseOpts(m, mappedProbe(probeMap)),
  });
  assert.equal(report.clean, false);
  assert.equal(report.problems.length, 1);
  assert.match(report.problems[0], /resolver/);
  assert.match(report.problems[0], /RPC timeout/);
  // The other four should be live.
  const liveContracts = report.contracts.filter((c) => c.status.tag === "live");
  assert.equal(liveContracts.length, 4);
});

// ─── checkDeploymentDrift: invalid address in manifest ────────────────────────

test("invalid contract address in manifest blocks probes and reports the problem", async () => {
  const bad = manifest({
    contracts: {
      ...manifest().contracts,
      treasury: "NOT_A_VALID_CONTRACT_ID",
    },
  } as unknown as Partial<ValidatedDeployments>);
  // loadManifest would have caught this via DeploymentsSchema; here we bypass
  // it to test that checkDeploymentDrift also protects the probe step.
  const probe = uniformProbe({ tag: "ok", info: { wasmHash: wasmHash(0), liveUntilLedger: 2000 } });
  const report = await checkDeploymentDrift({ ...baseOpts(bad, probe) });
  assert.equal(report.clean, false);
  assert.ok(report.invalidAddresses.length > 0);
  assert.match(report.invalidAddresses[0], /treasury/);
  // No contract should report "live" when addresses are invalid.
  const liveContracts = report.contracts.filter((c) => c.status.tag === "live");
  assert.equal(liveContracts.length, 0);
});

// ─── checkDeploymentDrift: report metadata ────────────────────────────────────

test("report includes manifest path, rpcUrl, network, and checkedAt", async () => {
  const probe = uniformProbe({ tag: "missing" });
  const report = await checkDeploymentDrift({
    ...baseOpts(manifest(), probe),
    manifestPath: "deployments/testnet.json",
    rpcUrl: "https://soroban-testnet.stellar.org",
    now: () => new Date("2024-01-15T12:00:00Z"),
  });
  assert.equal(report.manifestPath, "deployments/testnet.json");
  assert.equal(report.rpcUrl, "https://soroban-testnet.stellar.org");
  assert.equal(report.network, "testnet");
  assert.equal(report.checkedAt, "2024-01-15T12:00:00.000Z");
});

test("report reflects latestLedger returned by the probe", async () => {
  const probe = uniformProbe(
    { tag: "ok", info: { wasmHash: wasmHash(0), liveUntilLedger: 3000 } },
    1234,
  );
  const report = await checkDeploymentDrift({ ...baseOpts(manifest(), probe) });
  assert.equal(report.latestLedger, 1234);
});

// ─── checkDeploymentDrift: no silent fallback ─────────────────────────────────

test("every contract appears in report.contracts regardless of outcome", async () => {
  const probeMap = new Map<string, ProbeOutcome>([
    [contractId(10), { tag: "missing" }],
    [contractId(11), { tag: "ok", info: { wasmHash: wasmHash(0), liveUntilLedger: 2000 } }],
    [contractId(12), { tag: "archived", liveUntilLedger: 100 }],
    [contractId(13), { tag: "error", reason: "timeout" }],
    [contractId(14), { tag: "ok", info: { wasmHash: wasmHash(0), liveUntilLedger: 2000 } }],
  ]);
  const report = await checkDeploymentDrift({
    ...baseOpts(manifest(), mappedProbe(probeMap)),
  });
  assert.equal(report.contracts.length, 5);
  const tags = new Set(report.contracts.map((c) => c.status.tag));
  assert.ok(tags.has("missing"));
  assert.ok(tags.has("live"));
  assert.ok(tags.has("archived"));
  assert.ok(tags.has("probe-error"));
});

// ─── Edge: manifest with no network field defaults to "testnet" ───────────────

test("manifest without a network field is treated as testnet", async () => {
  const m = { ...manifest() };
  delete (m as Partial<ValidatedDeployments>).network;
  const probe = uniformProbe({ tag: "missing" });
  const report = await checkDeploymentDrift({ ...baseOpts(m as ValidatedDeployments, probe) });
  assert.equal(report.network, "testnet");
});
