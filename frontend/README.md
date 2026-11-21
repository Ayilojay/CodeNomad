# CodeNomad Frontend

User-facing web app for CodeNomad. This document covers the wallet connection
flow, network verification, and the manual verification steps required before
shipping to testnet or mainnet.

## Wallet connection

The frontend connects to a supported Stellar wallet via
[Stellar Wallets Kit](https://github.com/Creit-Tech/Stellar-Wallets-Kit)
(which wraps Freighter, xBull, Albedo, and other supported wallets).

On connect the app:

1. Requests the selected public key from the wallet.
2. Reads the wallet's active network (`PUBLIC`, `TESTNET`, `FUTURENET`, or
   `LOCAL`).
3. Compares the wallet network against the expected network configured for the
   build (`NEXT_PUBLIC_STELLAR_NETWORK`, default `TESTNET`).

### Displayed state

When a wallet is connected and the network matches, the UI shows:

- The connected **public key** (truncated, with the full key available on
  hover/copy).
- The **detected network** reported by the wallet.

No sample or placeholder key is ever rendered as if it were live. If no wallet
is connected, the UI shows the disconnected state.

### Network mismatch

If the wallet's network does not match the expected network, the connection is
**rejected**:

- The app surfaces a clear error (e.g. "Wallet is on PUBLIC but this app expects
  TESTNET. Switch networks in your wallet and reconnect.").
- The wallet is **not** treated as connected; no public key is shown as active.
- There is **no silent fallback** to the wallet's network or to a default key.

### Disconnect and errors

Disconnecting (or any connection error) resets UI state so that no wallet is
shown as connected. Errors are surfaced to the user rather than swallowed.

## Automated tests

The wallet flow has focused tests covering:

- Successful connect: public key and network are surfaced.
- Network mismatch: connection is rejected with a clear error and no connected
  state.
- Disconnect: state is reset and no wallet is shown as connected.
- Wallet/API error: error is surfaced and state is not left in a connected
  state.

Run the frontend package tests and build in CI:

```bash
npm test
npm run build
```

Open <http://localhost:4173>. The optional x402 status indicator checks
`http://localhost:3000/health`; set `localStorage.oracledeskApiUrl` in the
browser to point it at another API URL.

## Paid trace viewer

The trace viewer only renders trace content after the x402 payment has
completed **and** the returned content has passed hash/signature
verification. It never shows sample or mock data as if it were live, and it
never bypasses signature or chain verification.

The viewer surfaces four distinct states, which are never conflated:

- **Payment required** — the x402 flow has not completed; no trace content
  is shown until payment succeeds.
- **Invalid / unverified content** — the trace was returned but failed
  hash/signature verification; the content is withheld.
- **Unavailable trace** — the trace could not be fetched at all.
- **Retry status** — a retry is in progress or has failed; the previous
  error is shown explicitly rather than silently falling back.

### Trace provenance and signature verification

For a verified trace the viewer displays the provenance details alongside
the content:

- **Registry** — the registry the trace was resolved from.
- **Agent** — the agent identity that produced the trace.
- **Key identity** — the signing key identity used for verification.
- **Hash** — the content hash that was checked against the returned bytes.
- **Schema version** — the trace schema version.
- **Verification result** — shown explicitly as **verified** or **failed**;
  a failed result withholds the content and never falls back silently.

A verified signature only attests that the trace content matches the
recorded provenance and hash. It does **not** imply the strategy is
economically sound; the viewer never presents verification as a guarantee of
performance or profitability.

### Offline-verifiable evidence export

The viewer can export the provenance and verification details (registry,
agent, key identity, hash, schema version, and verification result) as an
evidence bundle. The export is self-contained so it can be re-checked offline
against the recorded hash and signature without contacting the API.

### Verification

Focused automated tests cover the success path and each failure state
(payment required, invalid content, unavailable trace, retry), plus the
provenance display and evidence export. Run them with the package test
command before release. For deployment-specific behavior, verify against
localnet or deterministic fixtures before any testnet use.
