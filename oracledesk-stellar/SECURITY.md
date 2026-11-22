# Security Policy

## Status: testnet-only, unaudited

Everything in this repository is deployed to Stellar **testnet only**. The
contracts have **not** been professionally audited. Do not deploy them to
mainnet, and do not send anything of real value to any address or contract
in this repo. See `docs/STATUS.md` for the current list of what has and has
not been verified.

## Reporting a vulnerability

Please report security issues privately, using
[GitHub Security Advisories](../../security/advisories/new) for this
repository, rather than opening a public issue. This applies to:

- A way to drain, lock, or misdirect funds held by any of the four
  contracts (`market-core`, `resolver`, `treasury`, `reasoning-registry`).
- An authorization bypass (a privileged function callable by the wrong
  party — see `contracts/*/src/lib.rs`'s wrong-caller tests for what's
  already covered).
- A way to make the resolution-commitment scheme (ADR 0001) or the treasury
  cross-contract auth flow (ADR 0002) behave differently from documented.
- A vulnerability in the x402 payment/verification flow that would let a
  trace be served without payment, or without its hash matching the
  on-chain record.

<!-- TODO(maintainer): confirm an expected response/triage timeline before
publishing this repo — do not commit to one without checking. -->

## Scope

In scope: `contracts/`, `x402/`, `agents/`, `packages/bindings/` (the
generation script and its templates, not third-party generated code
itself), and the deployment scripts in `scripts/`.

Out of scope: the separate frontend repository, and any third-party
dependency's own vulnerabilities (report those upstream — `npm audit` /
`cargo audit` findings in a dependency are not this repo's issues unless
this repo's usage of them is what's exploitable).

## Emergency-action matrix

Pause controls, treasury migration and timelocked configuration have
different delay guarantees and admin blast radii. The matrix below is the
approved authority model; any change to it is a governance change and must
land with matching tests.

| Action | Authority | Delay | Blast radius | Can move assets? | Can bypass spend caps? |
| --- | --- | --- | --- | --- | --- |
| `treasury.pause` | treasury admin | instant | halts agent spending + queued withdrawals | no | no (only blocks) |
| `treasury.unpause` | treasury admin | instant, logged | resumes spending/withdrawals | no | no |
| `treasury.set_successor` | treasury admin | instant | designates migration target | no | no |
| `treasury.migrate_market` | treasury admin | instant | moves positions to successor | positions only, never depositor balances | no |
| Raise caps / widen agents / loosen price policy / switch market-core or collateral | treasury admin | `config_delay` (≥ 1 day) after public `*Proposed` event | expands what agents may spend | no | no (caps still enforced) |
| Tighten caps / narrow agents / tighten price policy | treasury admin | instant | reduces agent authority | no | no |
| `resolver.cancel_proposal` | guardian | active dispute window only | cancels a proposal | no | n/a |
| `resolver.guardian_void_market` | guardian | grace after `close_time` (`REVEAL_GRACE_SECS` 3d, `ORACLE_GRACE_SECS` 1d, `SIGNER_GRACE_SECS` 7d) | voids a market | no | n/a |

Invariants enforced by the matrix (and asserted in tests):

- Emergency pause is **containment only**. `pause` cannot transfer assets,
  mint/burn shares, or raise any spend cap; it can only halt spending and
  queued withdrawals.
- No emergency action bypasses the per-agent sub-budgets, price limits, or
  the `config_delay` timelock on loosening configuration.
- `migrate_market` moves positions to the successor; it never moves
  depositor balances, and only a share's owner can burn it.
- Every guardian action emits a `GuardianAction` event with a typed
  `GuardianReason` and timestamp; a market allows at most
  `MAX_CANCELS_PER_MARKET` (2) guardian cancellations.

## Treasury admin and the vault

The treasury is a share vault (`docs/adr/0005-treasury-vault.md`): deposits
mint shares and only a share's owner can burn it. There is no admin
`withdraw`. Configuration that would let the *agents* spend more (raised
caps, new or widened agents, a looser price policy, a market-core or
collateral switch) waits `config_delay` (at least one day) after a public
`*Proposed` event, while tightening applies at once. What this does **not**
protect against: the admin can still pause the treasury instantly, and can
`set_successor` + `migrate_market` to move positions to another address, so
a compromised admin key remains a custody risk for open positions. A
governance timelock over all admin roles is separate work.

In scope for reports: anything that lets a depositor withdraw more than
their pro-rata share of NAV (share inflation, rounding, NAV manipulation
through trades against a pool), lets an agent spend capital reserved for
queued withdrawals, or bypasses the role checks, sub-budgets, price limits
or timelock.

## Guardian trust model

The resolver contract defines guardian powers as emergency interventions rather
than day-to-day administrative authority. To avoid single-party rug pulls or
arbitrary cancellations:

- **Time-restricted actions**: `cancel_proposal` is restricted to active dispute
  windows only. `guardian_void_market` enforces strict grace periods after
  `close_time` (`REVEAL_GRACE_SECS` = 3 days, `ORACLE_GRACE_SECS` = 1 day,
  `SIGNER_GRACE_SECS` = 7 days) before a guardian void can be executed.
- **Cancellation limits**: A market allows a maximum of 2 guardian cancellations
  (`MAX_CANCELS_PER_MARKET`) to prevent indefinite griefing.
- **Mandatory reason codes and public audit trail**: Every guardian action emits
  a `GuardianAction` event recording a typed `GuardianReason` and timestamp.

## Incident and recovery runbook (agent and payment services)

This runbook covers the off-chain `agents/` and `x402/` services. It is
written for testnet operations; the same steps apply on any future network
but the blast radius and the people to notify differ. Every step below is
meant to be executed by an on-call operator and recorded in the incident
ticket. **Never** present sample or cached data as live, and **never** bypass
signature/chain verification or silently fall back after an error — if a
check cannot be completed, stop and escalate.

### 0. Detect and declare

- Trigger sources: failed health checks, x402 verification errors, agent
  spend-cap rejections, treasury pause events, or a report via the private
  advisory channel above.
- Open an incident ticket immediately and record: UTC start time, the
  affected service(s), the observed symptom, and the first evidence pointer
  (log line, tx hash, dashboard link).
- Decide severity: **SEV1** = funds at risk or payment verification
  compromised; **SEV2** = service degraded but funds safe; **SEV3** =
  cosmetic/observability only. SEV1 pages the maintainer on call.

### 1. Containment

Goal: stop the bleeding without destroying evidence.

- **Preserve evidence first.** Before restarting or redeploying anything,
  snapshot logs, the current config, and any in-flight request/response
  bodies to the incident ticket. Do not `rm` logs, rotate them away, or
  truncate the DB.
- **Agent services:** stop the agent process (or scale replicas to zero) so
  it cannot submit further transactions. Do not edit its config in place
  while it is running.
- **Payment services (x402):** stop serving paid traces. If the verifier is
  suspect, take the endpoint offline rather than serving unverified content.
- **On-chain containment:** if a key is suspected compromised, use the
  treasury `pause` (instant, admin-only) to halt agent spending and queued
  withdrawals. Pausing is a containment action, not a fix — record the tx
  hash of the pause in the ticket.
- Do **not** attempt to "fix forward" by disabling a verification check.

### 2. Key rotation

Rotate any key that could have been exposed. Rotate in this order so the
new key is live before the old one is retired:

1. Generate the replacement key offline; never paste it into a ticket, chat,
   or commit. Store it in the same secret store the service already reads
   from.
2. For agent/operator keys: update the role binding on-chain (the treasury
   and resolver role checks are the source of truth), confirm the new key is
   authorized, then revoke the old key.
3. For the treasury admin key: `set_successor` to the new admin, confirm the
   successor is active, then retire the old key. Remember the admin can
   pause instantly and migrate positions — treat a leaked admin key as a
   custody incident (SEV1).
4. For x402 payment/signing keys: deploy the new key to the verifier, confirm
   a known-good trace verifies end-to-end, then remove the old key.
5. Record every rotation (which key, old/new public identifier, tx hashes,
   UTC time) in the ticket. Never record the secret itself.

### 3. Pausing

- **Treasury:** `pause` halts agent spending and queued withdrawals
  immediately. Use it for any suspected key compromise or anomalous spend.
  Unpausing is a deliberate, logged decision — confirm the root cause is
  understood and the offending key is rotated before resuming.
- **Agents:** stopping the process is the pause. Confirm no transactions are
  in flight (check the mempool/explorer for the agent address) before
  declaring the agent paused.
- **x402:** taking the endpoint offline is the pause. Confirm no paid traces
  are being served from cache or a fallback path.
- Pausing must never silently fall back to serving stale data; a paused
  service returns an explicit error, not sample content.

### 4. Uncertain transaction / payment reconciliation

When a transaction or payment's final state is unknown (timeout, dropped
connection, ambiguous explorer result), **do not resubmit blindly**. Resolve
it with these decision points:

1. **Look up the tx hash on-chain.** If it is confirmed, record the ledger
   and treat it as done — do not resubmit.
2. **If not found after the expected confirmation window,** check whether it
   was dropped (never entered a ledger) or is still pending. Only resubmit a
   dropped transaction, and only after confirming the original cannot land.
3. **For x402 payments,** re-verify the trace hash against the on-chain
   record before serving; if the hash does not match, treat it as a
   verification failure (SEV1) and do not serve the trace.
4. Record the resolution (confirmed / dropped / resubmitted, with tx hashes
   and UTC time) in the ticket.

### 5. Unpause requirements

Unpausing is a deliberate, logged decision, not a routine toggle. Before
calling `treasury.unpause`, the operator must confirm and record in the
incident ticket:

1. The root cause is understood (or the suspected key is rotated and the
   rotation is confirmed on-chain).
2. The offending key is rotated and the old key is revoked.
3. No anomalous spend or queued withdrawal is still pending; the ledger is
   reconciled per step 4.
4. A second operator (or the maintainer on call for SEV1) has reviewed the
   decision.

Unpause does not restore any authority that was tightened during the
incident; re-widening caps or agents still waits `config_delay` after a
public `*Proposed` event. Record the unpause tx hash and UTC time in the
ticket.
