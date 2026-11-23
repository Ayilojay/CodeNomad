# OracleDesk Stellar

OracleDesk Stellar is the agent and payment layer for the OracleDesk network. It
provides the x402 payment flow, agent signing utilities, metrics, and the
payer-facing error taxonomy used to communicate payment outcomes to clients.

## x402 payer-facing payment error taxonomy

Payers receive a stable, versioned, machine-readable error envelope. The
envelope is versioned via `X402_ERROR_TAXONOMY_VERSION` so clients can pin to a
known contract and detect breaking changes.

### Envelope shape

```jsonc
{
  "taxonomyVersion": "1.0.0",
  "code": "INVALID_PAYMENT",
  "retryable": false,
  "recovery": "Fix the payment payload and resubmit.",
  "message": "The payment could not be validated."
}
```

### Error codes

| Code | Meaning | Retryable | Recovery guidance |
| --- | --- | --- | --- |
| `INVALID_PAYMENT` | Payment payload failed validation (bad signature, malformed fields, wrong amount/asset). | No | Fix the payment payload and resubmit. |
| `DEPENDENCY_UNAVAILABLE` | A required upstream dependency (RPC, verifier, settlement service) is temporarily unavailable. | Yes | Retry with backoff; the request was not settled. |
| `MISSING_TRACE` | The payment references a trace that cannot be found. | No | Supply a valid trace reference or start a new payment. |
| `UNCERTAIN_SETTLEMENT` | Settlement outcome could not be confirmed. | Yes (with caution) | Do **not** assume success. Re-query settlement status before retrying to avoid double-spend. |

### Guarantees

- **No success-shaped fallback.** `UNCERTAIN_SETTLEMENT` is never reported as a
  success. Payers must treat it as unresolved until settlement is confirmed.
- **Redaction.** Payer-facing output never includes stack traces, internal
  identifiers, secrets, or raw upstream payloads. Only the stable fields above
  are exposed.
- **Payment integrity.** Contract verification and payment integrity checks are
  preserved; the taxonomy only describes outcomes, it does not bypass checks.

### Configuration

No additional configuration is required. The taxonomy version is a compile-time
constant; bump it when adding or changing codes or retryability semantics.

### Validation

Run the focused tests for the changed package:

```sh
cd oracledesk-stellar && go test ./agents/core/...
```

Exercise the flow on localnet or with deterministic fixtures. No external
prerequisites beyond a local Go toolchain are required for the unit tests.

## Timelock-admin deployment mode

By default the deployment tooling makes the deployer EOA the admin of each
contract. To hand administration to a timelock, opt in explicitly with the
timelock-admin deployment mode. When selected, the deployer EOA is **not** left
as admin; instead each contract's admin is proposed to the timelock and the
handover is completed through the timelock's accept-admin flow.

### Operator-visible behavior

- **Opt-in only.** Timelock-admin mode is enabled by an explicit flag/config
  value. Without it, the existing deployer-EOA-admin behavior is unchanged.
- **Deterministic and restartable.** Re-running the deployment is idempotent:
  already-proposed and already-accepted handovers are detected and skipped, so
  an interrupted run can be resumed without duplicating proposals.
- **Admin verification.** After deployment, each contract's accepted admin is
  read back and compared against the timelock address. A mismatch fails the run
  with a clear, per-contract error rather than silently succeeding.
- **Machine-readable manifest.** The run emits a manifest recording, per
  contract, the proposed admin, the proposal status, and whether the handover
  was completed. The manifest is the source of truth for verifying the handover.

### Validation

Run the deployment and wiring tests against the local Stellar network:

```sh
cd oracledesk-stellar && go test ./deploy/...
```

Re-run the deployment command to confirm the flow is idempotent and that the
manifest reports completed handovers on the second pass.

## Multisig admin rotation runbook

This runbook covers rotating the admin of each contract and the timelock to a
multisig or smart-account address using the two-step transfer (propose, then
accept). It is written for operators and assumes least privilege: the proposer
only needs the current admin key, and the accepter only needs the new admin key.
No single signer should hold both roles.

### Roles and least privilege

| Role | Holds | Can do |
| --- | --- | --- |
| Current admin | Existing admin key (or timelock) | Propose a new admin, cancel a pending transfer. |
| New admin | Multisig / smart-account address | Accept the pending transfer. |
| Observer | Read-only RPC access | Monitor pending transfers and verify state. |

Keep the current-admin key and the new-admin signer set in separate custody.
The proposer must never be able to accept, and the accepter must never be able
to propose.

### Signer verification (before proposing)

Confirm the destination is the intended multisig or smart account and that its
signer set is correct **before** proposing, because a wrong destination can only
be recovered by the current admin cancelling the pending transfer.

1. Resolve the destination address and confirm it is a multisig or smart
   account, not a single EOA.
2. Verify the signer set and threshold meet policy (e.g. 2-of-3) and that every
   signer key is accounted for and under expected custody.
3. Record the destination address, signer set, and threshold in the change
   ticket so the acceptance step can be checked against it.

### Rotation procedure (per contract and the timelock)

Repeat for each contract and for the timelock itself. Do the timelock last so
that contract handovers can still be cancelled if something goes wrong.

1. **Propose.** From the current admin, propose the new admin address. This
   creates a pending transfer; the current admin remains in control until it is
   accepted.
2. **Monitor.** Confirm the pending transfer is visible and points at the
   expected destination (see monitoring below). Do not proceed until verified.
3. **Accept.** From the new admin (multisig / smart account), accept the pending
   transfer. For a multisig this requires reaching the configured threshold.
4. **Verify.** Read back the contract's admin and confirm it equals the new
   address. A mismatch means the transfer did not complete; investigate before
   continuing.

### Pending-transfer monitoring

- Poll each contract's pending-admin state after proposing and record the
  observed destination and proposal status in the change ticket.
- Alert if a pending transfer exists that no open change ticket references, or
  if a pending transfer's destination differs from the recorded signer set.
- Treat an unexpected pending transfer as an incident: cancel it from the
  current admin and re-verify signer custody before retrying.

### Expiry and recovery

- **Expiry.** A pending transfer that is not accepted within its expiry window
  lapses; the current admin remains in control. If acceptance is delayed past
  expiry, re-propose from the current admin and accept promptly.
- **Safe cancellation.** If the destination is wrong or signer verification
  fails, cancel the pending transfer from the current admin. Cancellation only
  clears the pending transfer; it never changes the active admin, so it is safe
  to perform at any point before acceptance.
- **Recovery after a bad acceptance.** If the wrong address was accepted, the
  new admin must propose and accept a transfer back to the intended address
  using the same two-step flow. Keep the current-admin key available until the
  read-back verification in step 4 succeeds.

### Validation

Validate the procedure against localnet before touching production:

```sh
cd oracledesk-stellar && go test ./deploy/...
```

On localnet, run propose, monitor, accept, and verify for one contract, then
repeat with an intentional expiry and an intentional cancellation to confirm
recovery paths behave as documented. Record the observed pending-admin state and
final admin read-back in the change ticket.
