# OracleDesk Stellar

OracleDesk Stellar is the on-chain oracle and settlement layer for CodeNomad. It exposes
verified price feeds and settlement state to downstream consumers and is built as a Rust
workspace with a Soroban contract crate.

## Repository layout

- `contracts/` — Soroban smart contracts (oracle feed, settlement).
- `crates/` — shared Rust libraries used by the contracts and tooling.
- `.github/workflows/ci.yml` — continuous integration pipeline.

## Building and testing

```sh
cargo build --workspace
cargo test --workspace
```

CI runs the same build and test commands against a pinned toolchain so that local and
CI results match.

## CI security checks

The CI pipeline (`.github/workflows/ci.yml`) runs the following security gates on every
push and pull request:

- **Dependency scanning** — `cargo audit` checks the resolved dependency graph against
the RustSec advisory database. The job fails on any vulnerability that is not explicitly
suppressed (see below).
- **Secret scanning** — `gitleaks` scans the full git history for committed credentials,
API keys, and tokens. Findings fail the job.
- **Artifact checks** — the build job verifies that `Cargo.lock` is committed and up to
date (`cargo build --locked`) and uploads the resulting build artifacts for inspection.

### Suppressions

Any advisory or secret-scanning suppression must be recorded with a rationale so that
reviewers can audit it:

- Dependency advisories are suppressed in `deny.toml` / `audit.toml` (or via
  `cargo audit --ignore <ID>`) with a comment explaining why the advisory does not apply
  and when the suppression should be revisited.
- Secret-scanning false positives are suppressed in `.gitleaks.toml` with a comment
  describing the fixture and confirming it contains no usable credentials.

Test fixtures must never contain usable credentials. Placeholder values in fixtures are
clearly marked as non-functional samples and are covered by the gitleaks allowlist only
when they cannot be mistaken for live secrets.

### Manual verification

Before a release, an operator should:

1. Confirm the latest CI run on the release commit is green, including the dependency,
   secret, and artifact jobs.
2. Review any new suppressions added since the previous release.
3. Verify the uploaded build artifacts match the commit being released.

For deployment-specific behavior, validate against localnet or deterministic fixtures
before promoting to testnet.
