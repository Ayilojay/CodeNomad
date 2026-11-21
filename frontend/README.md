# CodeNomad frontend

This is the separate browser-facing half of the project. The Soroban
contracts, agents, generated bindings, and x402 service remain under
`../oracledesk-stellar/`.

## Run

```bash
npm start
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
