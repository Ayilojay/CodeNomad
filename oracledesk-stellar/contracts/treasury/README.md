# Treasury Contract

The treasury contract holds protocol funds and lets a configured governance account
adjust its configuration. Configuration changes are **queued**: they are proposed,
optionally cancelled, and later executed once their delay has elapsed. Tightening
and loosening changes use different timing rules.

## Configuration surface

| Setting | Description |
| --- | --- |
| Caps | Per-asset and/or aggregate spend limits |
| Policy | Spending policy parameters (e.g. thresholds, allowlists) |
| Pause | Whether treasury operations are paused |
| Agent permissions | Which agents may act and what they may do |

## Queued transition table

Every configuration change moves through the same lifecycle. The table below
summarizes the states and the allowed transitions for each setting.

| Setting | Propose | Cancel | Execute |
| --- | --- | --- | --- |
| Caps | Governance queues a new cap; a pending proposal is replaced | Governance cancels the pending proposal | After the delay elapses, governance executes the queued cap |
| Policy | Governance queues new policy parameters; a pending proposal is replaced | Governance cancels the pending proposal | After the delay elapses, governance executes the queued policy |
| Pause | Governance queues a pause/unpause; a pending proposal is replaced | Governance cancels the pending proposal | After the delay elapses, governance executes the queued pause state |
| Agent permissions | Governance queues a permission change; a pending proposal is replaced | Governance cancels the pending proposal | After the delay elapses, governance executes the queued permissions |

### States

- **Proposed** — a change has been queued and is waiting for its delay to elapse.
  Proposing again replaces the pending proposal (see *Replacement* below).
- **Cancelled** — governance cancelled the pending proposal before execution. The
  configuration is unchanged and no delay remains active.
- **Executed** — the delay elapsed and governance executed the proposal. The new
  configuration is now active.

## Timing rules: tightening vs loosening

- **Tightening** (reducing caps, restricting policy, pausing, removing agent
  permissions) takes effect under the standard queued delay.
- **Loosening** (raising caps, relaxing policy, unpausing, granting agent
  permissions) uses the same queued lifecycle but must not be able to bypass a
  pending tightening: a tightening proposed while a loosening is pending is
  applied according to the tightening rule, and the pending loosening remains
  subject to its own delay.

Operators should treat every configuration change as pending until it is
**executed**; only executed changes are reflected in on-chain behavior.

## Operator-visible behavior

- Proposals are only accepted from the configured governance account; any other
  caller is rejected.
- A proposal cannot be executed before its delay has elapsed; execution at the
  delay boundary is allowed.
- Proposing a new change while one is pending replaces the pending proposal and
  restarts its delay.
- Cancelling a pending proposal leaves the active configuration untouched.
- Tightening during a pending loosening is honored per the timing rules above;
  the loosening does not take effect early.

## Open-exposure inventory

The treasury exposes a paginated, cursor-based view for enumerating all open
positions. The view is indexed and bounded: it never iterates the full market
set in a single call, so operators can enumerate exposures in constant-size
pages regardless of how many markets exist.

### Cursor semantics

- A read returns a page of entries plus a cursor for the next page.
- Pass the returned cursor back to fetch the following page. An empty/absent
  cursor starts from the beginning of the inventory.
- The cursor is opaque; operators must not construct or parse it. It encodes
  the position of the last returned entry under the stable ordering below.
- When a page is the last one, no next cursor is returned; stop paging at that
  point.
- Cursors are only valid against the inventory state they were issued for. If
  entries are added or removed between pages, a cursor may skip or repeat
  entries; re-enumerate from the start if a consistent snapshot is required.

### Stable ordering

Entries are returned in a deterministic, stable order (by market identifier)
so that repeated enumerations of an unchanged inventory yield the same
sequence. This ordering is what makes cursor-based paging safe: a cursor always
resumes immediately after the last entry of the previous page.

### Page-size limits

- Each request specifies a page size, which is clamped to an explicit maximum.
  Requests above the maximum are served at the maximum rather than rejected.
- A page size of zero is treated as the minimum page size.
- The maximum page size is a fixed contract constant; it is not configurable
  through the queued configuration surface and does not change the timing
  rules above.

### Market states

The inventory only reports positions that are currently open. Markets in other
states are handled as follows:

- **Migrated** — positions carried over from a migrated market are reported
  under the market's current identifier; the pre-migration identifier does not
  appear as a separate entry.
- **Settled** — a settled market has no open exposure and is omitted from the
  inventory. Its entries disappear once settlement is recorded.
- **Archived** — archived markets are excluded from the inventory. Archiving a
  market removes its entries from subsequent pages.

Because these transitions can occur between pages, operators should treat a
paged enumeration as eventually consistent and re-enumerate after state
changes when an exact snapshot is required.

### Interface guarantees

This view is read-only and additive. It does not alter the queued
configuration lifecycle, the tightening/loosening timing rules, or any
existing authorization guarantee. No migration is required.

## Verification

Run the treasury test suite:

```
cargo test -p treasury
```

The suite covers delay-expiry boundaries, replacement of a pending proposal,
tightening during a pending loosening, and authorization by the configured
governance account. It also covers the open-exposure inventory: cursor
round-trips, stable ordering across pages, page-size clamping, and the
migrated/settled/archived market cases described above.
