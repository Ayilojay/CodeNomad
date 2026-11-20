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

## Network selection

The frontend exposes an explicit network selector with **local**, **testnet**,
and future networks. The selected network is persisted in
`localStorage.oracledeskNetwork` and drives every downstream surface:

- **Deployment manifests.** Contract and RPC configuration is loaded from
  validated deployment manifests keyed by network. A manifest is only used
  after it passes validation; an invalid or missing manifest surfaces an error
  and does not fall back to another network's addresses.
- **Scoped caches and wallet state.** Quote caches, balances, and wallet state
  are keyed by the selected network, so switching networks never reuses values
  from a different chain.
- **Transaction guard.** Transactions are blocked when the deployment
  addresses do not match the selected network. The mismatch is shown to the
  user and no signature prompt is shown.

## Safe transaction flow

Every trade goes through the same guarded sequence before anything is
signed. The frontend never displays sample or hardcoded quotes as live
state, and it never falls back silently after an error.

1. **Quote first.** The trade form requests a quote from the generated
   bindings/SDK helpers for the selected pair and amount. The quote (price,
   expected output, and expiry) is shown to the user before any transaction
   is built. If the quote call fails, the error is surfaced and the trade
   action stays disabled.
2. **Explicit slippage and deadline.** Slippage tolerance and transaction
   deadline are required inputs with validated bounds. A trade cannot be
   submitted while either value is missing or out of range; the minimum
   acceptable output is derived from the quote and the chosen slippage.
3. **Simulate before signing.** The transaction is simulated against the
   current network state before a signature is requested. A failed
   simulation is reported to the user and no signature prompt is shown.
4. **Distinct transaction states.** The UI shows separate pending, success,
   and failure states for each transaction. Failures are shown as failures
   with their reason; they are never rendered as success or hidden.

Signature and chain verification are always enforced; the frontend does not
bypass them or substitute cached/sample values when a check fails.

## Verification

- Automated tests cover the quote, slippage/deadline validation, simulation
  failure, and pending/success/failure state transitions. Run the focused
  package test/build in CI.
- Network selection tests cover manifest validation, per-network cache/wallet
  scoping, and the transaction block on deployment/network mismatch.
- For deployment-specific behavior, verify against localnet or deterministic
  fixtures before using testnet. Manual operator check: confirm the network
  selector switches manifests and scoped state, that an invalid manifest
  surfaces an error without fallback, that a mismatched deployment blocks the
  transaction, that a quote is shown before signing, that missing/out-of-range
  slippage or deadline blocks submission, that a failed simulation shows an
  error with no signature prompt, and that pending/success/failure states each
  render distinctly.
