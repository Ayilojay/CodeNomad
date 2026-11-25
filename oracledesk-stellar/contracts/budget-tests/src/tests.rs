use crate::{
    baseline_path, compile_time_rustc, load_baseline, market_core_wasm, measure, registry_wasm,
    resolver_wasm, router_wasm, stellar_cli_version, treasury_wasm, wasm_bytes, write_baseline,
    Baseline, Meta, Metrics, Tolerance,
};
use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::{Address as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Address, BytesN, Env, String,
};

const UNIT: i128 = 10_000_000; // 1 USDC
const MIN_SEED: i128 = 100 * UNIT;
const BASE_TS: u64 = 1_000_000;
type Scenario = (&'static str, fn() -> Metrics);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

#[allow(dead_code)]
struct McFixture {
    env: Env,
    client: market_core_wasm::Client<'static>,
    token: TokenClient<'static>,
    admin: Address,
    creator: Address,
    trader: Address,
}

fn mc_fixture() -> McFixture {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().disable_resource_limits();
    env.ledger().set_timestamp(BASE_TS);
    env.ledger().set_sequence_number(1);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let resolver = Address::generate(&env);
    let creator = Address::generate(&env);
    let trader = Address::generate(&env);

    let collateral = env.register_stellar_asset_contract_v2(admin.clone());
    let token = collateral.address();
    let sac = StellarAssetClient::new(&env, &token);
    sac.mint(&creator, &(10_000 * UNIT));
    sac.mint(&trader, &(10_000 * UNIT));

    let contract_id = env.register(
        market_core_wasm::WASM,
        (
            admin.clone(),
            token.clone(),
            treasury,
            resolver,
            100u32,
            10_000u32,
        ),
    );
    let client = market_core_wasm::Client::new(&env, &contract_id);
    let token_client = TokenClient::new(&env, &token);
    McFixture {
        env,
        client,
        token: token_client,
        admin,
        creator,
        trader,
    }
}

fn create_market_with_uri(fx: &McFixture, uri: &str) -> u64 {
    let s = String::from_str(&fx.env, uri);
    fx.client.create_market(
        &fx.creator,
        &BytesN::from_array(&fx.env, &[1u8; 32]),
        &BytesN::from_array(&fx.env, &[2u8; 32]),
        &s,
        &market_core_wasm::Category::Crypto,
        &(BASE_TS + 60_000),
        &MIN_SEED,
        &5_000u32,
    )
}

fn create_market(fx: &McFixture) -> u64 {
    create_market_with_uri(fx, "ipfs://budget")
}

fn buy(fx: &McFixture, market_id: u64, amount: i128) -> i128 {
    fx.client.buy(
        &fx.trader,
        &market_id,
        &market_core_wasm::Outcome::Yes,
        &amount,
        &0i128,
    )
}

// ---------------------------------------------------------------------------
// market-core scenarios
// ---------------------------------------------------------------------------

fn mc_create_market_min_uri() -> Metrics {
    let fx = mc_fixture();
    let env = fx.env.clone();
    let uri = String::from_str(&env, "ipfs://b");
    measure(&env, || {
        fx.client.create_market(
            &fx.creator,
            &BytesN::from_array(&env, &[1u8; 32]),
            &BytesN::from_array(&env, &[2u8; 32]),
            &uri,
            &market_core_wasm::Category::Crypto,
            &(BASE_TS + 60_000),
            &MIN_SEED,
            &5_000u32,
        )
    })
}

fn mc_create_market_uri_1k() -> Metrics {
    let fx = mc_fixture();
    let env = fx.env.clone();
    let uri = String::from_str(&env, &"u".repeat(1_024));
    measure(&env, || {
        fx.client.create_market(
            &fx.creator,
            &BytesN::from_array(&env, &[1u8; 32]),
            &BytesN::from_array(&env, &[2u8; 32]),
            &uri,
            &market_core_wasm::Category::Crypto,
            &(BASE_TS + 60_000),
            &MIN_SEED,
            &5_000u32,
        )
    })
}

fn mc_buy_first_position() -> Metrics {
    let fx = mc_fixture();
    let market_id = create_market(&fx);
    let env = fx.env.clone();
    measure(&env, || buy(&fx, market_id, 10 * UNIT))
}

fn mc_buy_existing_position() -> Metrics {
    let fx = mc_fixture();
    let market_id = create_market(&fx);
    buy(&fx, market_id, 10 * UNIT);
    let env = fx.env.clone();
    measure(&env, || buy(&fx, market_id, 10 * UNIT))
}

fn mc_sell_partial() -> Metrics {
    let fx = mc_fixture();
    let market_id = create_market(&fx);
    buy(&fx, market_id, 10 * UNIT);
    let env = fx.env.clone();
    measure(&env, || {
        fx.client.sell(
            &fx.trader,
            &market_id,
            &market_core_wasm::Outcome::Yes,
            &(2 * UNIT),
            &i128::MAX,
        )
    })
}

fn mc_sell_full_position_removal() -> Metrics {
    let fx = mc_fixture();
    let market_id = create_market(&fx);
    // Sell everything the trader just bought: pick the largest collateral
    // payout whose required shares fit inside the position, so the position
    // entry is removed (exact when granularity allows).
    let shares = buy(&fx, market_id, UNIT);
    let m = fx.client.get_market(&market_id);
    let start = market_core::math::collateral_out_for_shares(
        m.reserve_yes,
        m.reserve_no,
        shares,
        m.fee_bps,
    )
    .unwrap();
    let mut lo = 0i128;
    let mut hi = start.saturating_mul(3);
    let mut best = 0i128;
    while lo <= hi {
        let mid = lo + (hi - lo) / 2;
        match market_core::math::calc_sell(m.reserve_yes, m.reserve_no, mid, m.fee_bps) {
            Ok(q) if q.shares_in <= shares => {
                best = mid;
                lo = mid + 1;
            }
            _ => {
                if mid == 0 {
                    break;
                }
                hi = mid - 1;
            }
        }
    }
    let collateral_out = best.max(1);
    let env = fx.env.clone();
    measure(&env, || {
        fx.client.sell(
            &fx.trader,
            &market_id,
            &market_core_wasm::Outcome::Yes,
            &collateral_out,
            &i128::MAX,
        )
    })
}

fn mc_redeem_void() -> Metrics {
    let fx = mc_fixture();
    let market_id = create_market(&fx);
    buy(&fx, market_id, 10 * UNIT);
    fx.env.ledger().set_timestamp(BASE_TS + 70_000);
    fx.client.void_market(&market_id);
    let env = fx.env.clone();
    measure(&env, || fx.client.redeem(&fx.trader, &market_id))
}

fn mc_claim_pool_remainder() -> Metrics {
    let fx = mc_fixture();
    let market_id = create_market(&fx);
    buy(&fx, market_id, 10 * UNIT);
    fx.env.ledger().set_timestamp(BASE_TS + 70_000);
    fx.client.void_market(&market_id);
    let env = fx.env.clone();
    measure(&env, || fx.client.claim_pool_remainder(&market_id))
}

fn mc_sweep_fees() -> Metrics {
    let fx = mc_fixture();
    let market_id = create_market(&fx);
    buy(&fx, market_id, 100 * UNIT);
    let env = fx.env.clone();
    measure(&env, || fx.client.sweep_fees(&market_id))
}

fn mc_get_market() -> Metrics {
    let fx = mc_fixture();
    let market_id = create_market(&fx);
    let env = fx.env.clone();
    measure(&env, || fx.client.get_market(&market_id))
}

fn mc_quote_buy() -> Metrics {
    let fx = mc_fixture();
    let market_id = create_market(&fx);
    let env = fx.env.clone();
    measure(&env, || {
        fx.client
            .quote_buy(&market_id, &market_core_wasm::Outcome::Yes, &(10 * UNIT))
    })
}

fn mc_quote_sell() -> Metrics {
    let fx = mc_fixture();
    let market_id = create_market(&fx);
    buy(&fx, market_id, 10 * UNIT);
    let env = fx.env.clone();
    measure(&env, || {
        fx.client
            .quote_sell(&market_id, &market_core_wasm::Outcome::Yes, &(2 * UNIT))
    })
}

// ---------------------------------------------------------------------------
// market-core worst-case scenarios
//
// One scenario per public entrypoint at representative and maximum bounded
// inputs. Maximums are derived from the contract's own constants so the
// benchmarks track the deployed limits:
//   * URI length: `MAX_URI_LEN` (1 KiB)
//   * fee bps: `MAX_FEE_BPS`
//   * batch length: `MAX_SETS` for `redeem_many` / `claim_pool_remainders`
//   * trade size: the largest collateral amount the trader can fund
// ---------------------------------------------------------------------------

/// Maximum URI length accepted by `create_market`.
const MAX_URI_LEN: usize = 1_024;
/// Maximum batch length for `redeem_many` / `claim_pool_remainders`.
const MAX_SETS: usize = 20;
/// Maximum fee bps accepted by `create_market`.
const MAX_FEE_BPS: u32 = 1_000;

fn mc_create_market_max_fee() -> Metrics {
    let fx = mc_fixture();
    let env = fx.env.clone();
    let uri = String::from_str(&env, "ipfs://budget");
    measure(&env, || {
        fx.client.create_market(
            &fx.creator,
            &BytesN::from_array(&env, &[1u8; 32]),
            &BytesN::from_array(&env, &[2u8; 32]),
            &uri,
            &market_core_wasm::Category::Crypto,
            &(BASE_TS + 60_000),
            &MIN_SEED,
            &MAX_FEE_BPS,
        )
    })
}

fn mc_create_market_max_uri_max_fee() -> Metrics {
    let fx = mc_fixture();
    let env = fx.env.clone();
    let uri = String::from_str(&env, &"u".repeat(MAX_URI_LEN));
    measure(&env, || {
        fx.client.create_market(
            &fx.creator,
            &BytesN::from_array(&env, &[1u8; 32]),
            &BytesN::from_array(&env, &[2u8; 32]),
            &uri,
            &market_core_wasm::Category::Crypto,
            &(BASE_TS + 60_000),
            &MIN_SEED,
            &MAX_FEE_BPS,
        )
    })
}

/// Largest single buy the trader can fund (10_000 USDC minted).
fn mc_buy_max_amount() -> Metrics {
    let fx = mc_fixture();
    let market_id = create_market(&fx);
    let env = fx.env.clone();
    measure(&env, || buy(&fx, market_id, 10_000 * UNIT))
}

/// Largest single sell against a fully-funded position.
fn mc_sell_max_amount() -> Metrics {
    let fx = mc_fixture();
    let market_id = create_market(&fx);
    buy(&fx, market_id, 10_000 * UNIT);
    let env = fx.env.clone();
    measure(&env, || {
        fx.client.sell(
            &fx.trader,
            &market_id,
            &market_core_wasm::Outcome::Yes,
            &(10_000 * UNIT),
            &i128::MAX,
        )
    })
}

fn mc_resolve() -> Metrics {
    let fx = mc_fixture();
    let market_id = create_market(&fx);
    buy(&fx, market_id, 10 * UNIT);
    fx.env.ledger().set_timestamp(BASE_TS + 70_000);
    let env = fx.env.clone();
    measure(&env, || {
        fx.client
            .resolve(&market_id, &market_core_wasm::Outcome::Yes)
    })
}

fn mc_void_market() -> Metrics {
    let fx = mc_fixture();
    let market_id = create_market(&fx);
    fx.env.ledger().set_timestamp(BASE_TS + 70_000);
    let env = fx.env.clone();
    measure(&env, || fx.client.void_market(&market_id))
}

/// `redeem_many` at the maximum batch length (`MAX_SETS` markets).
fn mc_redeem_many_max_batch() -> Metrics {
    let fx = mc_fixture();
    let mut ids = Vec::new();
    for _ in 0..MAX_SETS {
        let id = create_market(&fx);
        buy(&fx, id, UNIT);
        ids.push(id);
    }
    for id in &ids {
        fx.env.ledger().set_timestamp(BASE_TS + 70_000);
        fx.client.void_market(id);
    }
    let env = fx.env.clone();
    let batch = soroban_sdk::Vec::from_slice(&env, &ids);
    measure(&env, || fx.client.redeem_many(&fx.trader, &batch))
}

/// `claim_pool_remainders` at the maximum batch length (`MAX_SETS` markets).
fn mc_claim_pool_remainders_max_batch() -> Metrics {
    let fx = mc_fixture();
    let mut ids = Vec::new();
    for _ in 0..MAX_SETS {
        let id = create_market(&fx);
        buy(&fx, id, UNIT);
        ids.push(id);
    }
    for id in &ids {
        fx.env.ledger().set_timestamp(BASE_TS + 70_000);
        fx.client.void_market(id);
    }
    let env = fx.env.clone();
    let batch = soroban_sdk::Vec::from_slice(&env, &ids);
    measure(&env, || fx.client.claim_pool_remainders(&batch))
}

fn mc_propose_resolver() -> Metrics {
    let fx = mc_fixture();
    let market_id = create_market(&fx);
    let new_resolver = Address::generate(&fx.env);
    let env = fx.env.clone();
    measure(&env, || fx.client.propose_resolver(&market_id, &new_resolver))
}

fn mc_accept_resolver() -> Metrics {
    let fx = mc_fixture();
    let market_id = create_market(&fx);
    let new_resolver = Address::generate(&fx.env);
    fx.client.propose_resolver(&market_id, &new_resolver);
    let env = fx.env.clone();
    measure(&env, || fx.client.accept_resolver(&market_id))
}

fn mc_set_paused() -> Metrics {
    let fx = mc_fixture();
    let env = fx.env.clone();
    measure(&env, || fx.client.set_paused(&true))
}

fn mc_set_fee_bps() -> Metrics {
    let fx = mc_fixture();
    let env = fx.env.clone();
    measure(&env, || fx.client.set_fee_bps(&MAX_FEE_BPS))
}

fn mc_set_treasury() -> Metrics {
    let fx = mc_fixture();
    let new_treasury = Address::generate(&fx.env);
    let env = fx.env.clone();
    measure(&env, || fx.client.set_treasury(&new_treasury))
}

fn mc_set_resolver() -> Metrics {
    let fx = mc_fixture();
    let new_resolver = Address::generate(&fx.env);
    let env = fx.env.clone();
    measure(&env, || fx.client.set_resolver(&new_resolver))
}

fn mc_set_breaker_threshold() -> Metrics {
    let fx = mc_fixture();
    let env = fx.env.clone();
    measure(&env, || fx.client.set_breaker_threshold(&1_000u32))
}

fn mc_set_breaker_window() -> Metrics {
    let fx = mc_fixture();
    let env = fx.env.clone();
    measure(&env, || fx.client.set_breaker_window(&86_400u64))
}

fn mc_get_config() -> Metrics {
    let fx = mc_fixture();
    let env = fx.env.clone();
    measure(&env, || fx.client.get_config())
}

fn mc_get_position() -> Metrics {
    let fx = mc_fixture();
    let market_id = create_market(&fx);
    buy(&fx, market_id, 10 * UNIT);
    let env = fx.env.clone();
    measure(&env, || {
        fx.client
            .get_position(&market_id, &fx.trader, &market_core_wasm::Outcome::Yes)
    })
}

fn mc_get_twap_observation() -> Metrics {
    let fx = mc_fixture();
    let market_id = create_market(&fx);
    buy(&fx, market_id, 10 * UNIT);
    let env = fx.env.clone();
    measure(&env, || fx.client.get_twap_observation(&market_id))
}

fn mc_get_twap_observations() -> Metrics {
    let fx = mc_fixture();
    let market_id = create_market(&fx);
    buy(&fx, market_id, 10 * UNIT);
    let env = fx.env.clone();
    measure(&env, || fx.client.get_twap_observations(&market_id))
}

// ---------------------------------------------------------------------------
// reasoning-registry scenarios
// ---------------------------------------------------------------------------

struct RegistryFixture {
    env: Env,
    client: registry_wasm::Client<'static>,
    agent: Address,
}

fn registry_fixture() -> RegistryFixture {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().disable_resource_limits();
    env.ledger().set_timestamp(BASE_TS);
    env.ledger().set_sequence_number(1);
    let admin = Address::generate(&env);
    let agent = Address::generate(&env);
    let contract_id = env.register(registry_wasm::WASM, (admin,));
    let client = registry_wasm::Client::new(&env, &contract_id);
    client.register_agent(&agent);
    RegistryFixture { env, client, agent }
}

fn registry_publish(fx: &RegistryFixture, action: &str, cid: &str) -> Metrics {
    let action = String::from_str(&fx.env, action);
    let cid = String::from_str(&fx.env, cid);
    let env = fx.env.clone();
    measure(&env, || {
        fx.client.publish_trace(
            &fx.agent,
            &1u64,
            &action,
            &BytesN::from_array(&env, &[9u8; 32]),
            &cid,
        )
    })
}

fn reg_publish_small() -> Metrics {
    let fx = registry_fixture();
    registry_publish(&fx, "buy yes", "ipfs://small")
}

fn reg_publish_cid_1k() -> Metrics {
    let fx = registry_fixture();
    registry_publish(&fx, "buy yes", &"c".repeat(1_024))
}

fn reg_publish_action_1k() -> Metrics {
    let fx = registry_fixture();
    registry_publish(&fx, &"a".repeat(1_024), "ipfs://cid")
}

fn reg_get_trace() -> Metrics {
    let fx = registry_fixture();
    let trace_id = fx.client.publish_trace(
        &fx.agent,
        &1u64,
        &String::from_str(&fx.env, "buy yes"),
        &BytesN::from_array(&fx.env, &[9u8; 32]),
        &String::from_str(&fx.env, "ipfs://small"),
    );
    let env = fx.env.clone();
    measure(&env, || fx.client.get_trace(&trace_id))
}

// ---------------------------------------------------------------------------
// End-to-end cross-contract scenarios (treasury, resolver, router)
// ---------------------------------------------------------------------------

/// Shared wiring for the end-to-end paths: a market-core instance plus the
/// treasury, resolver and router contracts, all deployed from the shipped WASM.
struct E2eFixture {
    env: Env,
    core: market_core_wasm::Client<'static>,
    treasury: treasury_wasm::Client<'static>,
    resolver: resolver_wasm::Client<'static>,
    router: router_wasm::Client<'static>,
    token: TokenClient<'static>,
    admin: Address,
    agent: Address,
    trader: Address,
}

fn e2e_fixture() -> E2eFixture {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().disable_resource_limits();
    env.ledger().set_timestamp(BASE_TS);
    env.ledger().set_sequence_number(1);

    let admin = Address::generate(&env);
    let agent = Address::generate(&env);
    let trader = Address::generate(&env);

    let collateral = env.register_stellar_asset_contract_v2(admin.clone());
    let token = collateral.address();
    let sac = StellarAssetClient::new(&env, &token);
    sac.mint(&agent, &(10_000 * UNIT));
    sac.mint(&trader, &(10_000 * UNIT));

    let core_id = env.register(
        market_core_wasm::WASM,
        (
            admin.clone(),
            token.clone(),
            Address::generate(&env),
            Address::generate(&env),
            100u32,
            10_000u32,
        ),
    );
    let core = market_core_wasm::Client::new(&env, &core_id);

    let treasury_id = env.register(treasury_wasm::WASM, (admin.clone(), token.clone()));
    let treasury = treasury_wasm::Client::new(&env, &treasury_id);

    let resolver_id = env.register(
        resolver_wasm::WASM,
        (admin.clone(), core_id.clone(), registry_id(&env, &admin)),
    );
    let resolver = resolver_wasm::Client::new(&env, &resolver_id);

    let router_id = env.register(
        router_wasm::WASM,
        (
            admin.clone(),
            core_id.clone(),
            treasury_id.clone(),
            resolver_id.clone(),
        ),
    );
    let router = router_wasm::Client::new(&env, &router_id);

    E2eFixture {
        env,
        core,
        treasury,
        resolver,
        router,
        token: TokenClient::new(&env, &token),
        admin,
        agent,
        trader,
    }
}

fn registry_id(env: &Env, admin: &Address) -> Address {
    env.register(registry_wasm::WASM, (admin.clone(),))
}

fn e2e_create_market(fx: &E2eFixture, uri: &str) -> u64 {
    fx.core.create_market(
        &fx.agent,
        &BytesN::from_array(&fx.env, &[1u8; 32]),
        &BytesN::from_array(&fx.env, &[2u8; 32]),
        &String::from_str(&fx.env, uri),
        &market_core_wasm::Category::Crypto,
        &(BASE_TS + 60_000),
        &MIN_SEED,
        &5_000u32,
    )
}

/// Representative path: agent creates a market through the resolver, which
/// forwards to market-core and publishes a trace to the registry.
fn e2e_agent_create_market_and_reveal() -> Metrics {
    let fx = e2e_fixture();
    let env = fx.env.clone();
    let uri = String::from_str(&env, "ipfs://e2e");
    measure(&env, || {
        fx.resolver.agent_create_market(
            &fx.agent,
            &BytesN::from_array(&env, &[1u8; 32]),
            &BytesN::from_array(&env, &[2u8; 32]),
            &uri,
            &market_core_wasm::Category::Crypto,
            &(BASE_TS + 60_000),
            &MIN_SEED,
            &5_000u32,
        )
    })
}

/// Maximum-size path: resolver-mediated market creation with a 1 KiB URI.
fn e2e_agent_create_market_max_uri() -> Metrics {
    let fx = e2e_fixture();
    let env = fx.env.clone();
    let uri = String::from_str(&env, &"u".repeat(1_024));
    measure(&env, || {
        fx.resolver.agent_create_market(
            &fx.agent,
            &BytesN::from_array(&env, &[1u8; 32]),
            &BytesN::from_array(&env, &[2u8; 32]),
            &uri,
            &market_core_wasm::Category::Crypto,
            &(BASE_TS + 60_000),
            &MIN_SEED,
            &5_000u32,
        )
    })
}

/// Representative path: treasury-mediated buy with nested token auth.
fn e2e_treasury_agent_buy() -> Metrics {
    let fx = e2e_fixture();
    let market_id = e2e_create_market(&fx, "ipfs://e2e");
    let env = fx.env.clone();
    measure(&env, || {
        fx.treasury.agent_buy(
            &fx.agent,
            &market_id,
            &market_core_wasm::Outcome::Yes,
            &(10 * UNIT),
            &0i128,
        )
    })
}

/// Representative path: treasury-mediated sell with nested token auth.
fn e2e_treasury_agent_sell() -> Metrics {
    let fx = e2e_fixture();
    let market_id = e2e_create_market(&fx, "ipfs://e2e");
    fx.treasury.agent_buy(
        &fx.agent,
        &market_id,
        &market_core_wasm::Outcome::Yes,
        &(10 * UNIT),
        &0i128,
    );
    let env = fx.env.clone();
    measure(&env, || {
        fx.treasury.agent_sell(
            &fx.agent,
            &market_id,
            &market_core_wasm::Outcome::Yes,
            &(2 * UNIT),
            &i128::MAX,
        )
    })
}

/// Representative path: router dispatch to a buy through treasury.
fn e2e_router_dispatch_buy() -> Metrics {
    let fx = e2e_fixture();
    let market_id = e2e_create_market(&fx, "ipfs://e2e");
    let env = fx.env.clone();
    measure(&env, || {
        fx.router.dispatch_buy(
            &fx.agent,
            &market_id,
            &market_core_wasm::Outcome::Yes,
            &(10 * UNIT),
            &0i128,
        )
    })
}

/// Representative path: router dispatch to a sell through treasury.
fn e2e_router_dispatch_sell() -> Metrics {
    let fx = e2e_fixture();
    let market_id = e2e_create_market(&fx, "ipfs://e2e");
    fx.router.dispatch_buy(
        &fx.agent,
        &market_id,
        &market_core_wasm::Outcome::Yes,
        &(10 * UNIT),
        &0i128,
    );
    let env = fx.env.clone();
    measure(&env, || {
        fx.router.dispatch_sell(
            &fx.agent,
            &market_id,
            &market_core_wasm::Outcome::Yes,
            &(2 * UNIT),
            &i128::MAX,
        )
    })
}

// ---------------------------------------------------------------------------
// Registry of scenarios
// ---------------------------------------------------------------------------

fn scenarios() -> Vec<Scenario> {
    vec![
        (
            "market_core.create_market.min_uri",
            mc_create_market_min_uri,
        ),
        ("market_core.create_market.uri_1k", mc_create_market_uri_1k),
        ("market_core.buy.first_position", mc_buy_first_position),
        (
            "market_core.buy.existing_position",
            mc_buy_existing_position,
        ),
        ("market_core.sell.partial", mc_sell_partial),
        (
            "market_core.sell.full_position_removal",
            mc_sell_full_position_removal,
        ),
        ("market_core.redeem.void", mc_redeem_void),
        ("market_core.claim_pool_remainder", mc_claim_pool_remainder),
        ("market_core.sweep_fees", mc_sweep_fees),
        ("market_core.view.get_market", mc_get_market),
        ("market_core.view.quote_buy", mc_quote_buy),
        ("market_core.view.quote_sell", mc_quote_sell),
        (
            "market_core.create_market.max_fee",
            mc_create_market_max_fee,
        ),
        (
            "market_core.create_market.max_uri_max_fee",
            mc_create_market_max_uri_max_fee,
        ),
        ("market_core.buy.max_amount", mc_buy_max_amount),
        ("market_core.sell.max_amount", mc_sell_max_amount),
        ("market_core.resolve", mc_resolve),
        ("market_core.void_market", mc_void_market),
        (
            "market_core.redeem_many.max_batch",
            mc_redeem_many_max_batch,
        ),
        (
            "market_core.claim_pool_remainders.max_batch",
            mc_claim_pool_remainders_max_batch,
        ),
        ("market_core.propose_resolver", mc_propose_resolver),
        ("market_core.accept_resolver", mc_accept_resolver),
        ("market_core.admin.set_paused", mc_set_paused),
        ("market_core.admin.set_fee_bps", mc_set_fee_bps),
        ("market_core.admin.set_treasury", mc_set_treasury),
        ("market_core.admin.set_resolver", mc_set_resolver),
        (
            "market_core.breaker.set_threshold",
            mc_set_breaker_threshold,
        ),
        ("market_core.breaker.set_window", mc_set_breaker_window),
        ("market_core.view.get_config", mc_get_config),
        ("market_core.view.get_position", mc_get_position),
        (
            "market_core.view.get_twap_observation",
            mc_get_twap_observation,
        ),
        (
            "market_core.view.get_twap_observations",
            mc_get_twap_observations,
        ),
        ("registry.publish_trace.small", reg_publish_small),
        ("registry.publish_trace.cid_1k", reg_publish_cid_1k),
        ("registry.publish_trace.action_1k", reg_publish_action_1k),
        ("registry.view.get_trace", reg_get_trace),
        (
            "e2e.resolver.agent_create_market_and_reveal",
            e2e_agent_create_market_and_reveal,
        ),
        (
            "e2e.resolver.agent_create_market.max_uri",
            e2e_agent_create_market_max_uri,
        ),
        ("e2e.treasury.agent_buy", e2e_treasury_agent_buy),
        ("e2e.treasury.agent_sell", e2e_treasury_agent_sell),
        ("e2e.router.dispatch_buy", e2e_router_dispatch_buy),
        ("e2e.router.dispatch_sell", e2e_router_dispatch_sell),
    ]
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

const METRIC_NAMES: [&str; 7] = [
    "cpu_insns",
    "mem_bytes",
    "read_entries",
    "write_entries",
    "read_bytes",
    "write_bytes",
    "events_bytes",
];

fn metric(m: &Metrics, name: &str) -> u64 {
    match name {
        "cpu_insns" => m.cpu_insns,
        "mem_bytes" => m.mem_bytes,
        "read_entries" => m.read_entries as u64,
        "write_entries" => m.write_entries as u64,
        "read_bytes" => m.read_bytes as u64,
        "write_bytes" => m.write_bytes as u64,
        "events_bytes" => m.events_bytes as u64,
        _ => unreachable!(),
    }
}

fn tolerance(t: &Tolerance, name: &str) -> f64 {
    match name {
        "cpu_insns" => t.cpu_insns,
        "mem_bytes" => t.mem_bytes,
        "read_entries" => t.read_entries,
        "write_entries" => t.write_entries,
        "read_bytes" => t.read_bytes,
        "write_bytes" => t.write_bytes,
        "events_bytes" => t.events_bytes,
        _ => unreachable!(),
    }
}

#[derive(Debug)]
struct Diff {
    scenario: &'static str,
    metric: &'static str,
    base: u64,
    actual: u64,
    change_pct: f64,
    direction: &'static str,
}

/// Regression check for the recorded resource baseline.
///
/// The baseline lives in `docs/budgets/baseline.json` (see `baseline_path`).
/// Each scenario's CPU/memory/entry/byte metrics are compared against the
/// recorded value using the per-metric `Tolerance` stored in the same file.
/// CPU and memory are skipped when the running rustc differs from the one
/// that produced the baseline, since those metrics are toolchain-sensitive.
///
/// To refresh the baseline after an intentional change:
///
/// ```text
/// make budget-update        # equivalent to BUDGET_UPDATE=1 cargo test -p budget-tests
/// ```
///
/// Review the printed diff, commit the updated `docs/budgets/baseline.json`
/// alongside the change, and include the diff in the PR description.
#[test]
fn budget_baseline() {
    let update = std::env::var("BUDGET_UPDATE").as_deref() == Ok("1");
    let mut baseline = load_baseline().unwrap_or_else(Baseline::empty);
    let running_rustc = compile_time_rustc();
    let same_toolchain = baseline.meta.rustc == running_rustc;
    if !same_toolchain {
        eprintln!(
            "warning: baseline was produced with rustc {} but this run uses {}; \
             skipping CPU/memory comparison (entry and byte metrics still checked)",
            baseline.meta.rustc, running_rustc
        );
    }

    let mut diffs = Vec::new();
    for (name, run) in scenarios() {
        let actual = run();
        match baseline.scenarios.get(name) {
            Some(base) => {
                for metric_name in METRIC_NAMES {
                    if !same_toolchain && matches!(metric_name, "cpu_insns" | "mem_bytes") {
                        continue;
                    }
                    let b = metric(base, metric_name);
                    let a = metric(&actual, metric_name);
                    let tol = tolerance(&baseline.tolerance, metric_name);
                    let within = if tol == 0.0 {
                        a == b
                    } else {
                        let allowed = (b as f64 * tol).max(1.0);
                        (a as f64 - b as f64).abs() <= allowed
                    };
                    if !within {
                        let change_pct = if b == 0 {
                            0.0
                        } else {
                            (a as f64 - b as f64) / b as f64 * 100.0
                        };
                        diffs.push(Diff {
                            scenario: name,
                            metric: metric_name,
                            base: b,
                            actual: a,
                            change_pct,
                            direction: if a > b { "regression" } else { "improvement" },
                        });
                    }
                }
            }
            None if !update => {
                panic!(
                    "scenario `{name}` is missing from {}; run `make budget-update`",
                    baseline_path().display()
                );
            }
            None => {}
        }
        baseline.scenarios.insert(name.to_string(), actual);
    }

    if update {
        baseline.meta = Meta {
            soroban_sdk: "27.0.6".into(),
            rustc: running_rustc,
            stellar_cli: stellar_cli_version(),
            wasm_bytes: wasm_bytes(),
        };
        write_baseline(&baseline);
        eprintln!(
            "budget baseline updated: {} scenarios -> {}",
            baseline.scenarios.len(),
            baseline_path().display()
        );
        return;
    }

    if !diffs.is_empty() {
        eprintln!("\nresource budget diff (baseline vs actual):");
        eprintln!(
            "{:<44} {:<14} {:>12} {:>12} {:>9}  {:<11}",
            "scenario", "metric", "baseline", "actual", "delta", "kind"
        );
        for d in &diffs {
            eprintln!(
                "{:<44} {:<14} {:>12} {:>12} {:>8.2}%  {:<11}",
                d.scenario, d.metric, d.base, d.actual, d.change_pct, d.direction
            );
        }
        eprintln!(
            "\nIf the change is intentional, refresh the baseline with `make budget-update` \
             and include the diff in the PR."
        );
        panic!(
            "{} resource budget metric(s) changed beyond tolerance",
            diffs.len()
        );
    }
    eprintln!(
        "budget: {} scenarios within tolerance ({})",
        baseline.scenarios.len(),
        baseline_path().display()
    );
}

// ---------------------------------------------------------------------------
// Network limits
// ---------------------------------------------------------------------------

/// Snapshot of Stellar Mainnet invocation limits, 2026-07-10
/// (soroban-sdk 27.0.6's `InvocationResourceLimits::mainnet`).
/// Source: https://developers.stellar.org/docs/networks/resource-limits-fees
mod network {
    pub const INSTRUCTIONS: u64 = 400_000_000;
    pub const MEM_BYTES: u64 = 41_943_040;
    pub const DISK_READ_ENTRIES: u64 = 200;
    pub const WRITE_ENTRIES: u64 = 200;
    pub const LEDGER_ENTRIES: u64 = 400;
    pub const DISK_READ_BYTES: u64 = 200_000;
    pub const WRITE_BYTES: u64 = 132_096;
    pub const EVENTS_BYTES: u64 = 16_384;
    pub const MAX_DATA_ENTRY_BYTES: u64 = 65_536;
    pub const MAX_CODE_ENTRY_BYTES: u64 = 131_072;
}

#[test]
fn worst_cases_within_network_limits() {
    let mut failures = Vec::new();
    for (name, run) in scenarios() {
        let m = run();
        let checks = [
            ("cpu_insns", m.cpu_insns, network::INSTRUCTIONS),
            ("mem_bytes", m.mem_bytes, network::MEM_BYTES),
            (
                "read_entries",
                m.read_entries as u64,
                network::DISK_READ_ENTRIES,
            ),
            (
                "write_entries",
                m.write_entries as u64,
                network::WRITE_ENTRIES,
            ),
            (
                "ledger_entries",
                (m.read_entries + m.write_entries) as u64,
                network::LEDGER_ENTRIES,
            ),
            ("read_bytes", m.read_bytes as u64, network::DISK_READ_BYTES),
            ("write_bytes", m.write_bytes as u64, network::WRITE_BYTES),
            ("events_bytes", m.events_bytes as u64, network::EVENTS_BYTES),
        ];
        for (metric, actual, limit) in checks {
            if actual > limit {
                failures.push(format!("{name}: {metric}={actual} > {limit}"));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "scenarios exceed mainnet limits:\n  {}",
        failures.join("\n  ")
    );
}

/// Reviewed per-scenario budgets for the cross-contract paths. These are
/// intentionally tighter than the network limits so that a regression in a
/// nested authorization or storage path fails CI before it can approach the
/// mainnet ceiling. Values are reviewed alongside the baseline in
/// `budget-baseline.json`.
mod reviewed {
    pub const E2E_CPU_INSTRUCTIONS: u64 = 120_000_000;
    pub const E2E_MEM_BYTES: u64 = 20_000_000;
    pub const E2E_READ_ENTRIES: u64 = 100;
    pub const E2E_WRITE_ENTRIES: u64 = 100;
    pub const E2E_READ_BYTES: u64 = 100_000;
    pub const E2E_WRITE_BYTES: u64 = 66_048;
    pub const E2E_EVENTS_BYTES: u64 = 8_192;
}

#[test]
fn cross_contract_paths_within_reviewed_budgets() {
    let mut failures = Vec::new();
    for (name, run) in scenarios() {
        if !name.starts_with("e2e.") {
            continue;
        }
        let m = run();
        let checks = [
            ("cpu_insns", m.cpu_insns, reviewed::E2E_CPU_INSTRUCTIONS),
            ("mem_bytes", m.mem_bytes, reviewed::E2E_MEM_BYTES),
            (
                "read_entries",
                m.read_entries as u64,
                reviewed::E2E_READ_ENTRIES,
            ),
            (
                "write_entries",
                m.write_entries as u64,
                reviewed::E2E_WRITE_ENTRIES,
            ),
            ("read_bytes", m.read_bytes as u64, reviewed::E2E_READ_BYTES),
            ("write_bytes", m.write_bytes as u64, reviewed::E2E_WRITE_BYTES),
            (
                "events_bytes",
                m.events_bytes as u64,
                reviewed::E2E_EVENTS_BYTES,
            ),
        ];
        for (metric, actual, limit) in checks {
            if actual > limit {
                failures.push(format!("{name}: {metric}={actual} > {limit}"));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "cross-contract paths exceed reviewed budgets:\n  {}",
        failures.join("\n  ")
    );
}
