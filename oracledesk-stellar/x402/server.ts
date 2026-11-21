import "dotenv/config";
import { rpc } from "@stellar/stellar-sdk";
import { MemoryPaymentLedger, SqlitePaymentLedger } from "./payment-ledger.js";
import {
  createTraceApi,
  MapTraceRepository,
  type TraceRecord,
  type TraceRepository,
} from "./trace-api.js";
import { createRegistryTraceRepository } from "./registry-trace-repository.js";

interface BuiltRepository {
  repository: TraceRepository;
  listRepository?: TraceListRepository;
}

async function buildRepository(): Promise<BuiltRepository> {
  const contractId = process.env.REASONING_REGISTRY_CONTRACT_ID;
  if (contractId) {
    console.log(
      `OracleDesk x402: reading traces from reasoning-registry ${contractId}`,
    );
    return createRegistryTraceRepository({
      contractId,
      rpcUrl:
        process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org",
      networkPassphrase:
        process.env.STELLAR_NETWORK_PASSPHRASE ??
        "Test SDF Network ; September 2015",
    });
    return { repository, listRepository: repository };
  }
  console.log(
    "OracleDesk x402: REASONING_REGISTRY_CONTRACT_ID not set — falling back to TRACE_RECORDS_JSON",
  );
  const records = JSON.parse(
    process.env.TRACE_RECORDS_JSON ?? "[]",
  ) as TraceRecord[];
  return new MapTraceRepository(
    new Map(records.map((record) => [record.traceId, record])),
  );
}

// Transport hardening defaults. All values are operator-overridable via env.
// - X402_MAX_BODY_BYTES: max accepted request body size (default 1 MiB).
// - X402_REQUEST_TIMEOUT_MS: whole-request timeout (default 30s).
// - X402_HEADERS_TIMEOUT_MS: time to receive request headers (default 15s).
// - X402_IDLE_TIMEOUT_MS: keep-alive idle timeout (default 60s).
// - X402_TRUST_PROXY: opt-in trusted-proxy policy. Unset/"false" means
//   forwarded headers (X-Forwarded-For) are ignored and the socket peer
//   address is used. Set to "true" to trust the immediate proxy, or a
//   comma-separated list of trusted proxy IPs/CIDRs.
const MAX_BODY_BYTES = Number(process.env.X402_MAX_BODY_BYTES ?? 1024 * 1024);
const REQUEST_TIMEOUT_MS = Number(
  process.env.X402_REQUEST_TIMEOUT_MS ?? 30000,
);
const HEADERS_TIMEOUT_MS = Number(
  process.env.X402_HEADERS_TIMEOUT_MS ?? 15000,
);
const IDLE_TIMEOUT_MS = Number(process.env.X402_IDLE_TIMEOUT_MS ?? 60000);
const TRUST_PROXY = process.env.X402_TRUST_PROXY;

function parseTrustProxy(
  value: string | undefined,
): boolean | string[] {
  if (!value || value === "false" || value === "0") return false;
  if (value === "true" || value === "1") return true;
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function main() {
  const mode = process.env.X402_LEDGER ?? "sqlite";
  if (!["memory", "sqlite"].includes(mode))
    throw new Error("X402_LEDGER must be memory or sqlite");
  const ledgerPath = process.env.X402_LEDGER_PATH ?? "./.x402-ledger.sqlite";
  const ledger =
    mode === "memory"
      ? new MemoryPaymentLedger()
      : new SqlitePaymentLedger(ledgerPath);
  await ledger.reconcileStuck(0);
  const app = createTraceApi({
    ledger,
    ledgerSequence: async (network) => {
      const url =
        network === "stellar:testnet"
          ? (process.env.STELLAR_TESTNET_RPC_URL ??
            "https://soroban-testnet.stellar.org")
          : (process.env.STELLAR_MAINNET_RPC_URL ??
            "https://soroban.stellar.org");
      return (await new rpc.Server(url, { timeout: 5 }).getLatestLedger())
        .sequence;
    },
    adminToken: process.env.X402_ADMIN_TOKEN,
    requireAllNetworks: process.env.X402_REQUIRE_ALL_NETWORKS !== "false",
    traceLoadTimeoutMs: Number(process.env.X402_TRACE_LOAD_TIMEOUT_MS ?? 10000),
    maxTimeoutSeconds: Number(process.env.X402_MAX_TIMEOUT_SECONDS ?? 60),
    facilitatorTimeoutMs: Number(
      process.env.X402_FACILITATOR_TIMEOUT_MS ?? 5000,
    ),
    repository: await buildRepository(),
    ipfsGateway: process.env.IPFS_GATEWAY_URL ?? "https://ipfs.io/ipfs",
    price: process.env.TRACE_PRICE_USDC ?? "0.01",
    paymentsDisabled: process.env.PAYMENTS_DISABLED === "1",
    networks: [
      ...(process.env.TESTNET_SERVER_STELLAR_ADDRESS &&
      process.env.TESTNET_FACILITATOR_URL
        ? [
            {
              network: "stellar:testnet" as const,
              payTo: process.env.TESTNET_SERVER_STELLAR_ADDRESS,
              facilitatorUrl: process.env.TESTNET_FACILITATOR_URL,
              facilitatorApiKey: process.env.TESTNET_FACILITATOR_API_KEY,
            },
          ]
        : []),
      ...(process.env.MAINNET_SERVER_STELLAR_ADDRESS &&
      process.env.MAINNET_FACILITATOR_URL
        ? [
            {
              network: "stellar:pubnet" as const,
              payTo: process.env.MAINNET_SERVER_STELLAR_ADDRESS,
              facilitatorUrl: process.env.MAINNET_FACILITATOR_URL,
              facilitatorApiKey: process.env.MAINNET_FACILITATOR_API_KEY,
            },
          ]
        : []),
    ],
  });

  // Trusted-proxy policy: opt-in and safe by default. When disabled, Express
  // ignores X-Forwarded-For and uses the socket peer address for req.ip.
  app.set("trust proxy", parseTrustProxy(TRUST_PROXY));

  // Secure response headers applied to every response.
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'none'",
    );
    if (process.env.X402_ENABLE_HSTS === "1") {
      res.setHeader(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains",
      );
    }
    next();
  });

  // Reject unsupported methods before any payment processing runs.
  const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST", "OPTIONS"]);
  app.use((req, res, next) => {
    if (!ALLOWED_METHODS.has(req.method)) {
      res.setHeader("Allow", [...ALLOWED_METHODS].join(", "));
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }
    next();
  });

  // Enforce an explicit maximum request body size before payment processing.
  app.use((req, res, next) => {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      res.setHeader("Connection", "close");
      res.status(413).json({
        error: "payload_too_large",
        maxBytes: MAX_BODY_BYTES,
      });
      return;
    }
    let received = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      if (rejected) return;
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        rejected = true;
        res.setHeader("Connection", "close");
        res.status(413).json({
          error: "payload_too_large",
          maxBytes: MAX_BODY_BYTES,
        });
        req.destroy();
      }
    });
    next();
  });

  try {
    await app.locals.ready;
  } catch (error) {
    ledger.close();
    throw error;
  }
  console.log("OracleDesk x402 networks:", app.locals.networks);
  const port = Number(process.env.PORT ?? 3001);
  const server = app.listen(port, () => {
    console.log(`OracleDesk x402 trace API listening on port ${port}`);
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = IDLE_TIMEOUT_MS;
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      server.close(() => {
        ledger.close();
      });
    });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
