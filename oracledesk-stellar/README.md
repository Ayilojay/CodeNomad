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
