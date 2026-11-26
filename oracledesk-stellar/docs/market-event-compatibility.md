# Market-core event compatibility

Filter by the market-core contract ID and the first topic symbol. The
following inventory describes contract events emitted by the current
implementation. All payloads are Soroban maps with symbol keys. Topics are
ordered, starting with the event symbol followed by the listed values.

| Event symbol | Additional topics | Map fields |
| --- | --- | --- |
| `market_created` | `market_id: u64` | `creator: Address`, `category: Category`, `close_time: u64`, `seed_amount: i128`, `initial_yes_bps: u32` |
| `trade` | `market_id: u64`, `trader: Address` | `outcome: Outcome`, `is_buy: bool`, `collateral: i128`, `shares: i128`, `fee: i128`, `reserve_yes: i128`, `reserve_no: i128` |
| `market_resolved` | `market_id: u64` | `outcome: Option<Outcome>` |
| `redeemed` | `market_id: u64`, `holder: Address` | `payout: i128` |
| `fees_swept` | `market_id: u64` | `amount: i128` |
| `market_finalized` | `market_id: u64` | `swept: i128`, `unclaimed_user: i128`, `dust: i128` |
| `fees_swept_to` | `market_id: u64` | `recipient: Address`, `amount: i128` |
| `lp_fees_claimed` | `market_id: u64`, `creator: Address` | `amount: i128` |
| `pool_remainder_claimed` | `market_id: u64`, `creator: Address` | `payout: i128` |
| `treasury_changed` | — | `old: Address`, `new: Address` |
| `resolver_proposed` | — | `resolver: Address` |
| `resolver_changed` | — | `old: Address`, `new: Address` |
| `treasury_proposed` | — | `treasury: Address` |
| `admin_transfer_proposed` | — | `new_admin: Address` |
| `admin_transferred` | — | `old: Address`, `new: Address` |
| `admin_transfer_cancelled` | — | — |
| `protocol_fee_share_changed` | — | `old: u32`, `new: u32` |
| `position_transferred` | `market_id: u64`, `from: Address` | `to: Address`, `outcome: Outcome`, `amount: i128` |
| `lp_transferred` | `market_id: u64` | `from: Address`, `to: Address` |

A new event symbol is additive when existing events keep their wire shapes
and emission semantics. Clients should tolerate unknown symbols and advance
their cursor past them. Changing a symbol, topic count, topic order, field
name, field type, enum encoding or data format is breaking. Adding a field
under an existing symbol can break strict decoders. Use a distinct symbol
for a revised payload and keep emitting the established form during the
compatibility period. Removing an event or changing when it is emitted also
requires a consumer migration.

Older deployments emit `fees_swept` with the amount. Deployments that emit
`fees_swept_to` publish it alongside `fees_swept` during the same sweep. The
additional event provides the actual recipient. For accounting, prefer
`fees_swept_to` and use `fees_swept` as a fallback when the same transaction
has no matching extended event for the sweep. Pair events by emitting
contract, transaction, market ID and event order. Never credit both events.
The recipient is unknown from the legacy event alone.

Both resolve and void emit `market_resolved`. A resolved event has a
`Some(Outcome)` value and a void encodes `None`. Bulk redemption and pool
claims emit the existing per-market event shapes for processed entries.

The golden fixtures under
`contracts/integration-tests/tests/fixtures/market-events` pin the V0 spec
entries in declaration order and two full fee-sweep event envelopes. The
wire fixtures use market ID 7, amount 42, an all-zero contract ID and an
all-one-byte contract ID for the recipient. Run
`cargo test -p integration-tests --test market_event_compatibility` after
making event changes. Review fixture changes alongside the consumer
migration. This inventory and verification do not change contract behavior
or deployed interfaces.
