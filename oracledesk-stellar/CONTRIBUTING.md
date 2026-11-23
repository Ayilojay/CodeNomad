# Contributing to OracleDesk (Stellar)

Thanks for considering contributing. This is a testnet-only, unaudited,
pre-alpha project — see `docs/STATUS.md` for exactly what works today.

## Dev setup

```bash
git clone <this repo>
cd oracledesk-stellar
make setup   # npm install in x402/, agents/, packages/bindings/*
make build   # cargo build + stellar contract build
make test    # cargo test + model/fpmm_model.py + x402 tests
```

You'll need Rust (stable, with the `wasm32v1-none` target —
`rust-toolchain.toml` handles this via `rustup`), the
[Stellar CLI](https://developers.stellar.org/docs/tools/cli) v27+, Node 22+,
Python 3.10+, and `jq`.

## Branch and commit conventions

- Branch names: `feat/...`, `fix/...`, `docs/...`, `chore/...`.
- Commits: [Conventional Commits](https://www.conventionalcommits.org/) —
  `feat:`, `fix:`, `test:`, `docs:`, `chore:`, `refactor:`. Keep them small
  and scoped to one logical change.
- No force-pushes to shared branches.

## Running the test suites

```bash
cargo test --workspace                          # all 4 contracts
cargo fmt --check && cargo clippy --workspace --all-targets -- -D warnings
python3 model/fpmm_model.py                      # FPMM math property tests
cd x402 && npm test                              # x402 trace API
make formal                                      # TLC model check (needs Java)
cd agents && npm test                            # FPMM (BigInt), trace, strategy, adapter
```

Contract changes need:

- A test for every new state transition.
- A non-mocked-auth test proving the wrong caller is rejected, for every
  privileged function (see `wrong_caller_cannot_*` tests across
  `contracts/*/src/lib.rs` for the pattern — `env.set_auths(&[])` plus
  `mock_auths` for a specific *other* address, not `mock_all_auths`, which
  would hide a missing `require_auth`).
- If the change touches `market-core` or `reasoning-registry`, refresh the
  vendored copies and their committed `.sha256` pins with
  `./scripts/sync-vendored-wasm.sh` (or just `make build`, which does it in
  the right order) before those crates will see the change. A stale copy is a
  **compile error** now: each dependent crate's `build.rs` verifies the
  vendored bytes against `<name>.wasm.sha256`, so you can no longer silently
  build against an old interface. `make verify-wasm` proves the build is
  reproducible and the pins match a clean build. See
  [docs/adr/0002-cross-contract-calls.md](docs/adr/0002-cross-contract-calls.md).

## Coverage

```bash
cargo install --locked cargo-llvm-cov --version 0.9.1 && rustup component add llvm-tools-preview
make setup && make coverage     # coverage/lcov.info + coverage/html/index.html
make coverage-gate              # enforce coverage/thresholds.json
```

CI uploads the same report as the `coverage` artifact and fails a PR when a
package falls below its minimum in `coverage/thresholds.json` or drops more than
0.5 points against `develop`. If you add tests that raise a package well above
its minimum, raise the minimum in the same PR. See [coverage/README.md](coverage/README.md)
for what is measured, why market-core is registered both as wasm and natively in
the resolver and treasury tests (`MARKET_CORE_IMPL`, `both_modes!`), and how to
read the numbers. Node 20.19+ or 22.12+ is required (c8).

## Formal checks and exhaustive tests

`make formal` model-checks the resolution lifecycle ([docs/formal/](docs/formal/README.md)),
`python3 model/fpmm_bounds.py --quick` checks the FPMM economics claims
([docs/fpmm-economics.md](docs/fpmm-economics.md)), and
`cargo test -p integration-tests treasury_caps_exhaustive` searches the treasury's
spending caps ([architecture.md](docs/architecture.md#treasury-cap-guarantees);
about 2 minutes on 8 cores, `TREASURY_SEARCH_DEPTH=5` for a quick run).

## Code style

- Rust: `cargo fmt` (rustfmt defaults) and a clean `clippy -D warnings`.
- TypeScript: no linter is configured yet (see `docs/wave-issues/`) —
  follow the style already in the file you're editing.
- Doc comments explain *why*, not *what* — see the existing contract source
  for the level of comment density we're going for (sparse, but present at
every non-obvious invariant).

## Pull request checklist

- [ ] `cargo fmt --check` and `cargo clippy --workspace --all-targets -- -D
      warnings` both pass.
- [ ] `cargo test --workspace` passes.
- [ ] If you touched contract interfaces, bindings were regenerated
      (`make bindings`) and the diff is included.
- [ ] If you touched `market-core` or `reasoning-registry`, the vendored wasm
      copies and their `.sha256` pins were refreshed (`make build` /
      `./scripts/sync-vendored-wasm.sh`), and `make verify-wasm` passes.
- [ ] New behavior has a test; changed behavior's existing test was updated,
      not deleted.
- [ ] `docs/STATUS.md` updated if this changes what's verified/unverified.

## Admin rotation runbook (multisig / smart-account operators)

Admin transfer is a **two-step** flow: the current admin proposes a new admin
(`propose_admin`), and the proposed address must accept (`accept_admin`).
Until acceptance the current admin remains in control; a proposal can be
cancelled (`cancel_admin_transfer`) or expires. This runbook is the
least-privilege procedure for rotating admin on each contract and the
timelock. It applies to plain accounts, multisig (`G...` with multiple
signers) and smart-account (`C...`) addresses alike — the contract only ever
sees an `Address`, so the same commands work for all three.

### 0. Preconditions

- [ ] You have the **current** admin's signing authority (or enough signers to
      meet its threshold) and the **new** admin's signing authority.
- [ ] The new admin is a multisig/smart-account whose signer set and threshold
      you have verified (step 1). Never rotate to a single-key address for a
      production contract.
- [ ] You have recorded the current admin, the pending admin (if any) and the
      contract IDs you intend to touch.

### 1. Verify signers before proposing

For a multisig account, confirm the signer set and thresholds on-chain:

```bash
stellar account show --account <NEW_ADMIN_G_OR_C> --network testnet
# Inspect `signers`, `thresholds.low/med/high` and `master_weight`.
# A master_weight of 0 means the master key alone cannot sign — good.
```

For a smart account (`C...`), confirm the deployed wasm hash and its
configured signers match what you expect:

```bash
stellar contract info --id <NEW_ADMIN_C> --network testnet
stellar contract invoke --id <NEW_ADMIN_C> --network testnet -- \
  --help   # confirm the account exposes the expected auth entry points
```

Record the signer set and thresholds in the rotation ticket. If they do not
match the intended policy, **stop** — do not propose.

### 2. Inspect current state (pending-transfer monitoring)

Before proposing, check whether a transfer is already pending. A stale
pending admin is the most common cause of a "rotation that didn't take".

```bash
# Repeat for each contract and the timelock.
for ID in <MARKET_CORE_ID> <REASONING_REGISTRY_ID> <TREASURY_ID> <TIMELOCK_ID>; do
  echo "== $ID =="
  stellar contract invoke --id "$ID" --network testnet -- get_admin
  stellar contract invoke --id "$ID" --network testnet -- get_pending_admin
  stellar contract invoke --id "$ID" --network testnet -- get_admin_transfer_expiry
done
```

- `get_pending_admin` returning `None`/`null` means no transfer is in flight.
- A non-null pending admin that you did not propose is an **incident**: treat
  it as unauthorized, cancel it (step 5) and investigate before proceeding.
- Monitor this during the whole rotation window; a pending transfer that
  expires silently leaves the old admin in place.

### 3. Propose the new admin

From the **current** admin, propose the new admin on each contract and the
timelock. Do them one at a time and confirm each before moving on.

```bash
stellar contract invoke --id <CONTRACT_ID> --network testnet \
  --source <CURRENT_ADMIN> -- propose_admin --new_admin <NEW_ADMIN>

# Confirm the proposal landed and note the expiry.
stellar contract invoke --id <CONTRACT_ID> --network testnet -- get_pending_admin
stellar contract invoke --id <CONTRACT_ID> --network testnet -- get_admin_transfer_expiry
```

### 4. Accept from the new admin

The new admin must accept **before the expiry**. For a multisig, collect the
required signatures and submit a single transaction; for a smart account, use
its own auth entry point.

```bash
stellar contract invoke --id <CONTRACT_ID> --network testnet \
  --source <NEW_ADMIN> -- accept_admin

# Verify the rotation took effect.
stellar contract invoke --id <CONTRACT_ID> --network testnet -- get_admin
stellar contract invoke --id <CONTRACT_ID> --network testnet -- get_pending_admin  # expect None
```

Repeat steps 3–4 for every contract and the timelock. Do **not** leave a
contract half-rotated: either all are rotated or none are.

### 5. Expiry and recovery

- If the proposal **expires** before acceptance, the pending admin is cleared
  and the current admin is unchanged. Re-run step 3 to re-propose.
- If the new admin **cannot accept** (lost keys, wrong signer set), cancel the
  pending transfer from the current admin and re-propose to a corrected
  address:

```bash
stellar contract invoke --id <CONTRACT_ID> --network testnet \
  --source <CURRENT_ADMIN> -- cancel_admin_transfer
stellar contract invoke --id <CONTRACT_ID> --network testnet -- get_pending_admin  # expect None
```

- If the **current admin is compromised**, do not rely on the two-step flow
  alone: escalate per the incident process, and use the timelock to stage any
  emergency change so it is observable before it takes effect.

### 6. Validate against localnet

Smoke-test the full lifecycle locally before touching testnet. This is the
reproducible verification for this runbook:

```bash
# Start a local network and deploy the contracts (see Makefile targets).
make localnet-up

# Propose -> accept -> verify, then propose -> cancel -> verify.
# Run the same invoke commands from steps 2-5 against the localnet IDs.
make localnet-smoke   # exercises propose/accept/cancel/expiry paths
```

A rotation is only considered complete when, for every contract and the
timelock, `get_admin` returns the new admin and `get_pending_admin` returns
`None`.

## Release review checklist (independent review gate)

This project is unaudited and a release spans several contracts plus generated
artifacts. Before tagging a release, an **independent reviewer** (someone other
than the release author) must complete the checklist below and attach the
referenced evidence to the release PR. **Any unchecked item blocks tagging** —
the gate is fail-closed: missing evidence is treated as a failed check, not a
waiver. Record the outcome in the release PR description using the template at
the end of this section.

### 1. Auth matrix

- [ ] Every privileged entry point across all contracts is listed with its
      required caller/role, and each has a passing `wrong_caller_cannot_*`
      test (non-mocked auth).
- [ ] Evidence: link to the auth matrix (or the `wrong_caller_cannot_*` test
      list from `cargo test --workspace -- --list`) in the release PR.

### 2. Budget deltas

- [ ] CPU/memory budget deltas versus the previous release are within the
      limits enforced by `make test` / CI; any increase is explained.
- [ ] Evidence: CI artifact or `cargo test` output showing budget assertions
      passing.

### 3. Interface manifests

- [ ] `make interface-check` passes and every changed `interface.json` has a
      corresponding semantic version bump and `CHANGELOG.md` entry (see
      [Changing a contract interface](#changing-a-contract-interface)).
- [ ] Evidence: `interface-check` output and the `interface.json` diff.

### 4. Vendored WASM

- [ ] `make verify-wasm` passes: vendored copies of `market-core` and
      `reasoning-registry` match a clean build and their `.sha256` pins are
      current.
- [ ] Evidence: `make verify-wasm` output.

### 5. Formal checks

- [ ] `make formal` (TLC model check) and `python3 model/fpmm_bounds.py --quick`
      pass, plus `cargo test -p integration-tests treasury_caps_exhaustive`.
- [ ] Evidence: CI artifact or logs for each of the three checks.

### 6. Migration compatibility

- [ ] Any storage-layout or interface change ships with a migration path, and
      the migration is reviewed for compatibility with existing deployed
      instances (including hash-critical `ResolutionSpec`/`ResolutionSpecV2`
      types — see ADR 0001).
- [ ] Evidence: migration notes in the release PR, or an explicit "no
      migration required" statement with justification.

### 7. Testnet verification

- [ ] The release candidate is deployed to testnet and the smoke tests pass
      against the deployed contracts.
- [ ] Evidence: testnet contract IDs and smoke-test output in the release PR.

### Release PR template

```markdown
## Release review — <version>
Reviewer: <independent reviewer>

| Check | Status | Evidence |
| --- | --- | --- |
| Auth matrix | PASS/FAIL | <link> |
| Budget deltas | PASS/FAIL | <link> |
| Interface manifests | PASS/FAIL | <link> |
| Vendored WASM | PASS/FAIL | <link> |
| Formal checks | PASS/FAIL | <link> |
| Migration compatibility | PASS/FAIL | <link> |
| Testnet verification | PASS/FAIL | <link> |

Tagging is blocked unless every row is PASS with evidence attached.
```
