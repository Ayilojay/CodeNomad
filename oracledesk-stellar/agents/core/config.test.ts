import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import {
  AgentConfigError,
  describeConfig,
  loadAgentConfig,
  MAINNET_OPT_IN,
  NETWORKS,
  parseTunables,
  type ContractsReport,
  type LoadAgentConfigOptions,
  type NetworkProbe,
} from "./config.js";

// Real StrKeys, derived from fixed seeds so every run is identical.
const keypair = (n: number) => Keypair.fromRawEd25519Seed(Buffer.alloc(32, n));
const contract = (n: number) => StrKey.encodeContract(Buffer.alloc(32, n));
const AGENT = keypair(1);
const MAKER = keypair(2);
const OTHER = keypair(3);

const CONTRACTS = {
  usdc: contract(10),
  market_core: contract(11),
  resolver: contract(12),
  treasury: contract(13),
  reasoning_registry: contract(14),
};

function deployment(overrides: Record<string, unknown> = {}) {
  return { deployer: keypair(9).publicKey(), agent: AGENT.publicKey(), contracts: { ...CONTRACTS }, ...overrides };
}

class FakeProbe implements NetworkProbe {
  calls = 0;
  constructor(
    private readonly served: string = NETWORKS.testnet.passphrase,
    private readonly report: ContractsReport = { missing: [], archived: [] },
  ) {}
  async passphrase(): Promise<string> {
    this.calls++;
    return this.served;
  }
  async contractsExist(): Promise<ContractsReport> {
    this.calls++;
    return this.report;
  }
}

interface Setup extends Partial<LoadAgentConfigOptions> {
  record?: unknown;
}

function load(env: NodeJS.ProcessEnv, s: Setup = {}) {
  const files: Record<string, string> = {};
  const logs: string[] = [];
  return {
    logs,
    files,
    run: () =>
      loadAgentConfig({
        role: "trader",
        argv: [],
        probe: new FakeProbe(),
        readFile: (path) => {
          files[path] = "read";
          return JSON.stringify(s.record ?? deployment());
        },
        log: (m) => logs.push(m),
        ...s,
        env,
      }),
  };
}

async function issuesOf(promise: Promise<unknown>): Promise<string[]> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof AgentConfigError, `expected AgentConfigError, got ${String(err)}`);
    return err.issues;
  }
  assert.fail("expected the config to be rejected");
}

const LIVE = { AGENT_MODE: "live", AGENT_SECRET_KEY: AGENT.secret() };

test("an unset AGENT_MODE defaults to dry-run with documented defaults", async () => {
  const cfg = await load({}).run();
  assert.equal(cfg.mode, "dry-run");
  assert.equal(cfg.network, "testnet");
  assert.equal(cfg.networkPassphrase, NETWORKS.testnet.passphrase);
  assert.equal(cfg.rpcUrl, NETWORKS.testnet.rpcUrl);
  assert.equal(cfg.trading.minEdgeBps, 500);
  assert.equal(cfg.trading.tradeSizeStroops, 100_000_000n);
  assert.deepEqual(cfg.trading.kellyFraction, { numerator: 1n, denominator: 4n });
  assert.equal(cfg.trading.sizingBufferBps, 25);
  assert.equal(cfg.trading.minTradeStroops, 1_000_000n);
  assert.equal(cfg.trading.fairUncertaintyBps, 500);
  assert.equal(cfg.maker.defaultSeedStroops, 1_500_000_000n);
  assert.equal(cfg.agentSecret, undefined);
  assert.match(cfg.deploymentsFile, /deployments[\\/]testnet\.json$/);
});

test("unknown and empty agent modes are rejected", async () => {
  for (const AGENT_MODE of ["yolo", "Live", "", " dry-run"]) {
    const issues = await issuesOf(load({ AGENT_MODE }).run());
    assert.ok(issues.some((i) => i.startsWith("AGENT_MODE:")), `${JSON.stringify(AGENT_MODE)}: ${issues}`);
  }
});

test("invalid, non-integer and out-of-range numbers fail, all reported together", async () => {
  const issues = await issuesOf(
    load({
      MIN_EDGE_BPS: "",
      CONFIDENCE_THRESHOLD_BPS: "10001",
      SLIPPAGE_BPS: "12.5",
      DEADLINE_SECS: "NaN",
      FAIR_VALUE_BPS: "-1",
      AGENT_STARTUP_PROBE_TIMEOUT_MS: "0x10",
    }).run(),
  );
  for (const name of ["MIN_EDGE_BPS", "CONFIDENCE_THRESHOLD_BPS", "SLIPPAGE_BPS", "DEADLINE_SECS", "FAIR_VALUE_BPS", "AGENT_STARTUP_PROBE_TIMEOUT_MS"]) {
    assert.ok(issues.some((i) => i.startsWith(`${name}:`)), `${name} missing from ${issues.join(" | ")}`);
  }
});

test("invalid stroop amounts fail", async () => {
  const cases: Record<string, string>[] = [
    { TRADE_SIZE_STROOPS: "0" },
    { TRADE_SIZE_STROOPS: "-5" },
    { TRADE_SIZE_STROOPS: "1.5" },
    { TRADE_SIZE_STROOPS: "1e9" },
    { TRADE_SIZE_STROOPS: (1n << 127n).toString() },
    { DEFAULT_SEED_STROOPS: "999999999" },
    { DEFAULT_SEED_STROOPS: "" },
  ];
  for (const env of cases) {
    const [name] = Object.keys(env);
    const issues = await issuesOf(load(env).run());
    assert.ok(issues.some((i) => i.startsWith(`${name}:`)), `${JSON.stringify(env)}: ${issues}`);
  }
  const ok = await load({ TRADE_SIZE_STROOPS: ((1n << 127n) - 1n).toString(), DEFAULT_SEED_STROOPS: "1000000000" }).run();
  assert.equal(ok.maker.defaultSeedStroops, 1_000_000_000n);
});

test("live mode requires a secret", async () => {
  const issues = await issuesOf(load({ AGENT_MODE: "live" }).run());
  assert.ok(issues.some((i) => /TRADER_SECRET_KEY or AGENT_SECRET_KEY/.test(i)), issues.join(" | "));
});

test("a malformed secret is rejected even in dry-run", async () => {
  const issues = await issuesOf(load({ AGENT_SECRET_KEY: "SNOTAKEY" }).run());
  assert.ok(issues.some((i) => i.startsWith("AGENT_SECRET_KEY:")));
});

test("live mode requires the secret to match deployments.agent", async () => {
  const issues = await issuesOf(load({ AGENT_MODE: "live", AGENT_SECRET_KEY: OTHER.secret() }).run());
  assert.ok(issues.some((i) => i.includes(OTHER.publicKey()) && i.includes(AGENT.publicKey())), issues.join(" | "));

  const cfg = await load(LIVE).run();
  assert.equal(cfg.agentAddress, AGENT.publicKey());
  assert.equal(cfg.agentSecret, AGENT.secret());
});

test("a role key must match that role's registered agent", async () => {
  const record = deployment({ agents: { maker: MAKER.publicKey(), trader: OTHER.publicKey() } });
  const cfg = await load({ AGENT_MODE: "live", MAKER_SECRET_KEY: MAKER.secret() }, { role: "maker", record }).run();
  assert.equal(cfg.agentAddress, MAKER.publicKey());

  const issues = await issuesOf(load({ AGENT_MODE: "live", AGENT_SECRET_KEY: AGENT.secret() }, { role: "trader", record }).run());
  assert.ok(issues.some((i) => i.includes("agents.trader")), issues.join(" | "));
});

test("dry-run never carries the secret, even when one is configured", async () => {
  const cfg = await load({ AGENT_SECRET_KEY: AGENT.secret() }).run();
  assert.equal(cfg.agentSecret, undefined);
});

test("an RPC that serves another network's passphrase prevents live startup", async () => {
  const probe = new FakeProbe(NETWORKS.futurenet.passphrase);
  const issues = await issuesOf(load(LIVE, { probe }).run());
  assert.ok(issues.some((i) => i.includes(NETWORKS.futurenet.passphrase)), issues.join(" | "));
});

test("in dry-run a failing probe is a warning, not an error", async () => {
  const probe: NetworkProbe = {
    passphrase: async () => Promise.reject(new Error("connect ECONNREFUSED")),
    contractsExist: async () => ({ missing: [], archived: [] }),
  };
  const { run, logs } = load({}, { probe });
  const cfg = await run();
  assert.equal(cfg.mode, "dry-run");
  assert.ok(logs.some((l) => l.includes("ECONNREFUSED")));
});

test("live mode fails when the RPC cannot be reached", async () => {
  const probe: NetworkProbe = {
    passphrase: async () => Promise.reject(new Error("getNetwork timed out after 5000 ms")),
    contractsExist: async () => ({ missing: [], archived: [] }),
  };
  const issues = await issuesOf(load(LIVE, { probe }).run());
  assert.ok(issues.some((i) => i.includes("timed out")));
});

test("an explicit passphrase that disagrees with STELLAR_NETWORK is rejected", async () => {
  const issues = await issuesOf(load({ STELLAR_NETWORK_PASSPHRASE: NETWORKS.mainnet.passphrase }).run());
  assert.ok(issues.some((i) => i.startsWith("STELLAR_NETWORK_PASSPHRASE")));
});

test("x402 payment requirements are validated at startup", async () => {
  // A complete, consistent x402 route loads cleanly.
  const ok = await load({
    X402_FACILITATOR_URL: "https://facilitator.example.com",
    X402_RECIPIENT: MAKER.publicKey(),
    X402_ASSET: CONTRACTS.usdc,
    X402_AMOUNT_STROOPS: "1000000",
  }).run();
  assert.equal(ok.x402?.facilitatorUrl, "https://facilitator.example.com");
  assert.equal(ok.x402?.recipient, MAKER.publicKey());
  assert.equal(ok.x402?.asset, CONTRACTS.usdc);
  assert.equal(ok.x402?.amountStroops, 1_000_000n);

  // A malformed facilitator URL is rejected.
  const badUrl = await issuesOf(load({ X402_FACILITATOR_URL: "not a url" }).run());
  assert.ok(badUrl.some((i) => i.startsWith("X402_FACILITATOR_URL:")), badUrl.join(" | "));

  // A non-StrKey recipient is rejected.
  const badRecipient = await issuesOf(load({ X402_RECIPIENT: "GNOTANADDRESS" }).run());
  assert.ok(badRecipient.some((i) => i.startsWith("X402_RECIPIENT:")), badRecipient.join(" | "));

  // A non-contract asset identifier is rejected.
  const badAsset = await issuesOf(load({ X402_ASSET: "USDC" }).run());
  assert.ok(badAsset.some((i) => i.startsWith("X402_ASSET:")), badAsset.join(" | "));

  // A non-positive amount is rejected.
  const badAmount = await issuesOf(load({ X402_AMOUNT_STROOPS: "0" }).run());
  assert.ok(badAmount.some((i) => i.startsWith("X402_AMOUNT_STROOPS:")), badAmount.join(" | "));

  // A partially configured route fails with a precise error naming the missing key.
  const partial = await issuesOf(load({ X402_FACILITATOR_URL: "https://facilitator.example.com" }).run());
  assert.ok(partial.some((i) => i.startsWith("X402_RECIPIENT:")), partial.join(" | "));
});

test("contracts missing on chain produce a precise startup error", async () => {
  const probe = new FakeProbe(NETWORKS.testnet.passphrase, { missing: ["market_core"], archived: [] });
  const issues = await issuesOf(load(LIVE, { probe }).run());
  assert.ok(issues.some((i) => i.includes("market_core")), issues.join(" | "));
});
