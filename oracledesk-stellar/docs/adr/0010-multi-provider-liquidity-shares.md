# ADR 0010: Multi-provider liquidity shares and exit semantics

Status: Proposed — covers #2 (share model) and #3 (fee/remainder claims).

## Context

Today each market has a single LP (`Market.creator`). `claim_lp_fees` and
`claim_pool_remainder(s)` pay the whole balance to that address, and
`transfer_lp` moves the role wholesale. Adding providers needs an explicit
ownership model before storage or payouts change.

## Decision

### Shares
- New storage `DataKey::LpShares(market_id, provider) -> i128` and
  `DataKey::LpTotalShares(market_id) -> i128`.
- First deposit mints `shares = collateral`. Later deposits mint
  `shares = collateral * total_shares / pool_value` (rounded **down**).
- Deposits allowed only while the market is open (before `close_time`).
- Removal before finality is **not** allowed; providers exit only after
  `resolve`/`void_market` via claims (avoids LP front-running resolution).

### Fee accounting (per-share accumulator)
- `fee_per_share += lp_fee * SCALE / total_shares` on every trade
  (`SCALE = 1e12`), rounded down.
- Per provider: `fee_debt = shares * fee_per_share / SCALE` recorded on
  deposit; `claimable = shares * fee_per_share / SCALE - fee_debt`.
- `claim_lp_fees(market_id, provider)`: `provider.require_auth()`, pays
  `claimable`, sets `fee_debt` to current entitlement. Zero claimable → `Ok(0)`,
  no transfer. Repeat claims are idempotent.

### Remainder
- After finality, `remainder_share = remainder * shares / total_shares`
  (rounded down). Provider's shares are zeroed on claim → no duplicate claim.
- The **last** claimant (shares == remaining total_shares) receives the exact
  remaining balance, so rounding dust is owned by the final claimant and the
  pool drains to zero. Zero-share callers get `Ok(0)`.

### Invariants
1. `sum(provider claims) <= fees_accrued + remainder` at all times.
2. `sum(LpShares) == LpTotalShares`.
3. Every rounding step rounds down; dust only ever goes to the final claimant.
4. A provider can never withdraw more than its pro-rata entitlement plus dust.

## Compatibility

- Legacy single-provider markets have no `LpTotalShares` entry; they are
  treated as `creator` owning 100% and keep the current `claim_lp_fees`,
  `claim_pool_remainder(s)` and `transfer_lp` behaviour unchanged.
- Existing entry-point signatures remain; multi-LP claims are additive entry
  points (`add_liquidity`, `claim_lp_fees_for`, `claim_remainder_for`), so the
  deployed interface manifest only grows.

## Verification

`cargo test -p market-core` once implemented; scenarios: three providers
entering at different times, a zero-share caller, and the final-claim dust
boundary.
