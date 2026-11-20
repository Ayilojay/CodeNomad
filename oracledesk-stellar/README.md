# OracleDesk Stellar

OracleDesk Stellar is the on-chain oracle and settlement layer for OracleDesk. This package contains the Soroban contracts, the TypeScript indexer that projects contract events into queryable state, and the shared client tooling used by the dashboard and API.

## Repository layout

- `contracts/` — Soroban smart contracts (oracle registry, request lifecycle, settlement).
- `indexer/` — event ingestion, cursor management, and projection into the read model.
- `sdk/` — generated bindings and typed helpers shared by consumers.
- `scripts/` — localnet bootstrap and deterministic fixture generation.

## Getting started

```bash
npm install
npm run build
npm test
```

Localnet workflows require a running Stellar quickstart container and a deployed contract set; see `scripts/localnet.sh` for the bootstrap sequence.

## Indexer: network and deployment isolation

The indexer is scoped to a single `(network, contract deployment)` identity. Every persisted key, cursor, and query is namespaced by that identity so that data from one network or deployment can never be read, resumed, or overwritten by another.

### Identity

An indexer identity is the pair:

- `network` — the Stellar network passphrase identifier (e.g. `testnet`, `futurenet`, `local`, or `mainnet`).
- `deployment` — the deployed contract set identifier (the registry contract ID plus the deployment generation recorded at deploy time).

Both values are required. The indexer refuses to start if either is missing or empty; there is no implicit default and no fallback to a previously observed identity.

### Key and query namespacing

All indexer state is written under a namespace derived from the identity:

- Event and projection records are keyed by `network/deployment/...`.
- Cursor records are keyed by `network/deployment/cursor`.
- Read queries require the same identity and only return records within that namespace.

Because the namespace is part of the key, two deployments on the same network (for example a redeploy after a contract upgrade) are fully isolated: replaying one deployment never mutates the other's projections.

### Cursor reuse rules

A cursor is only valid for the identity that produced it. On startup the indexer compares the stored cursor's identity against the configured identity:

- **Match** — ingestion resumes from the stored ledger/event position.
- **Mismatch** (different network or different deployment) — the indexer rejects the cursor and fails fast with an explicit error. It does not silently reset, skip, or continue from a different position.
- **Missing identity on a stored cursor** — treated as a mismatch and rejected.

Operators who intentionally want to start a new deployment must provision a fresh identity (new deployment generation) rather than reusing an existing cursor. Re-indexing from genesis for a new identity is an explicit, operator-initiated action.

### Operator-visible behavior

- Startup logs the resolved `network` and `deployment` identity before any ingestion begins.
- A rejected cursor surfaces a non-zero exit with a message naming both the stored and configured identities.
- Health/status output reports the active identity alongside the last processed ledger.
- No success-shaped fallback exists: a mismatched or missing identity is always an error, never a silent fresh start.

### Configuration

Set both values via environment or config file:

```
INDEXER_NETWORK=testnet
INDEXER_DEPLOYMENT=<registry-contract-id>:<generation>
```

Both are required in every environment, including localnet. Deterministic fixtures under `scripts/` pin the same identity so local runs are reproducible.

### Compatibility

Namespaced keys are a breaking change for any consumer that read indexer state using the previous flat keys. Consumers must supply the identity when querying; the SDK helpers accept the identity pair and construct namespaced queries. Existing deployments should be re-indexed under their correct identity before switching consumers over.

### Validation

Run the focused indexer tests:

```bash
npm test --workspace indexer
```

Coverage includes successful ingestion under a matching identity, rejection of a cursor from a different network, rejection of a cursor from a different deployment on the same network, and rejection when the stored cursor has no identity. Exercise the feature on localnet with the deterministic fixtures in `scripts/`; a running quickstart container is the only external prerequisite.

## Payment integrity and contract verification

Indexer isolation does not relax settlement guarantees: payment records remain bound to their originating transaction and contract verification results are never inferred from a different deployment's state. Cross-deployment reads are impossible by construction because the namespace is part of every key.
