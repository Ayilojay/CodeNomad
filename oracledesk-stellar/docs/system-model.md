# Stateful system model

`model/system_model.py` is a dependency-free Python model of the OracleDesk
system at the resolution of one market. `contracts/integration-tests/tests/system_model.rs`
runs random operation sequences against the real wasm contracts, records what
happened, replays the same trace through the model, and fails if the two
disagree.

The model deliberately imports `model/fpmm_model.py` for the pricing math
instead of keeping a second copy: the Python FPMM mirror is already pinned to
`contracts/market-core/src/math.rs` by worked examples and property tests.

## Running it

```bash
make model-test
# equivalent:
python3 model/system_model.py --selftest
cargo test -p integration-tests --test system_model
```

The Rust test suite does three things:

1. `committed_regressions_match` replays every `model/regressions/*.json`
   trace against wasm and Python. Traces also carry the exact snapshots the
   contracts produced, so a later contract change shows up as a diff.
2. `random_sequences_match_python_model` generates operation sequences with
   proptest. On a mismatch proptest shrinks the sequence and prints the
   minimal failing trace.
3. `model_selftest_runs` runs the Python conservation/ordering checks.

## Trace schema

Schema version: **1** (`model/trace-schema.json`). The top level is:

```json
{
  "schema_version": 1,
  "steps": [ { "op": "create", "time": 1000, "close_time": 2000, "yes_bps": 5000 } ],
  "snapshots": [ /* optional committed expectations */ ]
}
```

Operations:

| `op` | Fields | Effect |
| --- | --- | --- |
| `create` | `time`, `close_time`, `yes_bps` | Seeds the tracked market from the creator and registers a signer spec. |
| `buy` | `time`, `actor` (`creator`/`trader`), `outcome` (`yes`/`no`), `amount` | `market-core.buy`, including fee accrual and token movement. |
| `sell` | `time`, `actor`, `outcome`, `collateral_out` | `market-core.sell` for an exact collateral amount. |
| `treasury_buy` | `time`, `outcome`, `amount` | `treasury.agent_buy`: vault balance → market position, with the treasury's price/impact/cap checks. |
| `resolve` | `time`, `outcome` | Two signer attestations, then `resolver.finalize_signers` → `market-core.resolve`. |
| `redeem` | `time`, `actor` | Final-market position redemption. |
| `claim_remainder` | `time` | Creator claims the pool remainder (and pending LP fees). |
| `sweep_fees` | `time` | Anyone sweeps accrued protocol fees to the treasury. |
| `publish_trace` | `time` | Agent publishes a reasoning-registry trace. |
| `advance_time` | `time` | Moves the ledger clock; no contract call. |

The model snapshot is the comparison unit:

```json
{
  "market": {"reserve_yes": 0, "reserve_no": 0, "sets_minted": 0,
              "fees_accrued": 0, "lp_claimed": false, "status": "open"},
  "positions": {"creator": {"yes": 0, "no": 0}, "trader": {...}, "treasury": {...}},
  "balances": {"creator": 0, "trader": 0, "treasury": 0, "core": 0},
  "resolver_state": "SignersPending",
  "trace_count": 0,
  "market_trace_count": 0
}
```

All amounts are integer stroops (USDC has 7 decimals). `status` is one of
`open`, `resolved_yes`, `resolved_no`, `void`. Resolver states are the
contract enum names (`Unconfigured`, `SignersPending`, `Finalized`, ...).

## What the model covers, and what it does not

Covered exactly: market-core FPMM buys/sells, fee split (the integration world
routes 100% of fees to the protocol), settlement, treasury agent-buy balance
and position movement, treasury price-band/impact/market-cap checks, resolver
signer quorum → finalize → resolve, and registry trace counters.

Resolution *lifecycle* coverage is provided separately by the replay fixtures
in `model/resolution_fixtures/*.json` (see below): price, signer, hybrid,
invalid and void flows, plus the guardian/fallback path. These fixtures are
sanitized, deterministic event sequences captured from real contract events;
they are replayed through the model and through a decoder that must reconstruct
the same final state.

Out of scope on purpose: multi-market interactions, disputes/committees beyond
the guardian/fallback fixture, withdrawals/yield, storage TTL, and error
*codes*. The model predicts success/failure, not the numeric error; the auth
matrix pins the error paths that matter for authorization, and unit tests pin
the rest.

## Resolution lifecycle replay fixtures

Each fixture in `model/resolution_fixtures/` is a JSON document with:

```json
{
  "schema_version": 1,
  "name": "signer_quorum",
  "mode": "signer",
  "events": [ { "kind": "signer_attestation", "time": 1000, "signer": "s1", "outcome": "yes" }, ... ],
  "expected_final_state": { "resolver_state": "Finalized", "market_status": "resolved_yes" }
}
```

Events are ordered by `time` (ties broken by their position in the file) and
carry only sanitized identifiers (`s1`, `s2`, ...), never real keys or
addresses. Amounts and times are integers, so replay is byte-for-byte
deterministic.

| Fixture | Mode | Event sequence | Expected final state |
| --- | --- | --- | --- |
| `price_feed.json` | price | `price_updated` (feed within band) → `resolution_proposed` → `finalize_price` | `Finalized`, `resolved_yes` |
| `signer_quorum.json` | signer | `signer_attestation` × quorum (agreeing) → `finalize_signers` | `Finalized`, `resolved_yes` |
| `hybrid_feed.json` | hybrid | `price_updated` → `signer_attestation` × quorum → `finalize_hybrid` | `Finalized`, `resolved_no` |
| `invalid_outcome.json` | signer | `signer_attestation` × quorum for `invalid` → `finalize_signers` | `Finalized`, `void` |
| `void_flow.json` | price | `resolution_proposed` → `void_market` | `Voided`, `void` |
| `guardian_fallback.json` | signer | quorum missed → `guardian_override` → `finalize_signers` | `Finalized`, `resolved_yes` |

The decoder (`decode_resolution_events` in `tests/system_model.rs`) folds the
event list into a final state and enforces two invariants:

- **Missing events**: a finalize/void event without the prerequisite
  attestations, price update, or guardian override is rejected with a
  `MissingEvent` error naming the absent kind.
- **Out-of-order events**: an event whose `time` precedes the previous event's
  `time`, or a finalize that arrives before its prerequisites, is rejected with
  an `OutOfOrder` error.

The test `resolution_fixtures_replay` asserts that the decoder's final state
equals `expected_final_state` and that the model, replayed over the same
events, agrees. Negative cases (a fixture with a dropped prerequisite and one
with swapped timestamps) assert the decoder flags them.

### Compatibility guarantees

- The trace schema version stays **1**; resolution fixtures are a separate,
  additive document type and do not change `model/trace-schema.json`.
- Existing `model/regressions/*.json` traces still replay unchanged; the
  fixture replay is a new test, not a modification of existing ones.
- No deployed contract interface changes: fixtures are derived from the
  existing event set and the decoder is test-only.

### Adding a resolution fixture

1. capture the sanitized event sequence from a real run (replace keys/addresses
   with `s1`, `s2`, ...; keep integer times and amounts);
2. add `model/resolution_fixtures/<name>.json` with `schema_version: 1`, the
   `mode`, the ordered `events`, and the `expected_final_state` the contracts
   produced;
3. if the flow introduces a new event `kind`, extend the decoder in
   `tests/system_model.rs` and add a negative case for its missing/out-of-order
   handling;
4. run `cargo test -p integration-tests --test system_model`.

## Adding an operation

1. add a variant to `Op` in `tests/system_model.rs` and a generator arm;
2. add a `_op_<name>` method to `SystemModel` and include its effects in
   `snapshot()`;
3. run `make model-test`; if proptest finds a mismatch, shrink it and copy the
   minimal trace into `model/regressions/` with the snapshots the contracts
   produced;
4. update `model/trace-schema.json` if the wire shape changed.
