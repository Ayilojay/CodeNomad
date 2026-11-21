# OracleDesk Stellar

OracleDesk Stellar is the on-chain oracle and settlement layer for OracleDesk. This package contains the Soroban contracts, the TypeScript indexer that projects contract events into queryable state, and the shared client tooling used by the dashboard and API.

## Incident & recovery runbook

This runbook covers the two live services — the **agents** (`agents/`, the
Market Maker and Trader CLIs) and the **payment/trace API** (`x402/`) — plus
the Soroban contracts they drive. It is written for testnet operators; the
same steps apply to any future deployment. Read `docs/STATUS.md` first: it is
the honest account of what is verified.

Guiding rule: **never present unverified state as live.** If a step below
cannot confirm on-chain state, stop and escalate rather than guessing or
silently falling back.

### 1. Containment

Goal: stop new value-moving actions while preserving evidence.

1. **Stop the agents.** Kill the Market Maker and Trader processes (or scale
their deployment to zero). Agents are the only components that sign
`agent_create_market` / `agent_buy` / `agent_sell`; stopping them halts new
orders immediately. Do not delete their logs or working directories.
2. **Pause the payment API.** Stop the `x402/` service so it stops serving
traces and accepting payment. A stopped API fails closed — buyers get an
error, not stale or fabricated data.
3. **Preserve evidence before touching anything else.** Copy, do not move:
   - agent stdout/stderr logs and any local state files;
   - the x402 service logs and the request IDs of in-flight payments;
   - `deployments/<network>.json` (the addresses in force at incident time);
   - the transaction hashes of every action taken in the incident window
     (from the agent logs and from a Stellar explorer / Horizon query).
4. **Do not** run `migrate-treasury.sh`, rotate keys, or redeploy contracts
   during containment. Those are recovery steps (§3–§5) and change state you
   may still need to inspect.

### 2. Pausing

There is no global on-chain pause switch; pausing is done by stopping the
services that act.

- **Agents:** stopping the processes is the pause. Because every action is a
  signed transaction, a stopped agent cannot move funds. Confirm no agent
  process is running before declaring the system paused.
- **Payment API:** stopping the `x402/` service pauses paid trace delivery.
  The reasoning registry is unaffected — published traces remain on-chain and
  verifiable; only the paid read path is down.
- **Contracts:** market-core, resolver, treasury and reasoning-registry have
  no pause entrypoint. To stop a misbehaving treasury from acting, stop the
  agent (the only signer) and, if needed, proceed to treasury migration (§5).
- **Resuming:** only after the root cause is understood and §4 reconciliation
  is complete. Restart the payment API first (it is read-only against the
  registry), verify a known trace hash resolves, then restart agents one at a
  time and watch the first few transactions before leaving them unattended.

### 3. Key rotation

The agent identity (`oracledesk-agent`) is the key that signs trades. Rotate
it if it may be compromised.

1. **Contain first** (§1): stop the agents so the old key cannot sign.
2. **Generate a new identity** with `stellar keys generate <new-name> --fund`
   (testnet) or your normal key-provisioning flow. Never reuse the old seed.
3. **Point the treasury at the new agent.** The treasury stores its agent
   address; changing it requires a **new treasury** (there are no config
   setters). Follow the treasury migration in §5, deploying the successor
   with the new agent address.
4. **Retire the old key:** remove it from the agent environment and from any
   secret store. Record the rotation (old address, new address, time,
   transaction hashes) in the incident log.
5. **Deployer/admin key:** the deployer identity is admin-gated for
   `set_successor` / `migrate_market` and market-core rewiring. Rotating it
   means re-running the admin steps with the new key; treat it with the same
   contain-then-rotate discipline and never rotate it mid-migration.

### 4. Uncertain transactions & payment reconciliation

An "uncertain" transaction is one where the client did not observe a
success/failure result — a timeout, a dropped connection, or a crash after
submission. **Never assume it failed and blindly retry**; a retry can double a
trade or double-charge a buyer.

Decision points for an uncertain agent transaction:

1. **Look it up on-chain.** Query the transaction hash (from the agent log)
   against Horizon / the explorer. Outcomes:
   - **Confirmed success** → record it; do not retry. Reconcile the position
     against the treasury/market state.
   - **Confirmed failure** → safe to retry once the cause is fixed.
   - **Not found / still pending** → wait for ledger close and re-query. Do
     not resubmit until you have a definitive answer or the transaction has
     provably expired.
2. **If no hash was captured** (crash before logging), reconstruct from the
   agent's account sequence number and recent operations on Horizon before
   taking any new action.
3. **Reconcile balances** against the treasury's on-chain positions and the
   SEP-41 USDC balance; the chain is the source of truth, not local state.

Payment (x402) reconciliation:

1. A buyer's payment is only "settled" if the trace hash verifies against the
   reasoning registry on-chain. If verification fails, the payment must be
   treated as **unsettled** — do not serve the trace, do not mark it paid.
2. For an in-flight payment interrupted by the pause, look up its settlement
   transaction the same way as §4.1. Refund or re-serve only after the
   on-chain outcome is known.
3. Never serve sample or cached trace data as if it were a live, verified
   trace. A failed verification is an error to the buyer, not a fallback.

### 5. State restore & service resumption

1. **Restore configuration from the preserved `deployments/<network>.json`**
   (§1.3). Do not hand-edit addresses; if the file is lost, recover addresses
   from the deploy transaction history before proceeding.
2. **Treasury recovery:** if the treasury must be replaced (bug, cap change,
   or key rotation), run `scripts/migrate-treasury.sh` per the Treasury
   migration section. It is admin-gated, idempotent, and sends value only to
   the recorded successor. Verify each `migrate_market` succeeded before
   declaring recovery complete.
3. **Market-core rewiring** (fee recipient cutover) is a separate, deliberate
   operator step — run the commands the migration script prints only after
   the successor treasury is verified.
4. **Resume services** in the order from §2: payment API, verify a known trace
   hash, then agents one at a time.
5. **Verify before declaring resolved:** a fresh `make demo` (or the
   `make e2e-local` harness for a hermetic check) should pass end to end, and
   the reconciled balances from §4 should match on-chain state.

### Operator verification checklist

- [ ] Agents stopped; no agent process signing.
- [ ] Payment API stopped; buyers receive errors, not stale data.
- [ ] Logs, `deployments/<network>.json`, and incident-window tx hashes
      preserved (copied, not moved).
- [ ] Every uncertain transaction resolved on-chain before any retry.
- [ ] Any key rotation recorded with old/new addresses and tx hashes.
- [ ] Treasury migration (if any) verified market by market.
- [ ] Services resumed in order; a known trace hash verifies; `make demo`
      or `make e2e-local` passes.

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
