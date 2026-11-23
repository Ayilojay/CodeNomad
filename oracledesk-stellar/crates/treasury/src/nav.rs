//! Conservative mark-to-market NAV accounting for the treasury vault.
//!
//! The vault NAV is computed from three deterministic components:
//!
//! 1. **Cash** — settled balances held by the vault (already realized).
//! 2. **Open positions** — YES/NO outcome-token holdings valued at a
//!    conservative mark-to-market price. Long positions are marked at the
//!    *lower* of cost basis and current mark; short/liability legs are marked
//!    at the *higher* of cost basis and current mark. This guarantees the NAV
//!    never overstates the value of a directional position.
//! 3. **Fees and LP shares** — accrued-but-unclaimed fees are only counted
//!    once they are claimable, and LP shares are valued pro-rata against the
//!    conservative NAV of the pool they belong to.
//!
//! All arithmetic is performed in integer base units with explicit rounding
//! direction so that the resulting NAV is a *lower bound* on withdrawable
//! assets. Rounding always truncates in the direction that reduces NAV.

use std::collections::BTreeMap;

/// A single open outcome-token position.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Position {
    /// Whether the position is long (held) or short (owed).
    pub side: Side,
    /// Cost basis in base units (what was paid to acquire the position).
    pub cost_basis: i128,
    /// Current mark price in base units for the full position size.
    pub mark_value: i128,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Long,
    Short,
}

/// Accrued fees that may or may not yet be claimable.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fees {
    /// Fees already claimable by the vault (counted at face value).
    pub claimable: i128,
    /// Fees accrued but not yet claimable (excluded from NAV).
    pub unclaimable: i128,
}

/// A liquidity-provider share of a pool.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LpShare {
    /// Shares held by the vault.
    pub shares: u128,
    /// Total shares outstanding in the pool.
    pub total_shares: u128,
    /// Conservative NAV of the pool in base units.
    pub pool_nav: i128,
}

/// Full input to the NAV computation.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NavInputs {
    pub cash: i128,
    pub positions: Vec<Position>,
    pub fees: Fees,
    pub lp_shares: Vec<LpShare>,
}

impl Default for Fees {
    fn default() -> Self {
        Fees {
            claimable: 0,
            unclaimable: 0,
        }
    }
}

/// Conservative value of a single position.
///
/// Longs are marked at `min(cost_basis, mark_value)`; shorts are marked at
/// `max(cost_basis, mark_value)` and treated as a liability. This is the
/// mark-to-market rule that prevents directional positions from inflating NAV.
fn position_value(position: &Position) -> i128 {
    match position.side {
        Side::Long => position.cost_basis.min(position.mark_value),
        Side::Short => position.cost_basis.max(position.mark_value),
    }
}

/// Value of an LP share, truncated down so rounding cannot overstate NAV.
fn lp_value(share: &LpShare) -> i128 {
    if share.total_shares == 0 || share.pool_nav <= 0 {
        return 0;
    }
    // Integer division truncates toward zero; pool_nav is non-negative here so
    // this always rounds down, never up.
    let numerator = share.pool_nav as i128 * share.shares as i128;
    numerator / share.total_shares as i128
}

/// Compute the conservative NAV for the given inputs.
///
/// The result is guaranteed to be a lower bound on withdrawable assets:
/// every component rounds down and directional positions are marked
/// conservatively.
pub fn compute_nav(inputs: &NavInputs) -> i128 {
    let mut nav = inputs.cash;

    for position in &inputs.positions {
        let value = position_value(position);
        match position.side {
            Side::Long => nav = nav.saturating_add(value),
            Side::Short => nav = nav.saturating_sub(value),
        }
    }

    // Only claimable fees are counted; unclaimable fees are excluded entirely.
    nav = nav.saturating_add(inputs.fees.claimable.max(0));

    for share in &inputs.lp_shares {
        nav = nav.saturating_add(lp_value(share));
    }

    nav
}

/// Per-position breakdown used for operator-visible reporting.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NavBreakdown {
    pub cash: i128,
    pub positions: BTreeMap<usize, i128>,
    pub claimable_fees: i128,
    pub lp_value: i128,
    pub total: i128,
}

/// Compute NAV together with a per-position breakdown for reporting.
pub fn compute_nav_breakdown(inputs: &NavInputs) -> NavBreakdown {
    let mut positions = BTreeMap::new();
    let mut nav = inputs.cash;

    for (idx, position) in inputs.positions.iter().enumerate() {
        let value = position_value(position);
        let signed = match position.side {
            Side::Long => value,
            Side::Short => -value,
        };
        positions.insert(idx, signed);
        nav = nav.saturating_add(signed);
    }

    let claimable_fees = inputs.fees.claimable.max(0);
    nav = nav.saturating_add(claimable_fees);

    let mut lp_total = 0i128;
    for share in &inputs.lp_shares {
        lp_total = lp_total.saturating_add(lp_value(share));
    }
    nav = nav.saturating_add(lp_total);

    NavBreakdown {
        cash: inputs.cash,
        positions,
        claimable_fees,
        lp_value: lp_total,
        total: nav,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_position_marked_at_lower_of_cost_and_mark() {
        let inputs = NavInputs {
            cash: 0,
            positions: vec![Position {
                side: Side::Long,
                cost_basis: 100,
                mark_value: 80,
            }],
            ..Default::default()
        };
        assert_eq!(compute_nav(&inputs), 80);
    }

    #[test]
    fn long_position_does_not_inflate_on_mark_up() {
        let inputs = NavInputs {
            cash: 0,
            positions: vec![Position {
                side: Side::Long,
                cost_basis: 100,
                mark_value: 150,
            }],
            ..Default::default()
        };
        // Conservative: still valued at cost basis, not the higher mark.
        assert_eq!(compute_nav(&inputs), 100);
    }

    #[test]
    fn short_position_is_a_liability_at_higher_of_cost_and_mark() {
        let inputs = NavInputs {
            cash: 200,
            positions: vec![Position {
                side: Side::Short,
                cost_basis: 50,
                mark_value: 70,
            }],
            ..Default::default()
        };
        assert_eq!(compute_nav(&inputs), 130);
    }

    #[test]
    fn unclaimable_fees_are_excluded() {
        let inputs = NavInputs {
            cash: 10,
            fees: Fees {
                claimable: 5,
                unclaimable: 1000,
            },
            ..Default::default()
        };
        assert_eq!(compute_nav(&inputs), 15);
    }

    #[test]
    fn lp_share_rounds_down() {
        let inputs = NavInputs {
            cash: 0,
            lp_shares: vec![LpShare {
                shares: 1,
                total_shares: 3,
                pool_nav: 10,
            }],
            ..Default::default()
        };
        // 10 * 1 / 3 = 3.33 -> 3, never 4.
        assert_eq!(compute_nav(&inputs), 3);
    }

    #[test]
    fn lp_share_with_zero_total_is_zero() {
        let inputs = NavInputs {
            cash: 0,
            lp_shares: vec![LpShare {
                shares: 5,
                total_shares: 0,
                pool_nav: 100,
            }],
            ..Default::default()
        };
        assert_eq!(compute_nav(&inputs), 0);
    }

    #[test]
    fn rounding_never_overstates_withdrawable_assets() {
        // For a range of share/pool combinations, the computed LP value must
        // never exceed the exact rational value.
        for shares in 0u128..20 {
            for total in 1u128..20 {
                for pool_nav in 0i128..50 {
                    let share = LpShare {
                        shares,
                        total_shares: total,
                        pool_nav,
                    };
                    let value = lp_value(&share);
                    let exact = (pool_nav as i128 * shares as i128) as f64 / total as f64;
                    assert!(
                        value as f64 <= exact,
                        "lp value {value} exceeded exact {exact}"
                    );
                }
            }
        }
    }

    #[test]
    fn breakdown_matches_total() {
        let inputs = NavInputs {
            cash: 100,
            positions: vec![
                Position {
                    side: Side::Long,
                    cost_basis: 40,
                    mark_value: 30,
                },
                Position {
                    side: Side::Short,
                    cost_basis: 10,
                    mark_value: 20,
                },
            ],
            fees: Fees {
                claimable: 7,
                unclaimable: 3,
            },
            lp_shares: vec![LpShare {
                shares: 1,
                total_shares: 2,
                pool_nav: 9,
            }],
        };
        let breakdown = compute_nav_breakdown(&inputs);
        assert_eq!(breakdown.total, compute_nav(&inputs));
        assert_eq!(breakdown.total, 100 + 30 - 20 + 7 + 4);
    }
}
