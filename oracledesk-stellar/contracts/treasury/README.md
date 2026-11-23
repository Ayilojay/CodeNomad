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

## Verification

Run the treasury test suite:

```
cargo test -p treasury
```

The suite covers delay-expiry boundaries, replacement of a pending proposal,
 tightening during a pending loosening, and authorization by the configured
governance account.
