import assert from "node:assert/strict";
import test from "node:test";
import { redact, redactString, REDACTED } from "./redact.js";

test("redacts sensitive fields recursively without mutating the input", () => {
  const source = {
    agent: "trader",
    privateKey: "private-value",
    nested: { api_token: "token-value", count: 2 },
    messages: [{ text: "safe" }],
  };
  const result = redact(source);
  assert.deepEqual(result, {
    agent: "trader",
    privateKey: REDACTED,
    nested: { api_token: REDACTED, count: 2 },
    messages: [{ text: "safe" }],
  });
  assert.equal(source.privateKey, "private-value");
});

test("redacts Stellar secret seeds, bearer credentials, and URL query secrets in text", () => {
  const secret = `S${"A".repeat(55)}`;
  assert.equal(
    redactString(`seed=${secret} Bearer abc.def token?api_key=topsecret`),
    `seed=${REDACTED} Bearer ${REDACTED} token?api_key=${REDACTED}`,
  );
});

test("handles cyclic values", () => {
  const value: { self?: unknown; password: string } = { password: "hidden" };
  value.self = value;
  const result = redact(value) as typeof value;
  assert.equal(result.password, REDACTED);
  assert.equal(result.self, result);
});

// Confidentiality boundary: serialized traces must never carry secrets or
// private keys. These tests pin the public-data contract documented for
// operators (on-chain data, CIDs, x402 responses, and logs are public).
test("serialized traces never contain Stellar secret seeds or private keys", () => {
  const secretSeed = `S${"B".repeat(55)}`;
  const trace = {
    agent: "trader",
    privateKey: secretSeed,
    signer: { secretKey: secretSeed, publicKey: `G${"C".repeat(55)}` },
    x402: { response: { authorization: "Bearer live-token" } },
    note: `signed with ${secretSeed}`,
  };
  const serialized = JSON.stringify(redact(trace));
  assert.ok(!serialized.includes(secretSeed), "secret seed leaked into trace");
  assert.ok(!serialized.includes("live-token"), "bearer token leaked into trace");
  assert.ok(serialized.includes(`G${"C".repeat(55)}`), "public key should remain");
});

test("redaction is idempotent so re-serialized traces stay clean", () => {
  const once = redact({ apiKey: "k", nested: { password: "p" } });
  const twice = redact(once);
  assert.deepEqual(twice, once);
  assert.equal(JSON.stringify(twice).includes("\"k\""), false);
});

// Signal adapter provenance: normalized observations must carry a source ID
// and evidence hash, and any credentials embedded in provider payloads must be
// redacted before they reach traces or logs.
test("redacts credentials embedded in provider observation payloads", () => {
  const secretSeed = `S${"D".repeat(55)}`;
  const observation = {
    sourceId: "provider-alpha",
    evidenceHash: "0xabc123",
    value: 42,
    timestamp: 1_700_000_000_000,
    raw: {
      apiKey: "provider-key",
      authorization: "Bearer provider-token",
      signer: secretSeed,
    },
  };
  const serialized = JSON.stringify(redact(observation));
  assert.ok(!serialized.includes("provider-key"), "api key leaked");
  assert.ok(!serialized.includes("provider-token"), "bearer token leaked");
  assert.ok(!serialized.includes(secretSeed), "secret seed leaked");
  assert.ok(serialized.includes("provider-alpha"), "source id should remain");
  assert.ok(serialized.includes("0xabc123"), "evidence hash should remain");
});

// Payer-facing payment error taxonomy (#83): payer-visible error payloads must
// be redacted so internal identifiers, stack traces, and upstream payloads
// never leak while retryability and recovery guidance stay intact.
test("redacts sensitive internals from payer-facing payment error payloads", () => {
  const secretSeed = `S${"E".repeat(55)}`;
  const payerError = {
    schemaVersion: "x402.payment-error.v1",
    code: "uncertain_settlement",
    retryable: false,
    recovery: "Do not resubmit; reconcile settlement before retrying.",
    internal: {
      stack: "Error: boom\n    at settle (/srv/agents/core/settle.ts:42:7)",
      requestId: "req-internal-123",
      upstream: { authorization: "Bearer upstream-token", signer: secretSeed },
    },
  };
  const serialized = JSON.stringify(redact(payerError));
  assert.ok(!serialized.includes("settle.ts"), "stack trace leaked");
  assert.ok(!serialized.includes("req-internal-123"), "internal id leaked");
  assert.ok(!serialized.includes("upstream-token"), "upstream token leaked");
  assert.ok(!serialized.includes(secretSeed), "secret seed leaked");
  assert.ok(serialized.includes("x402.payment-error.v1"), "schema version should remain");
  assert.ok(serialized.includes("uncertain_settlement"), "error code should remain");
  assert.ok(serialized.includes("Do not resubmit"), "recovery guidance should remain");
});
