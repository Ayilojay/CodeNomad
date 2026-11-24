# Batch redemption and trading-sequence verification

Covers #6 (batch redemption state transitions) and #1 (full-contract
sequence properties). Reproducible with `cargo test -p market-core`.

## Batch redemption (`redeem_many`, `claim_pool_remainders`)

Per-item outcome, evaluated in input order:

| Item state                          | Result                     |
|-------------------------------------|----------------------------|
| Market missing / archived           | `Skipped(NotFound)`        |
| Market open (not resolved/voided)   | `Skipped(NotFinal)`        |
| Market closed by `finalize_market`  | `Skipped(NothingToRedeem)` / `AlreadyClaimed` |
| Position empty (incl. repeat claim) | `Skipped(NothingToRedeem)` |
| Otherwise                           | `Settled(payout)`          |

Properties to hold:
1. A skipped item causes no state write and no TTL bump.
2. Skipped items never change payouts of other items in the same batch.
3. `BatchResult.total == sum(items[i].payout)` and equals the single token
   transfer; no transfer when `total == 0`.
4. Re-running the same batch yields all `NothingToRedeem` and `total == 0`.
5. Batches over `max_batch()` or with duplicate ids are rejected up front.

## Trading sequences

Generate seeded sequences of `create_market`, `buy`, `sell`, `resolve`,
`void_market`, `redeem`. After every successful step assert:
- Solvency: contract collateral >= outstanding redemptions + LP fees +
  protocol fees.
- Positions are non-negative and `sum(positions) == outstanding` in
  `SettleState`.
- Failed steps leave state unchanged.

Minimized failing seeds are kept as fixed regression cases in the
`market-core` test module.
