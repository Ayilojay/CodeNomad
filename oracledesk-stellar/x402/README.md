# x402

HTTP transport and payment layer for OracleDesk agents.

## HTTP transport hardening

The x402 HTTP server applies the following transport defaults. All values are
operator-visible and configurable via environment variables; the defaults are
safe for production and require no configuration to be secure.

### Request body limits

| Setting | Env var | Default |
| --- | --- | --- |
| Maximum request body size | `X402_MAX_BODY_BYTES` | `1048576` (1 MiB) |

Requests whose declared `Content-Length` exceeds the limit, or whose streamed
body grows past the limit, are rejected with `413 Payload Too Large` **before**
any payment processing or contract verification runs. No payment is attempted
and no success-shaped response is returned for an oversized request.

### Server timeouts

| Setting | Env var | Default |
| --- | --- | --- |
| Request (whole-request) timeout | `X402_REQUEST_TIMEOUT_MS` | `30000` |
| Header read timeout | `X402_HEADERS_TIMEOUT_MS` | `10000` |
| Idle keep-alive timeout | `X402_IDLE_TIMEOUT_MS` | `65000` |

Timeouts are enforced by the underlying HTTP server. A request that exceeds the
request or header timeout is terminated with `408 Request Timeout`; idle
connections are closed after the idle timeout.

### Trusted-proxy policy

Forwarded headers (`X-Forwarded-For`, `X-Forwarded-Proto`, `X-Real-IP`) are
**ignored by default**. The client IP is taken from the socket peer address
unless the operator explicitly opts in.

| Setting | Env var | Default |
| --- | --- | --- |
| Trusted proxy CIDRs / addresses | `X402_TRUSTED_PROXIES` | _(empty — none trusted)_ |

`X402_TRUSTED_PROXIES` is a comma-separated list of IP addresses or CIDR
ranges. Only when the immediate peer address matches an entry is the
left-most untrusted `X-Forwarded-For` hop used as the client IP. This prevents
spoofed forwarded headers from influencing rate limiting, logging, or payment
attribution.

### Secure response headers

Every response includes the following headers:

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: no-referrer`
- `Strict-Transport-Security: max-age=31536000; includeSubDomains` (only when
  the request is served over TLS / a trusted `X-Forwarded-Proto: https`)

### Method handling

Unsupported HTTP methods are rejected with `405 Method Not Allowed` (and an
`Allow` header) **before** payment processing. Only the methods documented for
each endpoint are accepted.

## Compatibility

- No changes to the payment wire format, contract verification, or on-chain
  guarantees. Payment integrity and contract verification are preserved.
- Existing clients that send bodies under the default limit and do not rely on
  forwarded headers require no changes.
- Operators behind a reverse proxy must set `X402_TRUSTED_PROXIES` to the proxy
  address(es) to preserve correct client-IP attribution.

## Validation

Run the focused transport tests for the x402 package:

```sh
npm test --workspace oracledesk-stellar/x402
```

Tests cover: oversized body rejection (413) before payment, timeout behavior,
forwarded-header handling with and without trusted proxies, secure headers on
success and error responses, and unsupported-method rejection (405).

External prerequisite: none for the transport tests (deterministic fixtures).
For end-to-end payment checks, a localnet node is required.
