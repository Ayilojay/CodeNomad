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
