# CodeNomad Frontend

User-facing web app for CodeNomad. This document covers the market data loading
flow, wallet connection, network verification, and the manual verification steps
required before shipping to testnet or mainnet.

## Live market data (#101)

The market list is loaded from the indexer/read API on page load, on network
switch, and on explicit refresh. No fixture or hardcoded market rows are ever
shown as live chain state.

### API contract

`GET /markets?network=<network>` must return:

```json
{
  "markets": [
    {
      "id": "mkt-001",
      "title": "Will Q2 GDP exceed 2%?",
      "yesPrice": 0.61,
      "change": 3.1,
      "closeTime": "2025-07-01T00:00:00Z",
      "index": 1
    }
  ],
  "meta": {
    "ledgerSequence": 55000001,
    "indexedAt": "2025-05-01T12:00:00Z"
  }
}
```

Any other shape is treated as an error. The `meta` field is optional but
strongly recommended; its absence is tolerated and silently omitted from the
freshness display.

### Display states

The market list surfaces four distinct states and never conflates them:

| State | Trigger | Behavior |
|-------|---------|----------|
| **loading** | Fetch in flight | Spinner/message; market list cleared |
| **loaded** | 200 response, fresh metadata | Rows rendered; count shown |
| **empty** | 200 response, zero markets | "No markets indexed on this network yet." |
| **stale** | `meta.indexedAt` older than 5 minutes | Rows rendered with a stale warning and retry affordance |
| **error** | Network failure, non-200, or malformed body | Error message; retry affordance; zero rows rendered |

A stale response still renders the last-known rows so the operator can see
what was indexed, but the warning makes the age and re-fetch option explicit.
An error state renders zero rows — there is no silent fallback to any fixture
or cached data.

### Ledger freshness metadata

When the API returns `meta.ledgerSequence` and `meta.indexedAt`, the UI shows:

- The ledger sequence number.
- The time the data was indexed (formatted for the browser locale).
- A "Fresh" or "Stale" badge (stale threshold: 5 minutes).

### Retry

The Refresh button in the section header triggers both an API health check and
a full market reload. The retry affordance on the stale/error status bar
triggers only the market reload.

### No fixture data

No hardcoded market rows exist in the HTML or JavaScript. The state machine
function `processMarketsResponse` and the row builder `buildMarketRowTitle`
are covered by focused automated tests that assert zero rows are returned from
any error state.

## Automated tests

The market loading state machine has focused tests covering:

- Successful load: correct row count, state, and message.
- Singular/plural message.
- Empty list: `empty` state surfaced.
- Stale data: `stale` state with age in minutes; rows still present.
- Network failure: `error` state; zero rows.
- Non-200 HTTP statuses: `error` state; HTTP code in message.
- Malformed response body: `error` state; zero rows.
- Stale threshold boundary: exact boundary is not stale; 1 ms past is stale.
- No fixture fallback: all error/empty states return zero rows.
- Ledger freshness metadata: present on success; absent is tolerated.

Run the frontend tests:

```bash
node --test frontend/markets.test.mjs
# or via npm:
cd frontend && npm test
```

The frontend test job (`Frontend (markets test)`) in CI runs the above command
against Node 22 on every push and pull request. No network access is required
— tests use deterministic in-process fixtures.

## Operator verification (localnet / testnet)

Before deploying to testnet, verify the following against a running localnet
or deterministic fixture server:

1. Start a local API server that serves `/markets?network=local` with a valid
   response body (shape above).
2. Load the frontend at `http://localhost:4173` and confirm:
   - Market rows appear from the API response, not hardcoded values.
   - Switching to "Local" in the network selector triggers a reload.
   - Clicking Refresh triggers a reload.
   - Stopping the API and refreshing shows the error state with the retry
     button, not any fixture rows.
   - Returning an empty `markets` array shows the empty state message.
   - Setting `meta.indexedAt` to 10 minutes ago shows the stale warning with
     the age in minutes.
3. Set `localStorage.oracledeskApiUrl` to point at a different API instance
   if testing against a non-default host.

Do not deploy to testnet until all localnet checks above pass.



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
