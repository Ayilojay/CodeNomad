# Bindings Release Pipeline

This document describes how generated bindings and WASM artifacts are produced,
verified, and released for the OracleDesk Stellar contracts.

## Supported toolchains

The pipeline is validated against a matrix of toolchain versions. The
**minimum** column is the oldest version we support; the **pinned** column is
the version used for release artifacts and determinism checks.

| Tool          | Minimum supported | Pinned CI / release |
| ------------- | ----------------- | ------------------- |
| Rust          | 1.74.0            | 1.79.0              |
| Node.js       | 18.18.0           | 20.11.0             |
| Stellar CLI   | 21.0.0            | 21.1.0              |

Any combination outside these ranges is **unsupported**. The CI matrix job
(`bindings-toolchain-matrix`) runs the focused build/test suite for each
supported combination and fails loudly on unsupported combinations — there is
no silent fallback to a different toolchain.

## CI matrix

The `bindings-toolchain-matrix` workflow job runs the following combinations:

- **minimum**: Rust 1.74.0, Node 18.18.0, Stellar CLI 21.0.0
- **pinned**: Rust 1.79.0, Node 20.11.0, Stellar CLI 21.1.0

Each matrix entry runs the focused package build and tests. A failing entry
blocks the pipeline; the job does not downgrade or substitute toolchains.

## Determinism verification

On the **pinned** toolchain the pipeline rebuilds the generated bindings and
WASM artifacts and diffs them against the committed artifacts. Any drift fails
the job. This guarantees that generated bindings and WASM remain deterministic
on the supported release toolchain.

To reproduce locally on the pinned toolchain:

```sh
# Rebuild bindings and WASM, then diff against committed artifacts
make bindings
make wasm
git diff --exit-code -- bindings/ wasm/
```

## Manual release / operator verification

Before publishing a release, an operator must:

1. Confirm the pinned toolchain versions above match the versions used to
   produce the release artifacts.
2. Run the determinism check locally (see above) and confirm a clean diff.
3. Verify the CI `bindings-toolchain-matrix` job passed for both the minimum
   and pinned combinations.
4. For deployment-specific behavior, verify against localnet or deterministic
   fixtures before any testnet use.

Do not publish artifacts produced by an unsupported toolchain combination.
