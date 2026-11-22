## What this does

<!-- One or two sentences. Link the issue this closes, if any. -->

## Checklist

- [ ] `cargo fmt --check` and `cargo clippy --workspace --all-targets -- -D warnings` pass
- [ ] `cargo test --workspace` passes
- [ ] If contract interfaces changed: bindings regenerated (`make bindings`) and included in this PR
- [ ] If `market-core`'s interface changed: `resolver`/`treasury`'s vendored `market_core.wasm` refreshed
- [ ] New behavior has a test; changed behavior's test was updated, not deleted
- [ ] `docs/STATUS.md` updated if this changes what's verified/unverified

## Release gate (contract releases only)

<!-- Required when this PR is part of a tagged contract release. See docs/RELEASE_CHECKLIST.md. -->

- [ ] Auth matrix reviewed: every entry point's caller/authorization is documented and matches the code
- [ ] Budget deltas reviewed: CPU/memory/ledger-entry deltas vs. the previous release are recorded and within budget
- [ ] Interface manifests reviewed: generated bindings/manifests match the deployed contract interfaces
- [ ] Vendored WASM reviewed: `resolver`/`treasury` vendored `market_core.wasm` matches the released `market-core` build
- [ ] Formal checks reviewed: any formal/spec checks are run and their results attached
- [ ] Migration compatibility reviewed: storage layout changes have a migration and are backward compatible
- [ ] Testnet verification reviewed: the release was exercised on testnet and evidence is attached

> Missing evidence for any item above **blocks release tagging**. Do not tag until every box is checked and its evidence is linked.

## How this was tested

<!-- Command output, or "ran make demo end to end", etc. -->
