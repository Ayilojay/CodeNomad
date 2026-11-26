use market_core as core_contract;
use soroban_sdk::{
    xdr::{ContractId, Hash, Limits, ScAddress, WriteXdr},
    Address, Env, Event, TryFromVal,
};

#[test]
fn market_event_specs_match_v1() {
    let mut specs = Vec::new();
    macro_rules! append_specs {
        ($($event:ident),+ $(,)?) => {
            $(specs.extend_from_slice(&core_contract::$event::spec_xdr());)+
        };
    }
    append_specs!(
        MarketCreated,
        Trade,
        MarketResolved,
        Redeemed,
        FeesSwept,
        MarketFinalized,
        FeesSweptTo,
        LpFeesClaimed,
        PoolRemainderClaimed,
        TreasuryChanged,
        ResolverProposed,
        ResolverChanged,
        TreasuryProposed,
        AdminTransferProposed,
        AdminTransferred,
        AdminTransferCancelled,
        ProtocolFeeShareChanged,
        PositionTransferred,
        LpTransferred,
    );
    assert_eq!(
        specs.as_slice(),
        include_bytes!("fixtures/market-events/specs.xdr")
    );
}

#[test]
fn legacy_and_extended_fee_events_match_wire_fixtures() {
    let env = Env::default();
    let address = |byte| {
        Address::try_from_val(&env, &ScAddress::Contract(ContractId(Hash([byte; 32])))).unwrap()
    };
    let emitter = address(0);
    let legacy = core_contract::FeesSwept {
        market_id: 7,
        amount: 42,
    };
    let extended = core_contract::FeesSweptTo {
        market_id: 7,
        recipient: address(1),
        amount: 42,
    };
    for (event, golden) in [
        (
            legacy.to_xdr(&env, &emitter),
            include_bytes!("fixtures/market-events/fees-swept.xdr").as_slice(),
        ),
        (
            extended.to_xdr(&env, &emitter),
            include_bytes!("fixtures/market-events/fees-swept-to.xdr").as_slice(),
        ),
    ] {
        assert_eq!(event.to_xdr(Limits::none()).unwrap().as_slice(), golden);
    }
}
