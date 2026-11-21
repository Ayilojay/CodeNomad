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
| `GET`  | `/health` | Liveness/readiness probe. Returns `200` with `{ status, version }`. |
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

## Configuration

| Variable | Required | Description |
| -------- | -------- | ----------- |
| `STELLAR_NETWORK` | yes | `testnet` or `localnet`. |
| `SOROBAN_RPC_URL` | yes | Soroban RPC endpoint used for payment verification. |
| `X402_PAY_TO` | yes | Stellar account receiving payments. |
| `X402_ASSET` | yes | Asset identifier (`CODE:ISSUER`). |
| `X402_CONTRACT` | yes | Soroban contract address used for verification. |

## Validation

CI validates the OpenAPI contract and runs client smoke tests against
deterministic fixtures:

```sh
# Lint/validate the OpenAPI contract
npx @redocly/cli lint docs/openapi.yaml

# Client smoke tests exercising the documented contract
npm test -- --testPathPattern=openapi
```

Smoke tests use deterministic fixtures and require no network access. To
exercise the contract against a live node, run against localnet with
`STELLAR_NETWORK=localnet` and a running `SOROBAN_RPC_URL`; this is an external
prerequisite and is not required for CI.

## Compatibility

The API is versioned via the `x402Version` field in challenges. Additive schema
changes (new optional fields) are non-breaking; removing or renaming fields is a
breaking change and requires a version bump.
