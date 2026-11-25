.PHONY: setup build test lint fmt deploy-testnet deploy-timelock seed-market demo bindings clean interface-check budget budget-update

# Installs Node dependencies for the TypeScript packages. Rust toolchain,
# the `stellar` CLI, and Python 3 are expected to already be on PATH — see
# README.md's Prerequisites section.
# Bindings must be installed *and built* (dist/index.d.ts etc.) before
# agents/ and x402/ install, since both depend on them by local file: path
# and need real type declarations, not just a package.json, to typecheck.
setup:
	for pkg in market-core resolver treasury reasoning-registry timelock router; do \
		(cd packages/bindings/$$pkg && npm install && npm run build) || exit 1; \
	done
	cd agents && npm install
	cd x402 && npm install

# Builds all four Soroban contracts to wasm via the Stellar CLI. The vendored
# cross-contract copies (resolver/treasury's market_core.wasm, resolver's
# reasoning_registry.wasm) are refreshed by scripts/sync-vendored-wasm.sh and
# then re-verified by each crate's build.rs against the committed `.sha256`
# pin (see docs/adr/0002-cross-contract-calls.md — a stale copy is a compile
# error, not a silent old interface).
build:
	cargo build --workspace
	stellar contract build
	./scripts/sync-vendored-wasm.sh
	stellar contract build
	cp target/wasm32v1-none/release/market_core.wasm contracts/integration-tests/wasm/
	cp target/wasm32v1-none/release/resolver.wasm contracts/integration-tests/wasm/
	cp target/wasm32v1-none/release/treasury.wasm contracts/integration-tests/wasm/
	cp target/wasm32v1-none/release/reasoning_registry.wasm contracts/integration-tests/wasm/

# Proves the contract build is bit-for-bit reproducible and that the vendored
# wasm matches a clean build (issue #58). Slow: it compiles the workspace
# twice into separate target directories.
verify-wasm:
	./scripts/check-wasm-determinism.sh

# Same check, but only against the current target dir (no clean rebuild).
check-wasm:
	./scripts/sync-vendored-wasm.sh
	git diff --exit-code -- \
		contracts/resolver/market_core.wasm contracts/treasury/market_core.wasm \
		contracts/resolver/reasoning_registry.wasm \
		contracts/resolver/market_core.wasm.sha256 \
		contracts/treasury/market_core.wasm.sha256 \
		contracts/resolver/reasoning_registry.wasm.sha256

test: build
	cargo test --workspace
	CARGO_TARGET_DIR=target cargo test --locked --manifest-path scripts/interface-manifest/Cargo.toml
	CARGO_TARGET_DIR=target cargo test --manifest-path scripts/spec-hash/Cargo.toml
	python3 model/fpmm_model.py
	python3 model/fpmm_bounds.py --quick
	python3 scripts/coverage-tools.py --self-test
	python3 scripts/coverage-gate.py --self-test
	cd x402 && npm test
	cd agents && npm test

lint:
	./scripts/check-no-mock-all-auths.sh
	cargo fmt --check
	cargo fmt --manifest-path scripts/interface-manifest/Cargo.toml --check
	cargo clippy --workspace --all-targets -- -D warnings
	CARGO_TARGET_DIR=target cargo clippy --locked --manifest-path scripts/interface-manifest/Cargo.toml --all-targets -- -D warnings

auth-matrix: build
	cargo test -p integration-tests --test auth_matrix
	./scripts/check-no-mock-all-auths.sh

kani:
	cargo kani -p market-core

model-test:
	python3 model/system_model.py --selftest
	cargo test -p integration-tests --test system_model

# Worst-case resource benchmarks for every public entrypoint (issue #9).
# `make budget` builds the contracts, then runs the budget-tests crate
# single-threaded (the Soroban budget meter is process-global, so parallel
# tests would cross-contaminate readings) and fails if any measured CPU,
# memory, or read/write count regresses beyond the documented threshold
# against the committed baseline in contracts/budget-tests/baseline.json.
#
# Baseline refresh procedure:
#   * When: only after an intentional, reviewed change to a contract's
#     resource profile (new entrypoint, changed storage layout, added
#     cross-contract call). Never refresh to silence an unexplained
#     regression — investigate it first.
#   * Who: the PR author runs `make budget-update` and commits the resulting
#     baseline.json; a reviewer must confirm the diff matches the intended
#     change and that no unrelated entrypoint moved.
#   * Threshold changes: the per-entrypoint tolerance lives in the baseline
#     file and is reviewed like code. Raising it requires justification in
#     the PR description (e.g. a deliberate feature that costs more CPU).
budget: build
	cargo test --manifest-path contracts/budget-tests/Cargo.toml -- --test-threads=1

budget-update: build
	BUDGET_UPDATE=1 cargo test --manifest-path contracts/budget-tests/Cargo.toml -- --test-threads=1

# End-to-end validation of the live agent adapter against a hermetic localnet
# (issue #66): build → sign → submit → confirm → reconcile one bounded
# transaction with an ephemeral key, plus assertions that the safe dry-run
# default cannot reach signer or submit endpoints. Requires `make setup` and
# `make build` first; see agents/README.md for the documented flow.
e2e-local: build
	cd agents && npm run test:e2e-local

fmt:
	cargo fmt
	cargo fmt --manifest-path scripts/interface-manifest/Cargo.toml

# Coverage: Rust (cargo llvm-cov, market-core wasm + native) and TypeScript (c8),
# merged into coverage/lcov.info with an HTML report. `make coverage-gate` then
# enforces coverage/thresholds.json. Needs `make setup` first; see coverage/README.md.
coverage:
	./scripts/coverage.sh

coverage-gate:
	python3 scripts/coverage-gate.py $(if $(BASE),--base $(BASE),)

# TLC model check of the resolution lifecycle (docs/formal/). Skips with exit 0
# when Java is not installed.
formal:
	./scripts/formal.sh

# Default deploy: the deployer EOA is admin (unchanged behavior).
deploy-testnet: build
	./scripts/deploy-testnet.sh

# Timelock-admin deployment mode (issue #46). Opt-in: the deployer EOA is NOT
# left as admin. The script deploys, proposes the timelock as admin on each
# contract, verifies the accepted admin, and writes a machine-readable
# manifest of proposals/handovers. Re-runs are idempotent and resumable via
# the manifest at $(TIMELOCK_MANIFEST) (default: deploy/timelock-manifest.json).
#
#   make deploy-timelock TIMELOCK_ADMIN=<G...>
#
# See contracts/treasury/README.md for the operator-visible flow.
TIMELOCK_ADMIN ?=
TIMELOCK_MANIFEST ?= deploy/timelock-manifest.json
deploy-timelock: build
	@if [ -z "$(TIMELOCK_ADMIN)" ]; then \
		echo "error: TIMELOCK_ADMIN is required (e.g. make deploy-timelock TIMELOCK_ADMIN=G...)" >&2; \
		exit 1; \
	fi
	DEPLOY_MODE=timelock \
	TIMELOCK_ADMIN="$(TIMELOCK_ADMIN)" \
	TIMELOCK_MANIFEST="$(TIMELOCK_MANIFEST)" \
	./scripts/deploy-testnet.sh

# Multisig admin-rotation runbook smoke test (issue #47). Exercises the
# two-step transfer lifecycle (propose → accept → expiry → cancel) against a
# hermetic localnet for each contract and the timelock, and verifies signer
# identity for multisig/smart-account addresses. Requires `make build` first;
# see contracts/treasury/README.md for the operator runbook this validates.
ADMIN_ROTATION_CONTRACT ?=
admin-rotation-smoke: build
	./scripts/admin-rotation-smoke.sh $(if $(ADMIN_ROTATION_CONTRACT),--contract $(ADMIN_ROTATION_CONTRACT),)

seed-market:
	./scripts/seed-market.sh

demo:
	./scripts/demo.sh

bindings: build
	./scripts/gen-bindings.sh

clean:
	cargo clean
	rm -rf x402/node_modules agents/node_modules
	rm -rf packages/bindings/*/node_modules packages/bindings/*/dist

# Compare to the PR target, not the contributor fork's tracking branch.
INTERFACE_BASE_REF ?= upstream/develop
interface-check:
	@for pkg in market-core resolver treasury reasoning-registry timelock router; do \
		CARGO_TARGET_DIR=target cargo run --quiet --locked --manifest-path scripts/interface-manifest/Cargo.toml -- \
		check --pkg-dir packages/bindings/$$pkg --base-ref "$(INTERFACE_BASE_REF)" || exit 1; \
	done
