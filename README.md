# CodeNomad

## Reproducible builds

CodeNomad pins its toolchains and dependency lockfiles so that clean installs and builds are reproducible across machines and CI.

### Pinned tool versions

- **Rust**: the toolchain is pinned via `rust-toolchain.toml` at the repository root. Use the pinned channel; do not override it locally when validating a release.
- **Node**: the supported Node version is declared in `.nvmrc` and in the `engines` field of `package.json`. Use the declared version (e.g. via `nvm use`) before installing.
- **Python**: the interpreter version is pinned in `.python-version`.

### Lockfiles

- `Cargo.lock` is committed and must be used for all builds (`cargo build --locked`).
- `package-lock.json` is committed and must be used for all installs (`npm ci`).

Do not regenerate lockfiles or bump tool versions as part of an unrelated change. If a dependency update is required, update the manifest and the corresponding lockfile together in a dedicated change.

### CI verification

CI verifies reproducibility by:

- installing with `npm ci` and building with `cargo build --locked`, which fail loudly if a lockfile is out of sync with its manifest;
- checking that the working tree is clean after install/build, so no manifest or lockfile is mutated unexpectedly;
- asserting the active tool versions match the pinned versions, failing the job on mismatch.

These checks fail loudly rather than falling back to unpinned versions or silently regenerating lockfiles.

## Security checks

CI runs repository-appropriate security checks on every push and pull request. All checks fail the job on findings; none fall back to a warning-only mode.

### Dependency scanning

- **Node**: `npm audit --audit-level=high` runs against the committed `package-lock.json`.
- **Rust**: `cargo audit` runs against the committed `Cargo.lock`.

### Secret scanning

- `gitleaks` scans the full repository history for committed credentials.

### Artifact checks

- Build artifacts are produced from the pinned toolchains and lockfiles, and the working tree is asserted clean after the build so no artifact is generated from mutated inputs.

### Suppressions

Any suppression (audit advisory ignore, gitleaks allowlist entry) must be recorded with a rationale:

- **Dependency advisories**: add the advisory ID and a short justification to the audit ignore configuration; remove the entry once the dependency is upgraded.
- **Secret scanning**: add the path or fingerprint to the gitleaks allowlist only for non-usable test fixtures, with a comment explaining why the value is not a real credential.

Test fixtures must never contain usable credentials. If a fixture needs a credential-shaped value, use an obviously fake placeholder and allowlist it with a rationale.

### Manual release / operator verification

Before a release, on a clean checkout:

1. Confirm the active tool versions match the pinned files (`rustc --version`, `node --version`, `python --version`).
2. Run `npm ci` and `cargo build --locked` and confirm both succeed without modifying tracked files (`git status --porcelain` is empty).
3. Run the dependency and secret scans locally (`npm audit --audit-level=high`, `cargo audit`, `gitleaks detect`) and confirm they pass or that every finding is a documented suppression.
4. For deployment-specific behavior, verify against localnet or deterministic fixtures before testnet use.
