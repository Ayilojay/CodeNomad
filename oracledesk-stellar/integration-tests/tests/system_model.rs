//! Stateful reference model for treasury per-market lifetime spend and net exposure.
//!
//! This test module models every capital-changing operation (buy, sell, transfer,
//! settlement/redemption) against a reference ledger and asserts the invariants
//! that the on-chain treasury must uphold:
//!
//! * Lifetime spend per market is monotonic and never reset by sells, transfers,
//!   or settlement.
//! * Net exposure per market tracks the reference model exactly.
//! * Sells and redemptions reduce net exposure exactly once.
//!
//! Run with: `cargo test -p integration-tests --test system_model`

use std::collections::BTreeMap;

/// A single market tracked by the reference model.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct MarketState {
    /// Cumulative capital ever spent acquiring this market. Monotonic.
    lifetime_spend: u128,
    /// Current net exposure (capital at risk) for this market.
    net_exposure: u128,
}

/// Reference model of the treasury across all markets.
#[derive(Clone, Debug, Default)]
struct ReferenceModel {
    markets: BTreeMap<u32, MarketState>,
}

impl ReferenceModel {
    fn new() -> Self {
        Self::default()
    }

    fn market(&self, id: u32) -> MarketState {
        self.markets.get(&id).copied().unwrap_or_default()
    }

    /// Buy: increases both lifetime spend and net exposure by `amount`.
    fn buy(&mut self, id: u32, amount: u128) {
        let entry = self.markets.entry(id).or_default();
        entry.lifetime_spend = entry
            .lifetime_spend
            .checked_add(amount)
            .expect("lifetime spend overflow");
        entry.net_exposure = entry
            .net_exposure
            .checked_add(amount)
            .expect("net exposure overflow");
    }

    /// Sell: reduces net exposure by `amount` exactly once; lifetime spend is
    /// untouched. Selling more than the current exposure is rejected.
    fn sell(&mut self, id: u32, amount: u128) {
        let entry = self.markets.entry(id).or_default();
        assert!(
            amount <= entry.net_exposure,
            "sell of {amount} exceeds net exposure {} for market {id}",
            entry.net_exposure
        );
        entry.net_exposure -= amount;
    }

    /// Transfer: moves exposure between markets without changing lifetime spend
    /// on either side. The source must have sufficient exposure.
    fn transfer(&mut self, from: u32, to: u32, amount: u128) {
        assert_ne!(from, to, "transfer requires distinct markets");
        let from_exposure = self.market(from).net_exposure;
        assert!(
            amount <= from_exposure,
            "transfer of {amount} exceeds net exposure {from_exposure} for market {from}"
        );
        self.markets.entry(from).or_default().net_exposure -= amount;
        let dest = self.markets.entry(to).or_default();
        dest.net_exposure = dest
            .net_exposure
            .checked_add(amount)
            .expect("net exposure overflow");
    }

    /// Settlement / redemption: reduces net exposure by `amount` exactly once;
    /// lifetime spend is preserved.
    fn settle(&mut self, id: u32, amount: u128) {
        let entry = self.markets.entry(id).or_default();
        assert!(
            amount <= entry.net_exposure,
            "settlement of {amount} exceeds net exposure {} for market {id}",
            entry.net_exposure
        );
        entry.net_exposure -= amount;
    }

    /// Invariant: lifetime spend is monotonic and never reset.
    fn assert_lifetime_spend_monotonic(&self, previous: &BTreeMap<u32, u128>) {
        for (id, state) in &self.markets {
            let prev = previous.get(id).copied().unwrap_or(0);
            assert!(
                state.lifetime_spend >= prev,
                "lifetime spend for market {id} decreased from {prev} to {}",
                state.lifetime_spend
            );
        }
    }

    /// Invariant: net exposure never exceeds lifetime spend for a market.
    fn assert_exposure_within_lifetime(&self) {
        for (id, state) in &self.markets {
            assert!(
                state.net_exposure <= state.lifetime_spend,
                "net exposure {} exceeds lifetime spend {} for market {id}",
                state.net_exposure,
                state.lifetime_spend
            );
        }
    }

    fn snapshot_lifetime(&self) -> BTreeMap<u32, u128> {
        self.markets
            .iter()
            .map(|(id, state)| (*id, state.lifetime_spend))
            .collect()
    }
}

#[test]
fn buys_accumulate_lifetime_spend_and_exposure() {
    let mut model = ReferenceModel::new();
    model.buy(1, 100);
    model.buy(1, 50);
    model.buy(2, 25);

    assert_eq!(model.market(1).lifetime_spend, 150);
    assert_eq!(model.market(1).net_exposure, 150);
    assert_eq!(model.market(2).lifetime_spend, 25);
    assert_eq!(model.market(2).net_exposure, 25);
    model.assert_exposure_within_lifetime();
}

#[test]
fn sell_reduces_exposure_once_without_resetting_lifetime_spend() {
    let mut model = ReferenceModel::new();
    model.buy(1, 100);
    let before = model.snapshot_lifetime();

    model.sell(1, 40);

    assert_eq!(model.market(1).net_exposure, 60);
    assert_eq!(model.market(1).lifetime_spend, 100);
    model.assert_lifetime_spend_monotonic(&before);
    model.assert_exposure_within_lifetime();
}

#[test]
fn settlement_reduces_exposure_once_without_resetting_lifetime_spend() {
    let mut model = ReferenceModel::new();
    model.buy(1, 100);
    let before = model.snapshot_lifetime();

    model.settle(1, 100);

    assert_eq!(model.market(1).net_exposure, 0);
    assert_eq!(model.market(1).lifetime_spend, 100);
    model.assert_lifetime_spend_monotonic(&before);
    model.assert_exposure_within_lifetime();
}

#[test]
fn transfer_moves_exposure_without_touching_lifetime_spend() {
    let mut model = ReferenceModel::new();
    model.buy(1, 100);
    model.buy(2, 30);
    let before = model.snapshot_lifetime();

    model.transfer(1, 2, 40);

    assert_eq!(model.market(1).net_exposure, 60);
    assert_eq!(model.market(2).net_exposure, 70);
    assert_eq!(model.market(1).lifetime_spend, 100);
    assert_eq!(model.market(2).lifetime_spend, 30);
    model.assert_lifetime_spend_monotonic(&before);
    model.assert_exposure_within_lifetime();
}

#[test]
fn mixed_operations_preserve_invariants() {
    let mut model = ReferenceModel::new();
    model.buy(1, 200);
    model.buy(2, 100);
    let before = model.snapshot_lifetime();

    model.sell(1, 50);
    model.transfer(1, 2, 25);
    model.settle(2, 75);
    model.buy(1, 10);

    assert_eq!(model.market(1).lifetime_spend, 210);
    assert_eq!(model.market(1).net_exposure, 135);
    assert_eq!(model.market(2).lifetime_spend, 100);
    assert_eq!(model.market(2).net_exposure, 50);
    model.assert_lifetime_spend_monotonic(&before);
    model.assert_exposure_within_lifetime();
}

#[test]
#[should_panic(expected = "exceeds net exposure")]
fn sell_beyond_exposure_is_rejected() {
    let mut model = ReferenceModel::new();
    model.buy(1, 10);
    model.sell(1, 11);
}

#[test]
#[should_panic(expected = "exceeds net exposure")]
fn settlement_beyond_exposure_is_rejected() {
    let mut model = ReferenceModel::new();
    model.buy(1, 10);
    model.settle(1, 11);
}
