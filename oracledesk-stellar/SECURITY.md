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
   was dropped (never entered a ledger) vs. still pending. Only a confirmed
   *drop* permits a resubmit, and the resubmit must reuse the same logical
   intent (same amount, same recipient) with a fresh nonce/idempotency key.
3. **For x402 payments,** reconcile the payment reference against the
   on-chain record and the trace hash. A trace is only served when the hash
   matches the on-chain record; if it does not match, treat it as a failed
   verification (SEV1) and do not serve it.
4. **For treasury withdrawals,** reconcile the queued withdrawal against the
   vault's recorded state. Never manually credit a withdrawal that the vault
   does not show as satisfied.
5. Record the decision (confirmed / dropped / mismatched), the evidence, and
   the resulting action in the ticket. If any step is ambiguous, escalate
   rather than guess.

### 5. State restore and service resumption

- Restore from the last known-good snapshot/config, not from an ad-hoc edit.
  Record the snapshot identifier in the ticket.
- Re-run the focused package tests/build for the affected service before
  resuming (see the package's own test command); a service does not resume on
  a red build.
- Resume in this order: verifier/x402 first (confirm a known-good trace
  verifies), then agents (confirm spend caps and role bindings are correct),
  then unpause the treasury last.
- After resumption, watch the service for at least one full reconciliation
  window and confirm no new anomalies before closing the incident.
- Write a short post-incident note: timeline, root cause, what was contained,
  keys rotated, and any follow-up issues filed.

### Manual operator verification

Some steps above are inherently manual (key rotation, on-chain pause/unpause,
reconciliation against the explorer). For these, verify on **localnet or with
deterministic fixtures** before doing them on testnet, and record the
verification in the ticket. Automated coverage for the code paths these steps
rely on (verification, spend caps, pause behavior) lives in the focused
package tests; the runbook itself is verified by a dry run on localnet.
