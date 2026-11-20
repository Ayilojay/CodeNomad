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

### Verification

Focused automated tests cover the success path and each failure state
(payment required, invalid content, unavailable trace, retry). Run them with
the package test command before release. For deployment-specific behavior,
verify against localnet or deterministic fixtures before any testnet use.
