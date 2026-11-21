# OracleDesk Stellar Agents

Autonomous agent runtime for the OracleDesk Stellar reasoning registry. Agents
observe on-chain events, reason over them, and publish signed reasoning traces
back to the registry.

## Reasoning registry

The reasoning registry stores agent traces and metadata. Traces are produced by
`agents/core/events/handlers.ts`, persisted through `agents/core/ipfs-store.ts`,
and selected for replay via `agents/core/state/select.ts`.

## Trace confidentiality and public-data boundaries

Before adding new fields to a trace or registry metadata, contributors must
understand what becomes public. The table below inventories every surface where
trace content or registry metadata can be observed.

| Surface | Visibility | What is exposed |
| --- | --- | --- |
| On-chain registry entry | Public, permanent | Trace CID, agent address, timestamps, and any metadata committed on-chain. Treat as world-readable forever. |
| IPFS CID content | Public, content-addressed | The full serialized trace document referenced by the CID. Anyone with the CID can fetch it; CIDs cannot be revoked. |
| x402 responses | Public to the paying client | The response body returned for a paid request, including any trace or metadata echoed back. |
| Logs | Operator-visible, may be shipped | Structured log lines emitted by handlers and the IPFS store. Assume logs may be aggregated or shared. |

### Redaction boundaries

- Never place secrets, API keys, private keys, seed phrases, or signing material
  in trace content, registry metadata, x402 response bodies, or log lines.
- Redact credentials and bearer tokens from any external payload before it is
  serialized into a trace.
- Keep personally identifying operator data out of on-chain metadata; commit only
  the CID and non-sensitive references.

### Encryption boundaries

- On-chain data and IPFS CIDs are public and cannot be encrypted retroactively.
  Do not rely on encryption for data already committed on-chain.
- Sensitive trace payloads must be encrypted client-side before they are pinned
  to IPFS; only the CID is published.
- x402 responses and logs are not an encryption boundary — treat them as
  plaintext and redact instead of encrypting.

### Verification

Serialized traces must never contain secrets or private keys. This is covered by
`agents/core/ipfs-store.test.ts`, which asserts that serialized trace output is
free of private-key and secret material. Run the suite to reproduce:

```
npm test -- agents/core/ipfs-store.test.ts
```

When adding a new trace or metadata field, extend that coverage so the field is
checked against the redaction boundary before it ships.

## Operator-visible behavior

- Registry entries and their CIDs are public and immutable once published.
- Redaction happens before serialization; operators see redacted traces in logs
  and x402 responses.
- Existing registry contract and interface guarantees are preserved; no
  migration is required for this documentation.
