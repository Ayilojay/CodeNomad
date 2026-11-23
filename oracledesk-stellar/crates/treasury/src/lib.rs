//! Treasury NAV accounting.
//!
//! This crate provides a deterministic, conservative mark-to-market valuation
//! model for the vault NAV. It values open YES/NO positions, accrued fees and
//! liquidity-provider (LP) shares, and guarantees that rounding can never
//! overstate withdrawable assets.
//!
//! # Valuation model
//!
//! All arithmetic is integer-only (no floating point) so results are fully
//! deterministic across platforms.
//!
//! * **Open positions** are marked to market at the *conservative* side of the
//!   spread: long YES/NO positions are valued at the lower of cost and current
//!   mark, and any unrealized gain is only recognized once it is realized. This
//!   keeps NAV from overstating assets when marks are stale or manipulated.
//! * **Fees** are accrued but only counted once they are claimable; pending
//!   fees are excluded from withdrawable assets.
//! * **LP shares** are valued pro-rata against the conservative NAV, and share
//!   redemption rounds *down* so a redeemer can never withdraw more than their
//!   fair share.
//!
//! # Rounding invariant
//!
//! Every division in this module rounds down (`floor`). Because all inputs are
//! non-negative and every operation is monotonic, the computed withdrawable
//! amount is always `<=` the exact rational value. See
//! [`Nav::withdrawable_for_shares`] and the tests at the bottom of this file.

/// A single open position in a binary market.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Yes,
    No,
}

/// An open directional position.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Position {
    pub side: Side,
    /// Cost basis paid to open the position, in base units.
    pub cost_basis: u128,
    /// Current mark (mid price * size) in base units.
    pub mark_value: u128,
}

impl Position {
    /// Conservative mark-to-market value of the position.
    ///
    /// We take the minimum of cost basis and current mark so unrealized gains
    /// are never recognized. This is the safe (lower) bound on realizable
    /// value.
    pub fn conservative_value(&self) -> u128 {
        self.cost_basis.min(self.mark_value)
    }
}

/// Accrued fee buckets.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Fees {
    /// Fees that have been settled and are claimable by the protocol/LPs.
    pub claimable: u128,
    /// Fees that are still pending settlement and must not be counted.
    pub pending: u128,
}

impl Fees {
    /// Only claimable fees contribute to NAV.
    pub fn counted(&self) -> u128 {
        self.claimable
    }
}

/// A snapshot of the vault used to compute NAV.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Nav {
    /// Idle base-asset balance held by the vault.
    pub idle: u128,
    /// Open positions.
    pub positions: Vec<Position>,
    /// Accrued fees.
    pub fees: Fees,
    /// Total LP shares outstanding.
    pub total_shares: u128,
}

impl Nav {
    /// Conservative total NAV in base units.
    ///
    /// `idle + sum(conservative position values) + claimable fees`.
    /// Uses saturating addition so an overflow can never wrap into a larger
    /// (overstated) value.
    pub fn total(&self) -> u128 {
        let positions = self
            .positions
            .iter()
            .fold(0u128, |acc, p| acc.saturating_add(p.conservative_value()));
        self.idle
            .saturating_add(positions)
            .saturating_add(self.fees.counted())
    }

    /// Value of a single LP share, scaled by `1e18` for precision.
    ///
    /// Rounds down. Returns `0` when there are no shares outstanding.
    pub fn share_price(&self) -> u128 {
        if self.total_shares == 0 {
            return 0;
        }
        self.total()
            .saturating_mul(1_000_000_000_000_000_000u128)
            / self.total_shares
    }

    /// Withdrawable base assets for `shares`, rounded down.
    ///
    /// Guarantees `withdrawable_for_shares(shares) <= shares * total / total_shares`
    /// (the exact rational value), so rounding can never overstate the amount a
    /// redeemer may withdraw.
    pub fn withdrawable_for_shares(&self, shares: u128) -> u128 {
        if self.total_shares == 0 {
            return 0;
        }
        // floor(shares * total / total_shares)
        self.total()
            .saturating_mul(shares)
            / self.total_shares
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pos(cost: u128, mark: u128) -> Position {
        Position {
            side: Side::Yes,
            cost_basis: cost,
            mark_value: mark,
        }
    }

    #[test]
    fn position_uses_lower_of_cost_and_mark() {
        assert_eq!(pos(100, 150).conservative_value(), 100);
        assert_eq!(pos(150, 100).conservative_value(), 100);
        assert_eq!(pos(100, 100).conservative_value(), 100);
    }

    #[test]
    fn pending_fees_are_excluded() {
        let nav = Nav {
            idle: 0,
            positions: vec![],
            fees: Fees {
                claimable: 10,
                pending: 1_000,
            },
            total_shares: 1,
        };
        assert_eq!(nav.total(), 10);
    }

    #[test]
    fn total_sums_idle_positions_and_claimable_fees() {
        let nav = Nav {
            idle: 50,
            positions: vec![pos(100, 80), pos(20, 40)],
            fees: Fees {
                claimable: 5,
                pending: 999,
            },
            total_shares: 10,
        };
        // 50 + min(100,80)=80 + min(20,40)=20 + 5 = 155
        assert_eq!(nav.total(), 155);
    }

    #[test]
    fn share_price_rounds_down() {
        let nav = Nav {
            idle: 10,
            positions: vec![],
            fees: Fees::default(),
            total_shares: 3,
        };
        // 10 * 1e18 / 3 = 3333333333333333333 (floor)
        assert_eq!(nav.share_price(), 3_333_333_333_333_333_333);
    }

    #[test]
    fn withdrawable_never_exceeds_exact_rational() {
        // Exhaustively check small values: floor rounding must never overstate.
        for total in 0u128..=50 {
            for total_shares in 1u128..=50 {
                let nav = Nav {
                    idle: total,
                    positions: vec![],
                    fees: Fees::default(),
                    total_shares,
                };
                for shares in 0u128..=total_shares {
                    let got = nav.withdrawable_for_shares(shares);
                    // exact rational: shares * total / total_shares
                    let exact_num = shares * total;
                    // got <= exact_num / total_shares  <=>  got * total_shares <= exact_num
                    assert!(
                        got.saturating_mul(total_shares) <= exact_num,
                        "overstated: total={total} shares={shares} total_shares={total_shares} got={got}"
                    );
                }
            }
        }
    }

    #[test]
    fn full_redemption_never_exceeds_nav() {
        let nav = Nav {
            idle: 100,
            positions: vec![pos(30, 10)],
            fees: Fees {
                claimable: 7,
                pending: 3,
            },
            total_shares: 9,
        };
        let total = nav.total();
        assert!(nav.withdrawable_for_shares(nav.total_shares) <= total);
    }

    #[test]
    fn zero_shares_is_safe() {
        let nav = Nav::default();
        assert_eq!(nav.share_price(), 0);
        assert_eq!(nav.withdrawable_for_shares(0), 0);
        assert_eq!(nav.withdrawable_for_shares(100), 0);
    }

    #[test]
    fn overflow_saturates_instead_of_wrapping() {
        let nav = Nav {
            idle: u128::MAX,
            positions: vec![pos(u128::MAX, u128::MAX)],
            fees: Fees {
                claimable: u128::MAX,
                pending: 0,
            },
            total_shares: 1,
        };
        // Must not wrap to a small value; saturates at MAX.
        assert_eq!(nav.total(), u128::MAX);
    }
}
