# OracleDesk

OracleDesk is a coordination layer for autonomous agents on Stellar. It exposes an
x402-style HTTP API for paid agent coordination, backed by Soroban contracts and a
versioned event stream.

## x402 API contract

The HTTP surface is described by an OpenAPI 3.1 contract published at
[`docs/openapi.yaml`](docs/openapi.yaml). The contract is the source of truth for
routes, request/response schemas, and error shapes; clients and CI validate
against it.

### Routes

| Method | Path | Description |
| ------ | ---- | ----------- |
| `GET`  | `/health` | Liveness probe. Dependency-free; returns `200` with `{ status, version }`. |
| `GET`  | `/health/live` | Liveness probe (alias of `/health`). No external calls. |
| `GET`  | `/health/ready` | Readiness probe. Timeout-bounded dependency checks; `200` when all deps are healthy, `503` otherwise. |
| `GET`  | `/agents` | Paginated agent listing. Query params `limit` (1–100, default 20) and `cursor` (opaque). |
| `GET`  | `/agents/{agentId}` | Single agent record. |
| `POST` | `/coordination` | Submit a coordination request. Requires a valid x402 payment header. |
| `GET`  | `/coordination/{requestId}` | Fetch a coordination request and its verification result. |

### 402 payment challenge

Any paid route (`POST /coordination`) responds with `402 Payment Required` when
the `X-PAYMENT` header is missing or invalid. The body is an x402 challenge:

```json
{
  "x402Version": 1,
  "error": "payment required",
  "accepts": [
    {
      "scheme": "exact",
      "network": "stellar:testnet",
      "maxAmountRequired": "1000000",
      "resource": "/coordination",
      "description": "Agent coordination request",
      "mimeType": "application/json",
      "payTo": "G...",
      "asset": "USDC:GA...",
      "maxTimeoutSeconds": 60,
      "extra": { "contract": "C..." }
    }
  ]
}
```

A request is only accepted once the payment payload verifies on-chain. There is
no success-shaped fallback: if verification fails, the request is rejected with
`402` (payment) or `422` (verification) and no coordination state is written.

### Verification response

`GET /coordination/{requestId}` returns the stored request together with its
verification result:

```json
{
  "requestId": "...",
  "status": "verified",
  "verification": {
    "verified": true,
    "txHash": "...",
    "ledger": 123456,
    "verifiedAt": "2024-01-01T00:00:00Z"
  }
}
```

`status` is one of `pending`, `verified`, `failed`. `verification.verified` is
`false` for `failed` requests and the failure reason is included in
`verification.error`.

### Pagination

List endpoints accept `limit` and `cursor` and return:

```json
{ "items": [], "nextCursor": null }
```

`nextCursor` is `null` on the last page. Invalid `limit` (non-integer, `< 1`, or
`> 100`) yields `400` with the standard error schema.

### Error schema

All non-2xx responses share a single error shape:

```json
{ "error": { "code": "invalid_request", "message": "...", "details": {} } }
```

| Status | `code` | Meaning |
| ------ | ------ | ------- |
| `400`  | `invalid_request` | Malformed query/body (e.g. bad pagination). |
| `402`  | `payment_required` | Missing/invalid x402 payment header. |
| `404`  | `not_found` | Unknown agent or coordination request. |
| `422`  | `verification_failed` | Payment payload failed on-chain verification. |
| `500`  | `internal_error` | Unexpected server error. |
| `503`  | `not_ready` | One or more dependencies failed readiness checks. |

## Health checks

Liveness and readiness are deliberately separated so orchestrators (Kubernetes,
Nomad, etc.) can restart a wedged process without flapping on transient
dependency outages, and can gate traffic on readiness without killing the pod.

### Liveness — `GET /health` and `GET /health/live`

Dependency-free. Performs **no** network, RPC, registry, facilitator, or storage
calls. It only reports that the process is up and serving HTTP:

```json
{ "status": "ok", "version": "1.0.0" }
```

Always `200` while the process can answer. Use this for restart probes.

### Readiness — `GET /health/ready`

Runs timeout-bounded checks against each dependency and returns a structured
result. Each check is bounded by `HEALTH_CHECK_TIMEOUT_MS` (default `2000`); a
check that exceeds the timeout is reported as `timeout` rather than hanging the
probe.

```json
{
  "status": "ready",
  "version": "1.0.0",
  "checks": {
    "rpc":         { "status": "ok",      "latencyMs": 42 },
    "registry":    { "status": "ok",      "latencyMs": 11 },
    "facilitator": { "status": "ok",      "latencyMs": 27 },
    "storage":     { "status": "ok",      "latencyMs": 3 }
  }
}
```

`status` is `ready` when every dependency is `ok`, otherwise `not_ready` and the
response is `503`. Each per-dependency entry has:

| Field | Description |
| ----- | ----------- |
| `status` | `ok`, `timeout`, `unreachable`, or `error`. |
| `latencyMs` | Elapsed time for the check, in milliseconds. |
| `error` | Present only on failure; a coarse category (e.g. `timeout`, `unreachable`, `auth_failed`, `invalid_response`). |

Results are **redacted**: they never include credentials, tokens, full endpoint
URLs, hostnames, or raw upstream error bodies. Only the dependency name, status,
latency, and a coarse error category are exposed. This keeps the probe safe to
serve on an unauthenticated port.

Readiness does not affect payment integrity: a `not_ready` response never
substitutes for on-chain payment verification, and paid routes continue to
reject unverified payments with `402`/`422` regardless of readiness state.

## Configuration

| Variable | Required | Description |
| -------- | -------- | ----------- |
| `STELLAR_NETWORK` | yes | `testnet` or `localnet`. |
| `SOROBAN_RPC_URL` | yes | Soroban RPC endpoint used for payment verification. |
| `X402_PAY_TO` | yes | Stellar account receiving payments. |
| `X402_ASSET` | yes | Asset identifier (`CODE:ISSUER`). |
| `X402_CONTRACT` | yes | Soroban contract address used for verification. |
| `HEALTH_CHECK_TIMEOUT_MS` | no | Per-dependency readiness timeout in milliseconds (default `2000`). |

## Validation

CI validates the OpenAPI contract and runs client smoke tests against
deterministic fixtures:

```sh
# Lint/validate the OpenAPI contract
npx @redocly/cli lint docs/openapi.yaml

# Client smoke tests exercising the documented contract
npm test -- --testPathPattern=openapi

# Health check tests (liveness, readiness, timeouts, redaction)
npm test -- --testPathPattern=health
```

Smoke tests use deterministic fixtures and require no network access. To
exercise the contract against a live node, run against localnet with
`STELLAR_NETWORK=localnet` and a running `SOROBAN_RPC_URL`; this is an external
prerequisite and is not required for CI.

## Compatibility

The API is versioned via the `x402Version` field in challenges. Additive schema
changes (new optional fields) are non-breaking; removing or renaming fields is a
breaking change and requires a version bump. The `/health/live` and
`/health/ready` routes are additive: `/health` retains its existing
`{ status, version }` shape, so existing liveness consumers are unaffected.

## Handsoff notes

<!-- handsoff-issue-37 -->
- #37: [treasury] Validate creation policy against adversarial market metadata

<!-- handsoff-issue-48 -->
- #48: [governance] Add governance action simulation before timelock scheduling
