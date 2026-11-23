import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@stellar/stellar-sdk";
import {
  actionToAttestationBytes,
  buildKeyBindMessage,
  buildTraceAttestationMessage,
  createMultisigEnvelope,
  signKeyBind,
  signTraceAttestation,
  verifyKeyBind,
  verifyTraceAttestation,
  type KeyBindContext,
  type TraceAttestationContext,
} from "./signing.js";
import { hashTrace, type ReasoningTrace } from "./trace.js";
import {
  generateSignerPolicy,
  renderSignerPolicyDiff,
  type DeploymentManifest,
} from "./signer-policy.js";

const SEED = Uint8Array.from({ length: 32 }, (_, i) => i);
const keypair = () => Keypair.fromRawEd25519Seed(Buffer.from(SEED));

const REGISTRY_ID = "CC3KU5TWAATOBXLWIV4ZTXNEM44VIOY3ZTR7KTJTBOOBP7YIXMCDSWDJ";
const AGENT_ADDRESS = "GBAKBHXK7SV7C3HGY3DDYB4QWUEGL52SEF6OO77LAD672JVXD4QCYJLF";
const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

test("actionToAttestationBytes handles canonical actions and custom Other", () => {
  assert.deepEqual(actionToAttestationBytes("create_market"), Buffer.from([0]));
  assert.deepEqual(actionToAttestationBytes("propose_market"), Buffer.from([1]));
  assert.deepEqual(actionToAttestationBytes("buy"), Buffer.from([2]));
  assert.deepEqual(actionToAttestationBytes("sell"), Buffer.from([3]));
  assert.deepEqual(actionToAttestationBytes("skip"), Buffer.from([4]));
  assert.deepEqual(actionToAttestationBytes("redeem"), Buffer.from([5]));
  assert.deepEqual(actionToAttestationBytes("claim_remainder"), Buffer.from([6]));
  assert.deepEqual(actionToAttestationBytes("resolve"), Buffer.from([7]));

  const customBytes = actionToAttestationBytes("other:custom_strategy");
  assert.equal(customBytes[0], 8);
  assert.ok(customBytes.length > 1);
});

test("key binding signing and verification cycle", () => {
  const kp = keypair();
  const ctx: Omit<KeyBindContext, "publicKey"> = {
    networkPassphrase: NETWORK_PASSPHRASE,
    registryId: REGISTRY_ID,
    agent: AGENT_ADDRESS,
  };

  const { publicKey, signature } = signKeyBind(kp, ctx);
  assert.equal(publicKey.length, 32);
  assert.equal(signature.length, 64);

  assert.equal(verifyKeyBind(publicKey, signature, ctx), true);

  // Tampered agent address rejects
  assert.equal(
    verifyKeyBind(publicKey, signature, {
      ...ctx,
      agent: "GCKBJQ6633JFYSFV6HHF2FQUN4QUX5PVE63PODYIKO2CE3RCXAF5NZCW",
    }),
    false,
  );

  // Tampered network passphrase rejects
  assert.equal(
    verifyKeyBind(publicKey, signature, {
      ...ctx,
      networkPassphrase: "Public Global Stellar Network ; September 2015",
    }),
    false,
  );

  // Tampered signature rejects
  const badSig = new Uint8Array(signature);
  badSig[0] ^= 0xff;
  assert.equal(verifyKeyBind(publicKey, badSig, ctx), false);
});

test("trace attestation signing and verification cycle", () => {
  const kp = keypair();
  const traceHash = Uint8Array.from({ length: 32 }, (_, i) => 0xb0 + i);
  const ctx: TraceAttestationContext = {
    networkPassphrase: NETWORK_PASSPHRASE,
    registryId: REGISTRY_ID,
    agent: AGENT_ADDRESS,
    marketId: 42n,
    action: "buy",
    traceHash,
  };

  const { publicKey, signature } = signTraceAttestation(kp, ctx);
  assert.equal(publicKey.length, 32);
  assert.equal(signature.length, 64);

  assert.equal(verifyTraceAttestation(publicKey, signature, ctx), true);

  // Tampered fields reject
  assert.equal(verifyTraceAttestation(publicKey, signature, { ...ctx, marketId: 43n }), false);
  assert.equal(verifyTraceAttestation(publicKey, signature, { ...ctx, action: "sell" }), false);
  assert.equal(
    verifyTraceAttestation(publicKey, signature, {
      ...ctx,
      traceHash: Uint8Array.from({ length: 32 }, () => 0),
    }),
    false,
  );
  assert.equal(
    verifyTraceAttestation(publicKey, signature, {
      ...ctx,
      agent: "GCKBJQ6633JFYSFV6HHF2FQUN4QUX5PVE63PODYIKO2CE3RCXAF5NZCW",
    }),
    false,
  );
});

test("trace attestation verifies with real reasoning trace JSON hash offline", () => {
  const kp = keypair();
  const trace: ReasoningTrace = {
    agent: "trader",
    marketId: 10,
    action: "buy",
    reasoning: "Fair probability 0.65 exceeds market price 0.50 by 1500 bps",
    inputs: { p_fair: 0.65, p_market: 0.50 },
    timestamp: 1700000000,
  };

  const traceHash = hashTrace(trace);
  const ctx: TraceAttestationContext = {
    networkPassphrase: NETWORK_PASSPHRASE,
    registryId: REGISTRY_ID,
    agent: AGENT_ADDRESS,
    marketId: BigInt(trace.marketId!),
    action: trace.action,
    traceHash: Buffer.from(traceHash, "hex"),
  };

  const { publicKey, signature } = signTraceAttestation(kp, ctx);
  assert.equal(verifyTraceAttestation(publicKey, signature, ctx), true);

  // If trace JSON is modified, recomputed hash changes and verification fails
  const modifiedTrace = { ...trace, reasoning: "Fraudulent changed explanation" };
  const modifiedHash = hashTrace(modifiedTrace);
  assert.equal(
    verifyTraceAttestation(publicKey, signature, {
      ...ctx,
      traceHash: Buffer.from(modifiedHash, "hex"),
    }),
    false,
  );
});

test("multisig envelope collects signatures up to threshold", () => {
  const envelope = createMultisigEnvelope({
    payload: Buffer.from("transfer:100"),
    threshold: 2,
    expiresAt: 1_000,
  });

  const a = Keypair.random();
  const b = Keypair.random();

  assert.equal(envelope.status(500).collected, 0);
  assert.equal(envelope.status(500).ready, false);

  assert.equal(envelope.addSignature(a, 500), true);
  assert.equal(envelope.status(500).collected, 1);
  assert.equal(envelope.status(500).ready, false);

  assert.equal(envelope.addSignature(b, 500), true);
  const status = envelope.status(500);
  assert.equal(status.collected, 2);
  assert.equal(status.ready, true);
  assert.equal(status.threshold, 2);
});

test("multisig envelope rejects duplicate participant signatures", () => {
  const envelope = createMultisigEnvelope({
    payload: Buffer.from("transfer:100"),
    threshold: 2,
    expiresAt: 1_000,
  });
  const a = Keypair.random();

  assert.equal(envelope.addSignature(a, 500), true);
  assert.equal(envelope.addSignature(a, 500), false);
  assert.equal(envelope.status(500).collected, 1);
});

test("multisig envelope rejects expired envelopes", () => {
  const envelope = createMultisigEnvelope({
    payload: Buffer.from("transfer:100"),
    threshold: 1,
    expiresAt: 1_000,
  });
  const a = Keypair.random();

  assert.equal(envelope.addSignature(a, 1_001), false);
  assert.equal(envelope.status(1_001).expired, true);
  assert.equal(envelope.status(1_001).ready, false);
});

test("multisig envelope rejects altered payload envelopes", () => {
  const envelope = createMultisigEnvelope({
    payload: Buffer.from("transfer:100"),
    threshold: 1,
    expiresAt: 1_000,
  });
  const a = Keypair.random();
  assert.equal(envelope.addSignature(a, 500), true);

  // Altered payload no longer matches the bound payload hash
  assert.equal(
    envelope.verifyPayload(Buffer.from("transfer:999")),
    false,
  );
  assert.equal(envelope.verifyPayload(Buffer.from("transfer:100")), true);
});

const MANIFEST: DeploymentManifest = {
  networkPassphrase: NETWORK_PASSPHRASE,
  contracts: [
    {
      contractId: REGISTRY_ID,
      functions: [
        {
          name: "bind_key",
          args: [{ name: "public_key", type: "bytes" }],
        },
        {
          name: "submit_trace",
          args: [
            { name: "market_id", type: "u64" },
            { name: "action", type: "symbol" },
            { name: "trace_hash", type: "bytes" },
          ],
        },
      ],
    },
  ],
};

test("signer policy generation emits allowlist keyed by contract/function/arg hash", () => {
  const policy = generateSignerPolicy(MANIFEST);
  assert.equal(policy.entries.length, 2);

  const bind = policy.entries.find((e) => e.function === "bind_key");
  assert.ok(bind);
  assert.equal(bind!.contractId, REGISTRY_ID);
  assert.match(bind!.argumentHash, /^[0-9a-f]{64}$/);

  const submit = policy.entries.find((e) => e.function === "submit_trace");
  assert.ok(submit);
  assert.notEqual(submit!.argumentHash, bind!.argumentHash);
});

test("signer policy generation is deterministic and order-independent", () => {
  const reordered: DeploymentManifest = {
    networkPassphrase: NETWORK_PASSPHRASE,
    contracts: [
      {
        contractId: REGISTRY_ID,
        functions: [...MANIFEST.contracts[0].functions].reverse(),
      },
    ],
  };
  const a = generateSignerPolicy(MANIFEST);
  const b = generateSignerPolicy(reordered);
  assert.deepEqual(a, b);
});

test("signer policy generation rejects empty manifests", () => {
  assert.throws(
    () => generateSignerPolicy({ networkPassphrase: NETWORK_PASSPHRASE, contracts: [] }),
    /manifest must declare at least one contract/,
  );
});

test("signer policy generation rejects duplicate contract/function entries", () => {
  const dup: DeploymentManifest = {
    networkPassphrase: NETWORK_PASSPHRASE,
    contracts: [
      {
        contractId: REGISTRY_ID,
        functions: [
          { name: "bind_key", args: [{ name: "public_key", type: "bytes" }] },
          { name: "bind_key", args: [{ name: "public_key", type: "bytes" }] },
        ],
      },
    ],
  };
  assert.throws(() => generateSignerPolicy(dup), /duplicate function/);
});

test("signer policy diff renders reviewable per-entry lines", () => {
  const policy = generateSignerPolicy(MANIFEST);
  const diff = renderSignerPolicyDiff(policy);
  assert.match(diff, /\+ contract=/);
  assert.match(diff, /function=bind_key/);
  assert.match(diff, /function=submit_trace/);
  assert.match(diff, /argHash=[0-9a-f]{64}/);
});

test("signer policy diff marks removed entries as denied", () => {
  const policy = generateSignerPolicy(MANIFEST);
  const reduced: DeploymentManifest = {
    networkPassphrase: NETWORK_PASSPHRASE,
    contracts: [
      {
        contractId: REGISTRY_ID,
        functions: [MANIFEST.contracts[0].functions[0]],
      },
    ],
  };
  const diff = renderSignerPolicyDiff(policy, generateSignerPolicy(reduced));
  assert.match(diff, /- contract=/);
  assert.match(diff, /function=submit_trace/);
});

test("live adapter e2e: build, sign, submit, confirm, reconcile one bounded tx", () => {
  // Ephemeral key generated per run; never persisted or reused.
  const ephemeral = Keypair.random();
  const adapter = createLiveAdapter({
    rpcUrl: "http://127.0.0.1:8000/soroban/rpc",
    networkPassphrase: NETWORK_PASSPHRASE,
    signer: ephemeral,
    dryRun: false,
  });

  const built = adapter.buildBoundedTransaction({
    source: ephemeral.publicKey(),
    contractId: REGISTRY_ID,
    method: "bind_key",
    args: [Buffer.from(ephemeral.publicKey())],
    maxFee: 100_000n,
  });
  assert.ok(built.unsignedXdr.length > 0);

  const signed = adapter.sign(built);
  assert.ok(signed.signedXdr.length > 0);
  assert.notEqual(signed.signedXdr, built.unsignedXdr);

  const submitted = adapter.submit(signed);
  assert.ok(submitted.hash.length > 0);

  const confirmed = adapter.confirm(submitted.hash);
  assert.equal(confirmed.status, "SUCCESS");

  const reconciled = adapter.reconcile(submitted.hash);
  assert.equal(reconciled.hash, submitted.hash);
});
