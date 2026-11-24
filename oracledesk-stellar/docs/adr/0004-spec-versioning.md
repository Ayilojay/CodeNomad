# ADR 0004: Versioned, salted, domain-separated resolution commitments

## Status

Accepted. Extends [ADR 0001](0001-resolution-commitment.md).

## Context

ADR 0001 commits a market to `resolution_hash = sha256(XDR(ResolutionSpec))`
at `create_market` and checks it when the spec is revealed. Three weaknesses
appear as markets grow:

1. **Encoding drift.** The hash is a function of the exact XDR bytes of
   `ResolutionSpec`. Renaming a field, changing a type, or a soroban-sdk
   change to `to_xdr` silently changes every committed hash and strands every
   unrevealed market. Nothing pinned the encoding.
2. **Pre-reveal brute force.** Specs have very little entropy (known signer
   addresses, threshold 1, round windows, known Reflector contracts). Anyone
   can enumerate likely specs and match them against `resolution_hash` before
   the reveal, learning which committee will decide and opening it to bribery.
3. **No domain separation.** The hash binds neither the network nor the
   market-core instance. A commitment observed on one deployment is valid on
   another, and two markets with an identical rule share a hash.

## Decision

### Golden vectors freeze the legacy encoding

`contracts/resolver` (`mod golden`) and `scripts/spec-hash` (`golden_legacy_vectors`)
pin the same six legacy hashes: both `OracleAsset` variants, all four
`PriceDirection`s, and single and multi-signer lists. `#[contracttype]` structs
encode as an `ScMap` keyed by field **name**, sorted; declaration order is
irrelevant but renaming a field changes the hash (pinned by
`xdr_encoding_depends_on_field_names_not_declaration_order`). The vectors were
additionally re-derived from hand-built XDR with no Soroban code at all.

### `ResolutionSpecV2` envelope

```rust
pub struct ResolutionSpecV2 {
    pub version: u32,           // must be 2
    pub network_id: BytesN<32>, // sha256(network passphrase) == env.ledger().network_id()
    pub market_core: Address,   // must equal the resolver's configured market-core
    pub salt: BytesN<32>,       // 32 CSPRNG bytes, must be non-zero
    pub rule: ResolutionSpec,
}
// commitment = sha256("oracledesk:resolution-spec" || XDR(ResolutionSpecV2))
```

`register_spec_v2(market_id, spec)` checks, in order: `version == 2` and a
non-zero salt (`InvalidConfig`); `network_id` and `market_core`
(`DomainMismatch`); then runs the same pipeline as the legacy entrypoints
(unconfigured -> rule validation -> commitment equality -> store). The legacy
entrypoints keep their behaviour and error precedence exactly.

### Domain separation

A legacy preimage is the XDR of an `ScVal` enum value, which is an `ScVec` and
therefore begins with the 4-byte discriminant `00 00 00 10`. A V2 preimage
begins with the ASCII bytes `orac`. The two preimage sets are disjoint, so a
collision between a legacy and a V2 hash would be a SHA-256 collision.
`v2_and_legacy_hash_spaces_disjoint` checks both the prefixes and the hashes
over random specs.

### What is deliberately not bound

* **`market_id`.** The id is assigned by `create_market` *after* the creator
  has computed the hash, so it cannot be inside the preimage without a
  two-phase create. The salt makes two markets with the same rule hash
  differently, which is the property that mattered.
* **The resolver address.** Binding it would strand every committed market
  whenever the resolver is redeployed and market-core is repointed with
  `propose_resolver` + `accept_resolver` (this ADR predates the handshake;
  see ADR 0006). Only the resolver market-core points to can resolve a
  market, so replay across resolvers gains nothing.

### Salt custody

The salt is the only secret protecting the rule until reveal, and it is
required to reveal. Losing it makes the market unresolvable except by
`guardian_void_market`. `scripts/seed-market.sh` therefore generates it with
`spec-hash gen-salt`, writes it to `deployments/specs/<resolution_hash>.json`,
re-derives the commitment from the stored value with `spec-hash verify`, and
only then creates the market. Any failure aborts before a market exists. The
directory is gitignored because an unrevealed salt must not be published.

### Migration policy

#### Canonical encoding per version

Each supported spec version has exactly one canonical preimage. There is no
alternative encoding, no whitespace/ordering freedom, and no "equivalent"
serialization that is also accepted.

| Version | Entrypoint | Preimage | Hash |
| --- | --- | --- | --- |
| Legacy (unversioned) | `register_spec` | `XDR(ResolutionSpec)` as an `ScVal` (starts `00 00 00 10`) | `sha256(XDR(ResolutionSpec))` |
| `2` | `register_spec_v2` | `"oracledesk:resolution-spec" \|\| XDR(ResolutionSpecV2)` | `sha256(preimage)` |

`ResolutionSpecV2.version` is the version tag and is part of the preimage, so
the version is committed to and cannot be reinterpreted after the fact. The
legacy encoding carries no tag; its version is implied by the entrypoint that
consumed it.

#### Version selection

* The version is chosen by the **creator at commit time**, by picking the
  entrypoint: `register_spec` commits a legacy hash, `register_spec_v2` commits
  a V2 hash. The resolver never guesses a version from the bytes.
* A commitment is verified only against the entrypoint that produced it. A V2
  envelope submitted to `register_spec`, or a bare `ResolutionSpec` submitted
  to `register_spec_v2`, fails the commitment equality check (and, for the
  latter, the `version == 2` check first) — it is not silently reinterpreted.
* New tooling (`scripts/spec-hash`, `scripts/seed-market.sh`) emits V2 only.
  Legacy entrypoints remain for already-committed markets.

#### Allowed conversions

Only conversions that are **lossless and unambiguous** are allowed, and they
are performed off-chain by tooling, never on-chain:

* **Legacy spec -> V2 envelope** is allowed when the caller supplies the
  missing envelope fields (`network_id`, `market_core`, `salt`) explicitly.
  This is a *re-commitment*, not a reinterpretation: it produces a **new**
  commitment and requires a new market (or a fresh commit) — the old legacy
  commitment is unaffected and still verifies on its own.
* **V2 envelope -> legacy spec** is allowed only by dropping the envelope
  fields, and only as an explicit, caller-visible operation. It likewise
  produces a different commitment; it never causes a V2 commitment to verify
  as a legacy one.

#### Rejected conversions

The following are rejected, on-chain and in `scripts/spec-hash`:

* **Ambiguous version inference.** Deriving the version from the preimage
  bytes instead of the entrypoint. The two preimage sets are disjoint (see
  *Domain separation*), so a byte string is never valid under both versions.
* **Lossy downgrade.** Presenting a V2 commitment as a legacy one (dropping
  `version`, `network_id`, `market_core` or `salt`) to make it verify against
  a legacy hash. The hashes differ, so this fails commitment equality.
* **Lossy upgrade.** Wrapping a legacy commitment in a V2 envelope without a
  caller-supplied salt/domain, or reusing a zero salt, to "promote" it. This
  fails `InvalidConfig` (zero salt) or produces a different hash that does not
  match the original commitment.
* **Cross-version replay.** Submitting a commitment to an entrypoint of a
  different version, or replaying a V2 envelope on another network or against
  another market-core (`DomainMismatch`).

#### Compatibility guarantee

Commitments produced under older spec versions **still verify indefinitely**.
The legacy encoding is frozen by the golden vectors in `contracts/resolver`
(`mod golden`) and `scripts/spec-hash` (`golden_legacy_vectors`); the legacy
entrypoints keep their behaviour and error precedence exactly. Adding a new
version must never change the bytes hashed for an existing version.

#### Golden vectors proving the rules

`scripts/spec-hash` pins vectors that make the rules above executable:

* `golden_legacy_vectors` — the six legacy hashes, re-derived from hand-built
  XDR with no Soroban code, proving old commitments still verify.
* `v2_and_legacy_hash_spaces_disjoint` — checks the `00 00 00 10` vs `orac`
  prefixes and the hashes over random specs, proving version inference from
  bytes is ambiguous and therefore rejected.
* Cross-version vectors assert that a legacy spec re-committed as a V2
  envelope (and vice versa) yields a *different* hash, proving lossy
  conversions fail rather than silently verifying.

Any change to a field of `PriceConfig`, `SignerConfig`, `OracleAsset`,
`PriceDirection` or `ResolutionSpec` must add a **new variant or version**,
never edit an existing one, and must update the golden vectors in the same
pull request.

## Consequences

* A reveal is still public; V2 hides the rule only until then.
* The V2 hash is checked on-chain against `env.ledger().network_id()`, so the
  same envelope cannot be replayed on another network.
* Error code `21` (`DomainMismatch`) is new; codes `1`-`18` are unchanged.
* `spec-hash` computes both hashes by calling the resolver crate's own
  `legacy_spec_hash` / `spec_v2_hash`, so the tool cannot drift from the
  contract.
