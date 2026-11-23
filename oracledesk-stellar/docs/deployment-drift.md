# Testnet Deployment Drift Detection

## Purpose

The drift checker compares the addresses stored in `deployments/testnet.json`
against live contract metadata on the Stellar Soroban RPC.  It detects:

| Condition | Meaning |
|---|---|
| **missing** | No contract instance at that address — network was reset, wrong file, or the contract was never deployed. |
| **archived** | Instance exists but its storage TTL has lapsed — it must be restored before it can be called. |
| **WASM hash drift** | The live contract code hash differs from the pinned expected hash — an unreviewed upgrade or a redeployment without updating the manifest. |
| **probe error** | RPC call failed (network unreachable, timeout, rate-limited). |

The checker **never** submits transactions, replaces addresses, or falls back
silently when a probe fails.  Every error surfaces in the report.

## Running the check manually

```bash
cd oracledesk-stellar

# Install dependencies (first time only)
cd agents && npm ci && cd ..

# Run against the default testnet deployment record
npx tsx agents/core/deployment-drift.ts \
  --manifest deployments/testnet.json \
  --rpc https://soroban-testnet.stellar.org
```

The script exits `0` when the report is clean and `1` when any problem is
found.  The full JSON report is printed to stdout; human-readable problems go
to stderr.

## CI gate

The `deployment-drift` CI job (`ci.yml`) runs the focused unit tests on every
push and pull request.  The unit tests use deterministic fixtures and never
touch a network — they verify the detection logic itself, not live testnet
state.

Testnet state varies (network resets, archived entries) and is not suitable for
CI.  The manual procedure above is used for operator verification before a
release.

## Pinning expected WASM hashes

After a known-good deployment, record the WASM hashes in
`deployments/testnet.expected-hashes.json`:

```json
{
  "market_core": "<64-char hex sha256 of market_core.wasm>",
  "resolver": "<64-char hex sha256 of resolver.wasm>",
  "treasury": "<64-char hex sha256 of treasury.wasm>",
  "reasoning_registry": "<64-char hex sha256 of reasoning_registry.wasm>",
  "usdc": "<64-char hex sha256 — omit if the USDC contract is not yours>"
}
```

Retrieve the live WASM hash for a contract by running the check without pinned
hashes first; each `live` entry in the report includes the current `wasmHash`.

Pass the file to the checker:

```bash
npx tsx agents/core/deployment-drift.ts \
  --manifest deployments/testnet.json \
  --expected-hashes deployments/testnet.expected-hashes.json \
  --rpc https://soroban-testnet.stellar.org
```

After a contract upgrade, re-deploy, and update the hash file in the same
commit that updates `deployments/testnet.json`.  Review the diff to confirm the
upgrade is intentional before merging.

## Responding to drift

### Missing contract

The network was reset or the wrong deployment file was used.

1. Confirm the network: `stellar network status --network testnet`.
2. If the network was reset, re-run `scripts/deploy-testnet.sh` and commit the
   new `deployments/testnet.json`.
3. If the file is wrong, set `DEPLOYMENTS_FILE` to the correct path and re-run.

### Archived contract

The contract's storage TTL has lapsed.  Restore it before running agents:

```bash
stellar contract restore --id <CONTRACT_ID> --network testnet \
  --source-account <DEPLOYER_ACCOUNT>
```

Repeat for every archived contract shown in the report.

### WASM hash drift

A contract's on-chain code hash does not match the pinned expected hash.

1. Determine who deployed the upgrade.  Check the transaction history:
   `stellar transaction list --network testnet --account <DEPLOYER>`.
2. If the upgrade was intentional (a planned contract update), rebuild the
   WASM, verify the hash matches the new on-chain value, and update
   `deployments/testnet.expected-hashes.json` in a reviewed commit.
3. If the upgrade was not intentional, treat it as a security incident and
   do not run agents against that deployment until the situation is resolved.

### Probe error

The RPC endpoint is unreachable or rate-limiting.  Try again later or point the
checker at a different RPC node (`--rpc <URL>`).  Probe errors do not mean the
contracts are drifted — they mean the check could not be completed.

## Implementation notes

- **No automatic remediation.** The module returns a `DriftReport` and exits
  non-zero; it never calls `stellar contract restore`, sends transactions, or
  rewrites the manifest.  Remediation is always a manual operator step.
- **Address validation before network calls.** If any address in the manifest
  fails `StrKey.isValidContract`, all network probes are skipped and the bad
  addresses are reported.  This prevents misleading RPC error messages from
  masking the real problem.
- **Concurrent probes.** Each contract is probed concurrently.  One slow or
  failing RPC call does not block the others.
- **Deterministic tests.** `agents/core/deployment-drift.test.ts` injects a
  fake `ContractProbe` and a fixed clock.  It never touches the network, so it
  runs correctly in CI without testnet access.
- **WASM hash normalization.** Expected hashes are lowercased before comparison
  so uppercase input does not produce a false positive.
